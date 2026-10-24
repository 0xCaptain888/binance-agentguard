import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, encodeFunctionData, getAddress, http, isAddress, parseUnits, TransactionNotFoundError, TransactionReceiptNotFoundError, type Address, type Hash, type Hex, type PublicClient } from "viem";
import { startLocalFixture, sendLocalTransaction, type LocalFixture } from "./local.js";
import { json, planFromChain, portfolio, readSnapshot, verifyExecution } from "./rebalancer.js";
import { JobStore, type Job } from "./store.js";
import { WalletSessions } from "./auth.js";
import { registrationCard, verifiedRegistration, verifyRegistration, type Registration } from "./identity.js";
import { tokenAbi, vaultAbi } from "./abi.js";
import { serviceBoundary, trustedHost, sameOrigin } from "./boundary.js";
import { pendingMonitor } from "./operations.js";
import { claimJournal } from "./journal-lock.js";

export type ServerOptions = { mode: "local" | "testnet"; port?: number; rpcUrl?: string; verifierRpcUrl?: string; vault?: Address; journal?: string;
  publicOrigin?: string; listenHost?: string; reconcileIntervalMs?: number; registrationHash?: Hash };
class HttpError extends Error { constructor(public code: number, message: string) { super(message); } }
const address = (value: unknown) => {
  if (typeof value !== "string" || !isAddress(value)) throw new HttpError(400, "Valid wallet address required");
  return getAddress(value);
};
const hash = (value: unknown): Hash => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new HttpError(400, "Valid transaction hash required");
  return value as Hash;
};
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "Send application/json");
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) throw new HttpError(413, "Request too large"); chunks.push(chunk); }
  try { const result = JSON.parse(Buffer.concat(chunks).toString());
    if (!result || Array.isArray(result) || typeof result !== "object") throw new Error(); return result;
  } catch { throw new HttpError(400, "Invalid JSON object"); }
}

