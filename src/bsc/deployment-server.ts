import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Hash, PublicClient } from "viem";
import { parseDeploymentConfig, prepareDeployment, testnetClients, verifyDeployment, type DeploymentConfig } from "./deployment.js";
import { json } from "./rebalancer.js";
import { deploymentPreflight } from "./preflight.js";
import { prepareRegistration, verifyRegistration, verifiedRegistration } from "./identity.js";

// This service only prepares data and reads chain state. It has no wallet or signer.
export async function startDeploymentServer(client: PublicClient, verifier: PublicClient, config: DeploymentConfig, port = 43191) {
  if (await verifier.getChainId() !== 97) throw new Error("Verifier must use BSC testnet 97");
  const prepared = await prepareDeployment(client, config);
  const registration = config.publicBaseUrl ? await prepareRegistration(client, config.publicBaseUrl, config.owner) : undefined;
  let origin = "", verifying = false, requests = 0, windowAt = Date.now();
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const reply = (code: number, data: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(json(data)); };
    try {
      if (req.headers.host !== new URL(origin).host) return reply(403, { error: "Untrusted Host header" });
      const path = new URL(req.url ?? "/", origin).pathname;
      if (req.method === "GET") {
        if (path === "/api/v1/deployment") return reply(200, prepared);
        if (path === "/api/v1/registration") return reply(200, registration ?? {
          status: "REGISTRATION_UNAVAILABLE", chainId: 97, campaignProof: false,
          reason: "Configure publicBaseUrl as a public HTTPS origin before preparing ERC-8004 registration."
        });
        if (path === "/") { res.writeHead(302, { Location: "/bsc/deploy/" }); return res.end(); }
        const files: Record<string, [string, string]> = {
          "/bsc/deploy/": ["site/bsc/deploy/index.html", "text/html"], "/bsc/deploy/app.js": ["site/bsc/deploy/app.js", "text/javascript"],
          "/bsc/wallet-session.js": ["site/bsc/wallet-session.js", "text/javascript"],
          "/bsc/style.css": ["site/bsc/style.css", "text/css"], "/bsc/mark.svg": ["site/bsc/mark.svg", "image/svg+xml"]
        };
        if (!files[path]) return reply(404, { error: "Not found" });
        const [file, mime] = files[path]; const data = await readFile(resolve(file)); res.writeHead(200, { "Content-Type": mime }); return res.end(data);
      }
      if (req.method !== "POST" || !["/api/v1/deployment/verify", "/api/v1/deployment/preflight", "/api/v1/registration/verify"].includes(path)) return reply(405, { error: "Method not allowed" });
      if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") return reply(403, { error: "Same-origin request required" });
      if (!req.headers["content-type"]?.startsWith("application/json")) return reply(415, { error: "Send application/json" });
      if (Date.now() - windowAt > 60000) { requests = 0; windowAt = Date.now(); }
      if (++requests > 10) return reply(429, { error: "Wait before retrying verification" });
      let bytes = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 1024) return reply(413, { error: "Request too large" }); chunks.push(chunk); }
      if (path === "/api/v1/deployment/preflight") {
        try { const body = JSON.parse(Buffer.concat(chunks).toString()); if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw new Error(); }
        catch { return reply(400, { error: "Send an empty JSON object for preflight" }); }
        if (verifying) return reply(409, { error: "Deployment inspection already running" });
        verifying = true;
        try { return reply(200, await deploymentPreflight(client, verifier, config)); }
        finally { verifying = false; }
      }
      if (path === "/api/v1/registration/verify") {
        if (!registration) return reply(409, { error: "Configure a public HTTPS origin before verifying registration" });
        let hash: Hash;
        try {
          const input = JSON.parse(Buffer.concat(chunks).toString());
          if (!input || typeof input.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(input.hash)) throw new Error(); hash = input.hash;
        } catch { return reply(400, { error: "Valid registration transaction hash required" }); }
        const proof = await verifyRegistration(client, verifier, config.publicBaseUrl, config.owner, hash);
        if (proof.state === "VERIFIED") {
          await mkdir(".runtime", { recursive: true });
          await writeFile(`.runtime/bsc-registration-${hash.toLowerCase()}.json`, json(proof) + "\n", { mode: 0o600 });
        }
        return reply(200, { ...proof, registration: verifiedRegistration(proof) });
      }
      let hash: Hash;
      try {
        const input = JSON.parse(Buffer.concat(chunks).toString());
        if (!input || typeof input.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(input.hash)) throw new Error(); hash = input.hash;
      } catch { return reply(400, { error: "Valid deployment transaction hash required" }); }
      if (verifying) return reply(409, { error: "Verification already running" });
      verifying = true;
      try {
        const proof = await verifyDeployment(verifier, config, hash);
        await mkdir(".runtime", { recursive: true });
        await writeFile(`.runtime/bsc-deployment-${hash.toLowerCase()}.json`, json(proof) + "\n", { mode: 0o600 });
        return reply(200, proof);
      } finally { verifying = false; }
    } catch { reply(503, { error: "Deployment operation unavailable. Check chain state and archive RPC. No transaction was sent by this service." }); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const configPath = process.argv[2]; if (!configPath) throw new Error("Config path required");
    const config = parseDeploymentConfig(JSON.parse(await readFile(configPath, "utf8")));
    const { client, verifier } = await testnetClients(process.env.BSC_TESTNET_RPC_URL, process.env.BSC_VERIFIER_RPC_URL);
    const app = await startDeploymentServer(client, verifier, config, Number(process.env.DEPLOY_PORT ?? 43191));
    console.log(`AgentGuard wallet deployment: ${app.origin}/bsc/deploy/`);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
  } catch { console.error("Deployment console unavailable. Configure owner, dependencies and two independent HTTPS chain-97 RPCs. No transaction was sent."); process.exitCode = 1; }
}
