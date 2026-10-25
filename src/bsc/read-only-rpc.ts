import { createServer } from "node:http";

// Anvil receives this loopback endpoint, never the upstream credential.
// Reject the entire batch before forwarding if even one method is not read-only.
const methods = new Set([
  "eth_chainId", "net_version", "eth_blockNumber", "eth_gasPrice",
  "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getBalance",
  "eth_getCode", "eth_getStorageAt", "eth_getTransactionCount",
  "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_call",
  // Optional Anvil account aggregate; standard nodes return -32601, then Anvil
  // falls back to getBalance/getCode/getTransactionCount.
  "eth_getAccountInfo"
]);
export function readOnlyBatch(value: unknown): boolean {
  const requests = Array.isArray(value) ? value : [value];
  return requests.length > 0 && requests.length <= 50 && requests.every(request =>
    request && typeof request === "object" && request.jsonrpc === "2.0" &&
    methods.has(request.method) && (request.params === undefined || Array.isArray(request.params)) &&
    (typeof request.id === "number" || typeof request.id === "string"));
}
export async function startReadOnlyRpc(upstream: string) {
  const endpoint = new URL(upstream);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash)
    throw new Error("A credential-free-authority HTTPS fork RPC is required");
  const counts = { forwardedReads: 0, deniedRequests: 0, upstreamFailures: 0, retries: 0 };
  const deniedMethods = new Set<string>();
  let lastFailure = "";
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/" || req.headers.origin) return reply(403, { error: "Loopback RPC only" });
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 128 * 1024) return reply(413, { error: "RPC body too large" });
      }
      const request: unknown = JSON.parse(body);
      if (!readOnlyBatch(request)) {
        counts.deniedRequests++;
        for (const item of Array.isArray(request) ? request : [request])
          if (item && typeof item === "object" && typeof item.method === "string" && /^[a-zA-Z_]{1,64}$/.test(item.method))
            deniedMethods.add(item.method);
        return reply(403, { error: "Only explicitly allowed read-only RPC methods may reach the upstream" });
      }
      counts.forwardedReads += Array.isArray(request) ? request.length : 1;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(endpoint, {
            method: "POST", headers: { "Content-Type": "application/json" }, body,
            signal: AbortSignal.timeout(4000), redirect: "error"
          });
          if (!response.ok) {
            const requests = Array.isArray(request) ? request : [request];
            lastFailure = `HTTP ${response.status} (${requests.map(item => item.method).join(",")})`;
            await response.body?.cancel();
            throw new Error("Upstream unavailable");
          }
          return reply(200, await response.json());
        } catch (error) {
          if (!lastFailure) lastFailure = error instanceof Error && error.name === "TimeoutError" ? "READ_TIMEOUT" : "READ_TRANSPORT_ERROR";
          if (attempt === 2) throw new Error("Read retries exhausted");
          counts.retries++;
          await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
        }
      }
    } catch { counts.upstreamFailures++; reply(502, { error: "Read-only upstream unavailable" }); }
  });
  server.requestTimeout = 20000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, counts, deniedMethods, lastFailure: () => lastFailure, close: () => new Promise<void>(resolve => {
    server.close(() => resolve()); server.closeAllConnections();
  }) };
}