// Testnet may sit behind a dedicated HTTPS gateway with an explicit origin.
// Local fixtures always remain loopback-only; forwarded headers are not trusted.
export async function startBscServer(options: ServerOptions) {
  const boundary = serviceBoundary(options);
  const interval = options.reconcileIntervalMs ?? (options.mode === "testnet" ? 30000 : 0);
  if (!Number.isSafeInteger(interval) || (interval !== 0 && (interval < 5000 || interval > 300000))) throw new Error("Invalid reconciliation interval");
  let fixture: LocalFixture | undefined;
  let unlock: (() => Promise<void>) | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let client: PublicClient, verifier: PublicClient, vault: Address;
  if (options.mode === "local") {
    fixture = await startLocalFixture([options.port ?? 43188]); client = verifier = fixture.client; vault = fixture.vault;
  } else {
    if (!options.rpcUrl || !options.verifierRpcUrl || !options.vault) throw new Error("Testnet needs RPC, independent verifier RPC and deployed vault");
    for (const value of [options.rpcUrl, options.verifierRpcUrl]) {
      if (new URL(value).protocol !== "https:") throw new Error("Use HTTPS testnet RPC endpoints");
    }
    if (new URL(options.rpcUrl).host === new URL(options.verifierRpcUrl).host) throw new Error("Use a different RPC provider for verification");
    client = createPublicClient({ transport: http(options.rpcUrl), cacheTime: 0 });
    verifier = createPublicClient({ transport: http(options.verifierRpcUrl), cacheTime: 0 });
    if ((await client.getChainId()) !== 97 || (await verifier.getChainId()) !== 97) throw new Error("Only BSC testnet 97 is enabled");
    vault = getAddress(options.vault);
  }
  try {
    const initial = await readSnapshot(client, vault, undefined, true);
    let registration: Registration | undefined;
    if (!fixture && options.registrationHash) {
      if (!boundary.publicOrigin) throw new Error("Identity verification requires the configured public HTTPS origin");
      const proof = await verifyRegistration(client, verifier, boundary.publicOrigin, initial.owner, options.registrationHash);
      registration = verifiedRegistration(proof);
      if (!registration) throw new Error("Configured ERC-8004 registration is not independently verified");
    }
    const checkpoint = fixture ? String(await fixture.rpc("evm_snapshot")) : undefined;
    let resetPoint = checkpoint;
    const journal = options.journal ?? (fixture ? `.runtime/local-${process.pid}-${Date.now()}.json` : ".runtime/bsc-testnet-journal.json");
    unlock = await claimJournal(journal);
    const store = new JobStore(journal);
    await store.load();
    // Never mix a persisted queue with a different chain or vault.
    if (store.view.jobs.some(j => j.plan.chainId !== initial.chainId || j.plan.vault.toLowerCase() !== vault.toLowerCase())) throw new Error("Journal belongs to another vault");
    let origin = "";
    let sessions: WalletSessions;
    let queue: Promise<unknown> = Promise.resolve();
    const serialized = <T>(action: () => Promise<T>) => { const task = queue.then(action); queue = task.catch(() => {}); return task; };
    const monitor = pendingMonitor(store, (id, tx) => serialized(() => verifySaved(id, tx)));
    let readiness: { at: number; value: Promise<{ ready: boolean; rpcAvailable: boolean }> } | undefined;
    const ready = () => {
      if (!readiness || Date.now() - readiness.at > 5000) readiness = { at: Date.now(), value: (async () => {
        try {
          const [primary, secondary] = await Promise.all([client.getBlock(), verifier.getBlock()]);
          const height = primary.number! < secondary.number! ? primary.number! : secondary.number!;
          const [a, b, chain0, chain1] = await Promise.all([client.getBlock({ blockNumber: height }), verifier.getBlock({ blockNumber: height }), client.getChainId(), verifier.getChainId()]);
          const now = BigInt(Math.floor(Date.now() / 1000));
          const available = chain0 === initial.chainId && chain1 === initial.chainId && a.hash === b.hash && !!a.hash &&
            a.timestamp <= now + 30n && now - a.timestamp <= 120n;
          return { ready: available, rpcAvailable: available };
        } catch { return { ready: false, rpcAvailable: false }; }
      })() };
      return readiness.value;
    };
    const rates = new Map<string, { at: number; count: number }>();
    const server = createServer(async (req, res) => {
      res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      const reply = (code: number, value: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(json(value)); };
      try {
        if (!trustedHost(req.headers, origin)) throw new HttpError(403, "Untrusted Host header");
        const path = new URL(req.url ?? "/", origin).pathname;
        if (path.startsWith("/api/") || path === "/readyz") {
          // A gateway must enforce per-client limits too. This process-wide limit
          // bounds RPC work without trusting spoofable X-Forwarded-For headers.
          const now = Date.now(), key = "rpc-global";
          let rate = rates.get(key); if (!rate || now - rate.at > 60000) rates.set(key, rate = { at: now, count: 0 });
          if (++rate.count > 600) throw new HttpError(429, "Service request limit reached");
        }
        if (req.method === "GET") {
          if (path === "/healthz") return reply(200, { live: true, mode: options.mode });
          if (path === "/readyz" || path === "/api/v1/operations") {
            const health = await ready(), operations = monitor.summary();
            const ok = health.ready && !operations.frozen && !operations.errorCount && !operations.stalePending.length;
            return reply(path === "/readyz" && !ok ? 503 : 200, { ...health, ready: ok, mode: options.mode,
              reconciliation: { ...operations, enabled: interval > 0 }, campaignProof: false });
          }
          if (path === "/api/v1/status") {
            const snapshot = await readSnapshot(client, vault, undefined, true);
            return reply(200, { mode: options.mode, environment: fixture ? "LOCAL_EVM" : "BSC_TESTNET", campaignProof: false,
              snapshot, portfolio: snapshot.pricingAvailable ? portfolio(snapshot) : null, journal: store.view,
              pricing: { available: snapshot.pricingAvailable, reason: snapshot.pricingAvailable ? null : "oracle_unavailable_or_stale" },
              readiness: { publicOriginConfigured: !!boundary.publicOrigin, deployedPublicly: false, erc8004Registered: !!registration, marketplaceListed: false, campaignQualified: false },
              note: fixture ? "Mock tokens, oracle and router on an isolated local EVM. No campaign credit." : "Unsigned wallet execution; separate RPC verifier. Registration, listing and campaign eligibility are unverified." });
          }
          if (path === "/.well-known/agent-registration.json") return reply(200, registrationCard(origin, registration));
          const files: Record<string, [string, string]> = {
            "/": ["site/bsc/index.html", "text/html"], "/bsc/": ["site/bsc/index.html", "text/html"],
            "/bsc/app.js": ["site/bsc/app.js", "text/javascript"], "/bsc/style.css": ["site/bsc/style.css", "text/css"],
            "/bsc/submission.js": ["site/bsc/submission.js", "text/javascript"],
            "/bsc/wallet-session.js": ["site/bsc/wallet-session.js", "text/javascript"],
            "/bsc/mark.svg": ["site/bsc/mark.svg", "image/svg+xml"]
          };
          if (files[path]) { const [file, mime] = files[path]; res.writeHead(200, { "Content-Type": mime }); return res.end(await readFile(resolve(file))); }
          throw new HttpError(404, "Not found");
        }
        if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
        if (!sameOrigin(req.headers, origin)) throw new HttpError(403, "Same-origin request required");
        const key = req.socket.remoteAddress ?? "local", now = Date.now();
        let rate = rates.get(key); if (!rate || now - rate.at > 60000) rates.set(key, rate = { at: now, count: 0 });
        if (++rate.count > 90) throw new HttpError(429, "Please wait before retrying");
        const input = await body(req);
        if (path === "/api/v1/auth/challenge") return reply(200, sessions.challenge(address(input.address)));
        if (path === "/api/v1/auth/session") {
          if (typeof input.nonce !== "string" || typeof input.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(input.signature)) throw new HttpError(400, "Signature and nonce required");
          try { return reply(200, await sessions.exchange(input.nonce, input.signature as Hex)); }
          catch { throw new HttpError(401, "Invalid or expired wallet challenge"); }
        }
        const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
        let caller: Address = initial.owner;
        if (!fixture) { try { caller = sessions.address(token); } catch { throw new HttpError(401, "Connect owner or operator wallet"); } }
        if (path === "/api/v1/auth/logout") { sessions.revoke(token); return reply(200, { disconnected: true }); }
        const result = await serialized(async () => {
          if (path === "/api/v1/local/reset" && fixture) {
            const beforeReset = await fixture.client.getBlock();
            if (await fixture.rpc("evm_revert", [resetPoint]) !== true) throw new Error("Local reset checkpoint is unavailable");
            resetPoint = String(await fixture.rpc("evm_snapshot"));
            // Refresh real mock-feed state after restoring balances. An old checkpoint
            // must not make the next local drill fail solely because time has passed.
            const restored = await fixture.client.getBlock();
            const timestamp = [BigInt(Math.floor(Date.now() / 1000)), beforeReset.timestamp, restored.timestamp + 1n]
              .reduce((latest, value) => value > latest ? value : latest);
            await fixture.rpc("evm_setNextBlockTimestamp", [Number(timestamp)]);
            await fixture.rpc("evm_mine");
            for (const feed of [fixture.feed0, fixture.feed1]) {
              await fixture.write(feed, fixture.artifacts.TestFeed.abi, "set", [100000000n, timestamp]);
            }
            await store.change(s => { s.frozen = false; s.jobs = []; }); return { reset: true };
          }
          if (path === "/api/v1/local/oracle-outage" && fixture) {
            await fixture.write(fixture.feed0, fixture.artifacts.TestFeed.abi, "set", [100000000n, 1n]);
            return { environment: "LOCAL_EVM", campaignProof: false, pricingAvailable: false };
          }
          if (path === "/api/v1/action") {
            if (caller.toLowerCase() !== initial.owner.toLowerCase()) throw new HttpError(403, "Only owner can manage funding or pause");
            if (input.action === "pause" || input.action === "resume") {
              const data = encodeFunctionData({ abi: vaultAbi, functionName: "setPaused", args: [input.action === "pause"] });
              if (fixture) { const tx = await fixture.write(vault, vaultAbi, "setPaused", [input.action === "pause"]); return { hash: tx }; }
              return { transaction: { from: caller, to: vault, data, value: "0x0", chainId: "0x61" } };
            }
            if (!["approve", "deposit", "withdraw"].includes(String(input.action))) throw new HttpError(400, "Unknown owner action");
            if (typeof input.amount !== "string" || !/^(0|[1-9]\d{0,18})(\.\d{1,18})?$/.test(input.amount)) throw new HttpError(400, "Positive decimal amount required");
            if (input.asset !== 0 && input.asset !== 1) throw new HttpError(400, "Asset must be 0 or 1");
            // Emergency owner controls must not depend on a fresh oracle. Token addresses and
            // decimals are immutable for this vault and were validated at server startup.
            const decimals = input.asset === 0 ? initial.decimals0 : initial.decimals1;
            if ((input.amount.split(".")[1]?.length ?? 0) > decimals) throw new HttpError(400, "Too many token decimals");
            const amount = parseUnits(input.amount, decimals); if (amount <= 0n) throw new HttpError(400, "Amount must be positive");
            const asset = input.asset === 0 ? initial.token0 : initial.token1;
            const to = input.action === "approve" ? asset : vault;
            const data = input.action === "approve" ? encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [vault, amount] }) :
              encodeFunctionData({ abi: vaultAbi, functionName: input.action === "deposit" ? "deposit" : "withdraw", args: [input.asset === 0, amount] });
            return { transaction: { from: caller, to, data, value: "0x0", chainId: `0x${initial.chainId.toString(16)}` } };
          }
          if (path === "/api/v1/recover") {
            if (caller.toLowerCase() !== initial.owner.toLowerCase()) throw new HttpError(403, "Only owner can recover the runner");
            const snapshot = await readSnapshot(verifier, vault, undefined, true);
            if (!snapshot.paused) throw new HttpError(409, "Pause the vault on-chain and wait for confirmation before acknowledging the incident");
            await store.change(s => { s.frozen = false; });
            return { runnerRecovered: true, vaultPaused: true, note: "Failed proofs remain in the journal. Resume the vault separately after review." };
          }
          if (store.view.frozen) throw new HttpError(409, "Runner frozen. Inspect the failed proof; on-chain owner withdrawal remains available.");
          if (path === "/api/v1/plans") {
            const result = await planFromChain(client, vault);
            if (result.decision.state !== "READY") return result.decision;
            const plan = result.decision.plan;
            const matching = store.view.jobs.filter(j => j.plan.id === plan.id);
            const existing = matching.find(j => j.state !== "FROZEN"); if (existing) return { state: "READY", job: existing };
            // Supersede unsigned proposals once state changed; never execute stale jobs automatically.
            // A failed proof remains immutable evidence. After owner recovery, issue a distinct
            // runner job for the same still-valid on-chain plan rather than deleting history.
            const id = matching.length === 0 ? plan.id : `${plan.id}:retry-${matching.length}`;
            const job: Job = { id, plan, createdAt: new Date().toISOString(), state: "AWAITING_SIGNATURE" };
            await store.change(s => { s.jobs.push(job); }); return { state: "READY", job };
          }
          const job = store.view.jobs.find(j => j.id === input.jobId);
          if (!job) throw new HttpError(404, "Stored plan not found");
          if (job.receipt) {
            if (input.hash && input.hash !== job.receipt.transactionHash) throw new HttpError(409, "A different transaction was already verified");
            return { job };
          }
          if ((path === "/api/v1/local/execute" || path === "/api/v1/local/fault") && fixture) {
            // Once broadcast returns a hash, commit it before any confirmation or proof
            // reads. Either local endpoint must resume this transaction on retry, even
            // if the first request was a deliberate mismatched-proof drill.
            let tx = job.transactionHash;
            if (!tx) {
              const fault = path === "/api/v1/local/fault";
              tx = await sendLocalTransaction(fixture, { account: fault ? fixture.owner : fixture.operator,
                to: job.plan.vault, value: 0n, data: fault
                  ? encodeFunctionData({ abi: vaultAbi, functionName: "setPaused", args: [false] }) : job.plan.data });
              await store.change(s => { const pending = s.jobs.find(j => j.id === job.id)!;
                pending.transactionHash = tx; pending.state = "VERIFYING"; });
            }
            await fixture.wait(tx);
            await fixture.rpc("evm_mine");
            const receipt = await verifyExecution(verifier, job.plan, tx); await finish(job.id, receipt);
            return { job: store.view.jobs.find(j => j.id === job.id) };
          }
          if (path === "/api/v1/verify") {
            const tx = hash(input.hash);
            return verifySaved(job.id, tx);
          }
          throw new HttpError(404, "Not found");
        });
        return reply(200, result);
      } catch (error) {
        // Never return transport exceptions, stack traces or configured RPC URLs/keys.
        reply(error instanceof HttpError ? error.code : 503,
          { error: error instanceof HttpError ? error.message : "Operation unavailable. Check chain state, oracle freshness or wallet authorization and retry." });
      }
    });
    async function finish(id: string, receipt: Awaited<ReturnType<typeof verifyExecution>>) {
      await store.change(s => { const job = s.jobs.find(j => j.id === id)!; job.receipt = receipt; job.transactionHash = receipt.transactionHash; job.state = receipt.state;
        if (receipt.state === "FROZEN") s.frozen = true; });
    }
    async function verifySaved(id: string, tx: Hash) {
      const job = store.view.jobs.find(j => j.id === id);
      if (!job) throw new HttpError(404, "Stored plan not found");
      if (job.transactionHash && job.transactionHash.toLowerCase() !== tx.toLowerCase()) throw new HttpError(409, "Plan is already bound to another transaction");
      if (job.receipt) return { job };
      let receipt;
      try { receipt = await verifier.getTransactionReceipt({ hash: tx }); }
      catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
        try { await verifier.getTransaction({ hash: tx }); }
        catch (error) {
          if (!(error instanceof TransactionNotFoundError)) throw error;
          return { state: "PENDING" as const, reason: "Transaction not yet found by verifier RPC", bound: false };
        }
      }
      await store.change(s => { const pending = s.jobs.find(j => j.id === id)!;
        pending.transactionHash = tx; pending.state = "VERIFYING"; });
      if (!receipt) return { state: "PENDING" as const, reason: "Transaction is visible and awaiting inclusion", bound: true };
      if (await verifier.getBlockNumber({ cacheTime: 0 }) < receipt.blockNumber + 1n) return { state: "PENDING" as const, reason: "Waiting for two confirmations" };
      const proof = await verifyExecution(verifier, job.plan, tx); await finish(id, proof);
      return { job: store.view.jobs.find(j => j.id === id) };
    }
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 43188, boundary.host, resolve); });
    const localOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    origin = boundary.publicOrigin ?? localOrigin;
    sessions = new WalletSessions(origin, vault, [initial.owner, initial.operator]);
    if (interval) { timer = setInterval(() => { void monitor.run(); }, interval); timer.unref(); void monitor.run(); }
    return { origin, localOrigin, store, fixture, reconcile: monitor.run, operations: monitor.summary, close: async () => {
      if (timer) clearInterval(timer);
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      await monitor.idle(); await queue; await fixture?.close(); await unlock?.(); unlock = undefined;
    } };
  } catch (error) { if (timer) clearInterval(timer); await fixture?.close(); await unlock?.(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv.includes("--testnet") ? "testnet" : "local";
  try {
    const app = await startBscServer({ mode, port: Number(process.env.PORT ?? 43188), rpcUrl: process.env.BSC_TESTNET_RPC_URL,
      verifierRpcUrl: process.env.BSC_VERIFIER_RPC_URL, vault: process.env.BSC_VAULT_ADDRESS as Address | undefined,
      publicOrigin: process.env.BSC_PUBLIC_ORIGIN, listenHost: process.env.BSC_LISTEN_HOST, journal: process.env.BSC_JOURNAL_PATH,
      registrationHash: process.env.BSC_REGISTRATION_TX_HASH as Hash | undefined,
      reconcileIntervalMs: process.env.BSC_RECONCILE_INTERVAL_MS === undefined ? undefined : Number(process.env.BSC_RECONCILE_INTERVAL_MS) });
    console.log(`AgentGuard ${mode} console: ${app.origin}/bsc/`);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
  } catch { console.error("BSC startup failed. Check the documented configuration and local Anvil installation. No funds moved."); process.exitCode = 1; }
}
