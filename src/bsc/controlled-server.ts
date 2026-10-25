import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Hash, PublicClient } from "viem";
import { assertControlledRetryNonce, controlledOwner, controlledVaultConfig, prepareControlledEnvironment, prepareControlledRefresh,
  reconcileControlledPreparations, verifyControlledEnvironment, verifyControlledRefresh, type ControlledProof } from "./controlled.js";
import { controlledDisclosure } from "./dependency-disclosure.js";
import { testnetClients } from "./deployment.js";
import { json } from "./rebalancer.js";

// Keyless, local-only setup. Signing remains exclusively in the owner's extension.
export async function startControlledServer(client: PublicClient, verifier: PublicClient, ownerInput: unknown,
  port = 43195, paths = { config: "config/bsc-controlled.json", evidence: ".runtime" }) {
  const owner = controlledOwner(ownerInput);
  if ((await client.getChainId()) !== 97 || (await verifier.getChainId()) !== 97) throw new Error("BSC testnet 97 only");
  let origin = "", busy = false, requests = 0, windowAt = Date.now(), proof: ControlledProof | undefined;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const reply = (code: number, body: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(json(body)); };
    try {
      if (req.headers.host !== new URL(origin).host) return reply(403, { error: "Untrusted Host header" });
      const path = new URL(req.url ?? "/", origin).pathname;
      if (req.method === "GET") {
        if (path === "/api/v1/controlled") return reply(200, { owner, chainId: 97, ...controlledDisclosure, financialTransactionCreated: false });
        if (path === "/") { res.writeHead(302, { Location: "/bsc/setup/" }); return res.end(); }
        const files: Record<string, [string, string]> = {
          "/bsc/setup/": ["site/bsc/setup/index.html", "text/html"], "/bsc/setup/app.js": ["site/bsc/setup/app.js", "text/javascript"],
          "/bsc/wallet-session.js": ["site/bsc/wallet-session.js", "text/javascript"],
          "/bsc/style.css": ["site/bsc/style.css", "text/css"], "/bsc/mark.svg": ["site/bsc/mark.svg", "image/svg+xml"]
        };
        if (!files[path]) return reply(404, { error: "Not found" });
        const [file, mime] = files[path]; res.writeHead(200, { "Content-Type": mime }); return res.end(await readFile(resolve(file)));
      }
      if (req.method !== "POST" || !["prepare", "prepare-retry", "verify", "config", "refresh", "verify-refresh"].some(action => path === `/api/v1/controlled/${action}`))
        return reply(405, { error: "Method not allowed" });
      if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") return reply(403, { error: "Same-origin request required" });
      if (!req.headers["content-type"]?.startsWith("application/json")) return reply(415, { error: "Send application/json" });
      if (Date.now() - windowAt > 60000) { requests = 0; windowAt = Date.now(); }
      if (++requests > 20) return reply(429, { error: "Wait before retrying setup" });
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { size += chunk.length; if (size > 1024) return reply(413, { error: "Request too large" }); chunks.push(chunk); }
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString());
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
        const allowed = path.endsWith("/prepare-retry") ? ["nonce"] : path.endsWith("/verify-refresh") ? ["hash", "feed", "nonce", "environmentHash"] : path.endsWith("/verify") ? ["hash", "nonce"] : path.endsWith("/config") ? ["operator", "mode", "environmentHash"] : path.endsWith("/refresh") ? ["environmentHash"] : [];
        if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error();
      } catch { return reply(400, { error: "Invalid setup request" }); }
      if (busy) return reply(409, { error: "Setup inspection already running" });
      busy = true;
      try {
        if (path.endsWith("/prepare") || path.endsWith("/prepare-retry")) {
          const retry = path.endsWith("/prepare-retry");
          if (retry && (!Number.isSafeInteger(input.nonce) || (input.nonce as number) < 0))
            return reply(400, { error: "Valid saved deployment nonce required" });
          const checkRetry = async () => {
            try { await assertControlledRetryNonce(client, verifier, owner, input.nonce as number); return true; }
            catch { reply(409, { error: "Saved nonce is mined, pending, or unavailable across the two RPCs. Recover and verify the original transaction; no retry prepared." }); return false; }
          };
          if (retry && !await checkRetry()) return;
          const anchor = await client.getBlock();
          if (anchor.number === null || !anchor.hash) return reply(409, { error: "Primary RPC did not provide a mined anchor block" });
          const [independentAnchor, primary, independent] = await Promise.all([
            verifier.getBlock({ blockNumber: anchor.number }),
            prepareControlledEnvironment(client, owner, anchor.number),
            prepareControlledEnvironment(verifier, owner, anchor.number)
          ]);
          if (independentAnchor.hash !== anchor.hash)
            return reply(409, { error: "Independent RPC disagrees on the selected canonical block" });
          let reconciled;
          try { reconciled = reconcileControlledPreparations(primary, independent); }
          catch { return reply(409, { error: "Independent preparation disagrees on the anchor, owner balance, deployment data or gas estimate. No transaction was sent." }); }
          const stillCanonical = await Promise.all([client, verifier].map(rpc => rpc.getBlock({ blockNumber: anchor.number! })));
          if (stillCanonical.some(block => block.hash !== anchor.hash))
            return reply(409, { error: "Selected block changed during independent inspection. Retry preparation." });
          if (retry && !await checkRetry()) return;
          return reply(200, { ...reconciled, ...(retry ? { retryNonce: input.nonce } : {}), preparedAt: Date.now() });
        }
        if (path.endsWith("/verify")) {
          proof = undefined;
          if (typeof input.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(input.hash) ||
            (input.nonce !== undefined && (!Number.isSafeInteger(input.nonce) || (input.nonce as number) < 0)))
            return reply(400, { error: "Deployment transaction hash and an optional valid request nonce are required" });
          const inspected = await verifyControlledEnvironment(client, verifier, owner, input.hash as Hash, input.nonce as number | undefined);
          if (inspected.state === "VERIFIED") {
            await mkdir(paths.evidence, { recursive: true });
            await writeFile(resolve(paths.evidence, `bsc-controlled-${input.hash.toLowerCase()}.json`), json(inspected) + "\n", { mode: 0o600 });
            proof = inspected;
          }
          return reply(200, inspected);
        }
        if (!proof || proof.state !== "VERIFIED") return reply(409, { error: "Verify the environment with both RPCs first" });
        if (typeof input.environmentHash !== "string" || input.environmentHash.toLowerCase() !== proof.transactionHash.toLowerCase())
          return reply(409, { error: "Environment changed. Reverify the deployment hash shown in this tab" });
        const inspected = await verifyControlledEnvironment(client, verifier, owner, proof.transactionHash);
        if (inspected.state !== "VERIFIED") { proof = undefined; return reply(409, { error: "Environment is no longer independently verified" }); }
        proof = inspected;
        if (path.endsWith("/refresh")) return reply(200, await prepareControlledRefresh(client, verifier, proof));
        if (path.endsWith("/verify-refresh")) {
          if (typeof input.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(input.hash) ||
            ![0, 1].includes(input.feed as number) || !Number.isSafeInteger(input.nonce) || (input.nonce as number) < 0)
            return reply(400, { error: "Refresh hash, feed index and saved request nonce required" });
          return reply(200, await verifyControlledRefresh(client, verifier, proof, input.hash as Hash, input.feed as 0 | 1, input.nonce as number));
        }
        let config;
        try { config = controlledVaultConfig(proof, input.operator, input.mode); }
        catch { return reply(400, { error: "Choose OWNER_MANUAL with the owner, or DELEGATED with a distinct operator public address" }); }
        await mkdir(dirname(resolve(paths.config)), { recursive: true });
        try { await writeFile(resolve(paths.config), json(config) + "\n", { flag: "wx", mode: 0o600 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") return reply(409, { error: "Controlled config already exists. It was not overwritten. Review or archive it locally before exporting another config." });
          throw error;
        }
        return reply(201, { status: "CONTROLLED_CONFIG_SAVED", config, path: paths.config, ...controlledDisclosure, financialTransactionCreated: false });
      } finally { busy = false; }
    } catch { proof = undefined; reply(503, { error: "Setup unavailable. Check both chain-97 archive RPCs and test gas. No transaction was sent by this service. Reverify the environment before continuing." }); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const owner = controlledOwner(process.argv[2] ?? process.env.BSC_OWNER_ADDRESS);
    const { client, verifier } = await testnetClients(process.env.BSC_TESTNET_RPC_URL, process.env.BSC_VERIFIER_RPC_URL);
    const app = await startControlledServer(client, verifier, owner, Number(process.env.CONTROLLED_PORT ?? 43195));
    console.log(`Controlled synthetic-test setup: ${app.origin}/bsc/setup/\nNo signer. No market pricing. No campaign proof.`);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
  } catch { console.error("Controlled setup unavailable. Supply the owner public address and two distinct HTTPS chain-97 RPC providers. No transaction sent."); process.exitCode = 1; }
}
