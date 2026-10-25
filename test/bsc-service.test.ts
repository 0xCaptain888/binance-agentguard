import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { WalletSessions } from "../src/bsc/auth.js";
import { JobStore } from "../src/bsc/store.js";
import { startBscServer } from "../src/bsc/server.js";
import { vaultAbi } from "../src/bsc/abi.js";
import { readSnapshot } from "../src/bsc/rebalancer.js";

let directory: string;
let app: Awaited<ReturnType<typeof startBscServer>>;
let probes = 0, releaseProbe: (() => void) | undefined;
before(async () => { directory = await mkdtemp(join(tmpdir(), "agentguard-test-"));
  app = await startBscServer({ mode: "local", port: 0, journal: join(directory, "journal.json"),
    dependencyReportPath: join(directory, "dependencies.json"),
    dependencyProbe: async () => { probes++; await new Promise<void>(resolve => { releaseProbe = resolve; }); throw new Error("private RPC URL"); } }); });
after(async () => { await app?.close(); if (directory) await rm(directory, { recursive: true }); });
async function post(path: string, input: unknown, origin = app.origin) {
  const response = await fetch(`${app.origin}/api/v1${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(input) });
  return { status: response.status, body: await response.json() as any };
}
test("HTTP rejects cross-origin mutation, invalid JSON and oversized bodies", async () => {
  assert.equal((await fetch(`${app.origin}/healthz`)).status, 200);
  const operations = await (await fetch(`${app.origin}/api/v1/operations`)).json() as any;
  assert.equal(operations.ready, true); assert.equal(operations.campaignProof, false);
  assert.equal(operations.reconciliation.enabled, false);
  const module = await fetch(`${app.origin}/bsc/submission.js`);
  assert.equal(module.status, 200);
  assert.match(module.headers.get("content-type")!, /javascript/);
  assert.match(await module.text(), /export function submissionGuard/);
  const sessionModule = await fetch(`${app.origin}/bsc/wallet-session.js`);
  assert.equal(sessionModule.status, 200);
  assert.match(sessionModule.headers.get("content-type")!, /javascript/);
  assert.match(await sessionModule.text(), /export function walletSession/);
  const dependenciesModule = await fetch(`${app.origin}/bsc/dependencies.js`);
  assert.equal(dependenciesModule.status, 200);
  assert.match(dependenciesModule.headers.get("content-type")!, /javascript/);
  const scan = await (await fetch(`${app.origin}/api/v1/dependencies`)).json() as any;
  assert.equal(scan.state, "NOT_CHECKED");
  assert.equal(scan.deploymentReady, false); assert.equal(scan.financialTransactionCreated, false);
  assert.equal((await post("/plans", {}, "https://attacker.invalid")).status, 403);
  const invalid = await fetch(`${app.origin}/api/v1/plans`, { method: "POST", headers: { Origin: app.origin, "Content-Type": "application/json" }, body: "[" });
  assert.equal(invalid.status, 400);
  assert.equal((await post("/plans", { large: "x".repeat(17000) })).status, 413);
});
test("local scan API rejects cross-origin work and repeated starts share one read-only job", async () => {
  assert.equal((await post("/dependencies/scan", {}, "https://attacker.invalid")).status, 403);
  assert.equal(probes, 0);
  const accepted = await post("/dependencies/scan", {});
  assert.equal(accepted.status, 202); assert.equal(accepted.body.scan.state, "RUNNING");
  assert.equal((await post("/dependencies/scan", {})).status, 202); assert.equal(probes, 1);
  assert.equal((await (await fetch(`${app.origin}/api/v1/dependencies`)).json() as any).scan.state, "RUNNING");
  releaseProbe!();
  let summary: any;
  for (let i = 0; i < 100; i++) {
    summary = await (await fetch(`${app.origin}/api/v1/dependencies`)).json();
    if (summary.scan.state === "FAILED") break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(summary.scan.state, "FAILED"); assert.equal(summary.state, "UNAVAILABLE");
  assert.equal(summary.financialTransactionCreated, false);
  const cooldown = await post("/dependencies/scan", {});
  assert.equal(cooldown.status, 429); assert.ok(cooldown.body.scan.retryAfterSeconds > 0);
  assert.doesNotMatch(JSON.stringify(summary), /private RPC/);
  assert.equal(app.store.view.jobs.length, 0);
});
test("background reconciliation verifies saved hashes after an RPC outage without rebroadcasting", async () => {
  await post("/local/reset", {});
  const job = (await post("/plans", {})).body.job, f = app.fixture!;
  const hash = await f.wallet.sendTransaction({ account: f.operator, to: job.plan.vault, data: job.plan.data, value: 0n });
  await f.wait(hash); await f.rpc("evm_mine");
  await app.store.change(s => { s.jobs[0].transactionHash = hash; s.jobs[0].state = "VERIFYING"; });
  const original = f.client.getTransactionReceipt, send = f.wallet.sendTransaction;
  try {
    f.wallet.sendTransaction = async () => { throw new Error("Reconciler must never broadcast"); };
    f.client.getTransactionReceipt = async () => { throw new Error("RPC transport unavailable"); };
    // Transport errors must be surfaced as outages, not misreported as unknown hashes.
    assert.equal((await post("/verify", { jobId: job.id, hash })).status, 503);
    await app.reconcile();
    assert.equal(app.operations().errorCount, 1);
    assert.equal(app.store.view.jobs[0].state, "VERIFYING");
    assert.equal(app.store.view.frozen, false);
    f.client.getTransactionReceipt = original;
    await app.reconcile();
    assert.equal(app.store.view.jobs[0].state, "VERIFIED");
    assert.equal(app.store.view.jobs[0].receipt!.transactionHash, hash);
    assert.equal(app.operations().errorCount, 0);
  } finally { f.client.getTransactionReceipt = original; f.wallet.sendTransaction = send; }
});
test("background reconciliation freezes mismatched proofs and preserves the incident", async () => {
  await post("/local/reset", {});
  const job = (await post("/plans", {})).body.job, f = app.fixture!;
  const hash = await f.write(f.vault, vaultAbi, "setPaused", [false]); await f.rpc("evm_mine");
  await app.store.change(s => { s.jobs[0].transactionHash = hash; s.jobs[0].state = "VERIFYING"; });
  await app.reconcile();
  assert.equal(app.store.view.jobs[0].state, "FROZEN"); assert.equal(app.store.view.frozen, true);
  const proof = app.store.view.jobs[0].receipt;
  await app.reconcile(); assert.deepEqual(app.store.view.jobs[0].receipt, proof);
  assert.equal((await fetch(`${app.origin}/healthz`)).status, 200);
  assert.equal((await fetch(`${app.origin}/readyz`)).status, 503);
});
test("service executes actual local trade, keeps idempotent receipt and persists journal across reload", async () => {
  await post("/local/reset", {});
  const plan = (await post("/plans", {})).body;
  assert.equal(plan.state, "READY");
  const done = (await post("/local/execute", { jobId: plan.job.id })).body;
  assert.equal(done.job.state, "VERIFIED");
  const replay = (await post("/local/execute", { jobId: plan.job.id })).body;
  assert.equal(replay.job.receipt.transactionHash, done.job.receipt.transactionHash);
  const reopened = new JobStore(join(directory, "journal.json")); await reopened.load();
  assert.equal(reopened.view.jobs.length, 1);
  assert.equal(reopened.view.jobs[0].plan.amountIn, 10n ** 19n);
  assert.equal(reopened.view.jobs[0].receipt?.campaignProof, false);
  assert.equal(typeof reopened.view.jobs[0].receipt?.confirmations, "bigint");
  assert.ok(reopened.view.jobs[0].receipt!.confirmations >= 2n);
  assert.equal(reopened.view.jobs[0].receipt?.blockHash, done.job.receipt.blockHash);
  assert.equal(reopened.view.jobs[0].receipt?.snapshotBlockHash, done.job.receipt.snapshotBlockHash);
  assert.equal((await post("/verify", { jobId: plan.job.id, hash: `0x${"12".repeat(32)}` })).status, 409);
});
test("a final RPC outage preserves VERIFYING for retry without freezing or producing a receipt", async () => {
  await post("/local/reset", {});
  const job = (await post("/plans", {})).body.job;
  const f = app.fixture!;
  const hash = await f.wallet.sendTransaction({ account: f.operator, to: job.plan.vault, data: job.plan.data, value: 0n });
  await f.wait(hash); await f.rpc("evm_mine");
  const original = f.client.getBlock;
  const receipt = await f.client.getTransactionReceipt({ hash });
  let reads = 0;
  try {
    f.client.getBlock = async (...args) => {
      if (args[0]?.blockNumber === receipt.blockNumber && ++reads === 2) throw new Error("Final block RPC unavailable");
      return original(...args);
    };
    const interrupted = await post("/verify", { jobId: job.id, hash });
    assert.equal(interrupted.status, 503);
    assert.equal(app.store.view.frozen, false);
    assert.equal(app.store.view.jobs[0].state, "VERIFYING");
    assert.equal(app.store.view.jobs[0].transactionHash, hash);
    assert.equal(app.store.view.jobs[0].receipt, undefined);
    const reopened = new JobStore(join(directory, "journal.json")); await reopened.load();
    assert.equal(reopened.view.jobs[0].state, "VERIFYING");
    assert.equal(reopened.view.jobs[0].transactionHash, hash);
  } finally { f.client.getBlock = original; }
  const recovered = await post("/verify", { jobId: job.id, hash });
  assert.equal(recovered.status, 200); assert.equal(recovered.body.job.state, "VERIFIED");
  assert.equal(recovered.body.job.receipt.transactionHash, hash);
});
test("local execution journals the returned hash before waiting and retries without another broadcast", async () => {
  await post("/local/reset", {});
  const job = (await post("/plans", {})).body.job, f = app.fixture!;
  const originalWait = f.wait, originalSend = f.wallet.sendTransaction;
  let broadcasts = 0;
  try {
    f.wallet.sendTransaction = async (...args) => { broadcasts++; return originalSend(...args); };
    f.wait = async tx => {
      const reopened = new JobStore(join(directory, "journal.json")); await reopened.load();
      assert.equal(reopened.view.jobs[0].state, "VERIFYING");
      assert.equal(reopened.view.jobs[0].transactionHash, tx);
      throw new Error("Confirmation RPC interrupted");
    };
    assert.equal((await post("/local/execute", { jobId: job.id })).status, 503);
    const pending = app.store.view.jobs[0];
    assert.equal(pending.state, "VERIFYING"); assert.ok(pending.transactionHash);
    assert.equal(pending.receipt, undefined); assert.equal(app.store.view.frozen, false);
    f.wait = originalWait;
    await f.write(f.feed0, f.artifacts.TestFeed.abi, "set", [100000000n, 1n]);
    assert.equal((await readSnapshot(f.client, f.vault, undefined, true)).pricingAvailable, false);
    const recovered = await post("/local/execute", { jobId: job.id });
    assert.equal(recovered.body.job.state, "VERIFIED");
    assert.equal(recovered.body.job.receipt.transactionHash, pending.transactionHash);
    assert.equal(broadcasts, 1);
    assert.equal((await readSnapshot(f.client, f.vault, undefined, true)).nonce, 1n);
  } finally { f.wait = originalWait; f.wallet.sendTransaction = originalSend; }
});
test("local final-proof outage resumes its saved trade even when retried through the fault endpoint", async () => {
  await post("/local/reset", {});
  const job = (await post("/plans", {})).body.job, f = app.fixture!;
  const original = f.client.getBlockNumber, originalSend = f.wallet.sendTransaction;
  let broadcasts = 0;
  try {
    f.wallet.sendTransaction = async (...args) => { broadcasts++; return originalSend(...args); };
    f.client.getBlockNumber = async () => { throw new Error("Final head RPC interrupted"); };
    assert.equal((await post("/local/execute", { jobId: job.id })).status, 503);
    const pending = app.store.view.jobs[0];
    assert.equal(pending.state, "VERIFYING"); assert.ok(pending.transactionHash);
    assert.equal(pending.receipt, undefined); assert.equal(app.store.view.frozen, false);
    f.client.getBlockNumber = original;
    const recovered = await post("/local/fault", { jobId: job.id });
    assert.equal(recovered.body.job.state, "VERIFIED");
    assert.equal(recovered.body.job.receipt.transactionHash, pending.transactionHash);
    assert.equal(broadcasts, 1);
  } finally { f.client.getBlockNumber = original; f.wallet.sendTransaction = originalSend; }
});
test("interrupted fault drill keeps its original mismatched transaction and freezes on retry", async () => {
  await post("/local/reset", {});
  const job = (await post("/plans", {})).body.job, f = app.fixture!;
  const originalWait = f.wait, originalSend = f.wallet.sendTransaction;
  let broadcasts = 0;
  try {
    f.wallet.sendTransaction = async (...args) => { broadcasts++; return originalSend(...args); };
    f.wait = async () => { throw new Error("Confirmation RPC interrupted"); };
    assert.equal((await post("/local/fault", { jobId: job.id })).status, 503);
    const pending = app.store.view.jobs[0];
    assert.equal(pending.state, "VERIFYING"); assert.equal(app.store.view.frozen, false);
    f.wait = originalWait;
    const recovered = await post("/local/execute", { jobId: job.id });
    assert.equal(recovered.body.job.state, "FROZEN");
    assert.equal(recovered.body.job.receipt.transactionHash, pending.transactionHash);
    assert.equal(app.store.view.frozen, true); assert.equal(broadcasts, 1);
    assert.equal((await readSnapshot(f.client, f.vault)).nonce, 0n);
    assert.equal((await readSnapshot(f.client, f.vault)).balance0, 80n * 10n ** 18n);
  } finally { f.wait = originalWait; f.wallet.sendTransaction = originalSend; }
});
test("concurrent local execute requests share one broadcast and the same verified receipt", async () => {
  await post("/local/reset", {});
  const job = (await post("/plans", {})).body.job, f = app.fixture!;
  const original = f.wallet.sendTransaction;
  let broadcasts = 0;
  try {
    f.wallet.sendTransaction = async (...args) => { broadcasts++; return original(...args); };
    const responses = await Promise.all([post("/local/execute", { jobId: job.id }), post("/local/execute", { jobId: job.id })]);
    for (const response of responses) { assert.equal(response.status, 200); assert.equal(response.body.job.state, "VERIFIED"); }
    assert.equal(responses[0].body.job.receipt.transactionHash, responses[1].body.job.receipt.transactionHash);
    assert.equal(broadcasts, 1);
  } finally { f.wallet.sendTransaction = original; }
});
test("pending confirmations persist and do not freeze; a confirmed mismatched proof freezes runner but allows owner control", async () => {
  await post("/local/reset", {});
  const job = (await post("/plans", {})).body.job;
  const unknown = `0x${"99".repeat(32)}`;
  const missing = await post("/verify", { jobId: job.id, hash: unknown });
  assert.equal(missing.body.state, "PENDING"); assert.equal(missing.body.bound, false);
  assert.equal(app.store.view.jobs[0].transactionHash, undefined);
  const f = app.fixture!;
  const hash = await f.write(f.vault, vaultAbi, "setPaused", [false]);
  const pending = await post("/verify", { jobId: job.id, hash }); assert.equal(pending.body.state, "PENDING");
  assert.equal(app.store.view.frozen, false); assert.equal(app.store.view.jobs[0].transactionHash, hash);
  await f.rpc("evm_mine");
  const failed = await post("/verify", { jobId: job.id, hash }); assert.equal(failed.body.job.state, "FROZEN");
  assert.equal((await post("/plans", {})).status, 409);
  assert.equal((await post("/action", { action: "pause" })).status, 200);
  assert.equal((await post("/recover", {})).status, 200);
  assert.equal(app.store.view.frozen, false);
  assert.equal((await post("/action", { action: "resume" })).status, 200);
  const retry = (await post("/plans", {})).body.job;
  assert.notEqual(retry.id, job.id);
  assert.equal((await post("/local/execute", { jobId: retry.id })).body.job.state, "VERIFIED");
  const disk = JSON.parse(await readFile(join(directory, "journal.json"), "utf8"));
  assert.equal(disk.frozen, false); assert.equal(disk.jobs[0].state, "FROZEN");
});
test("owner action builder validates precision and never emits arbitrary caller-supplied calldata", async () => {
  await post("/local/reset", {});
  assert.equal((await post("/action", { action: "deposit", asset: 1, amount: "0.0000001" })).status, 400);
  assert.equal((await post("/action", { action: "deposit", asset: 1, amount: "-1" })).status, 400);
  assert.equal((await post("/action", { action: "call", to: "0x0000000000000000000000000000000000000001", data: "0xab" })).status, 400);
  const result = await post("/action", { action: "approve", asset: 1, amount: "2.5" });
  assert.equal(result.status, 200); assert.equal(result.body.transaction.to.toLowerCase(), app.fixture!.token1.toLowerCase());
  await app.fixture!.write(app.fixture!.feed0, app.fixture!.artifacts.TestFeed.abi, "set", [100000000n, 1n]);
  assert.equal((await post("/action", { action: "withdraw", asset: 0, amount: "1" })).status, 200);
});
test("stale oracle removes valuation without hiding balances, incident recovery or owner exit controls", async () => {
  await post("/local/reset", {});
  const f = app.fixture!;
  const job = (await post("/plans", {})).body.job;
  assert.equal((await post("/local/fault", { jobId: job.id })).body.job.state, "FROZEN");
  await f.write(f.feed0, f.artifacts.TestFeed.abi, "set", [100000000n, 1n]);
  const response = await fetch(`${app.origin}/api/v1/status`);
  assert.equal(response.status, 200);
  const status = await response.json() as any;
  assert.equal(status.pricing.available, false);
  assert.equal(status.portfolio, null);
  assert.equal(status.snapshot.balance0, String(80n * 10n ** 18n));
  assert.equal(status.snapshot.owner.toLowerCase(), f.owner.toLowerCase());
  await assert.rejects(() => readSnapshot(f.client, f.vault));
  assert.equal((await post("/action", { action: "pause" })).status, 200);
  assert.equal((await post("/recover", {})).status, 200);
  assert.equal((await post("/plans", {})).status, 503);
  assert.equal((await post("/action", { action: "withdraw", asset: 0, amount: "1" })).status, 200);
  await post("/local/reset", {});
  const restored = await (await fetch(`${app.origin}/api/v1/status`)).json() as any;
  assert.equal(restored.pricing.available, true);
  assert.notEqual(restored.portfolio, null);
});
test("local reset refreshes both mock oracles after long inactivity and repeated drills remain executable", async () => {
  await post("/local/reset", {});
  const f = app.fixture!;
  await f.rpc("evm_increaseTime", [7200]);
  await f.rpc("evm_mine");
  const beforeReset = await f.client.getBlock();
  await assert.rejects(() => readSnapshot(f.client, f.vault));
  for (let run = 0; run < 2; run++) {
    assert.equal((await post("/local/reset", {})).status, 200);
    const snapshot = await readSnapshot(f.client, f.vault);
    assert.equal(snapshot.balance0, 80n * 10n ** 18n);
    assert.equal(snapshot.balance1, 20n * 10n ** 6n);
    for (const feed of [f.feed0, f.feed1]) {
      const updatedAt = await f.client.readContract({ address: feed, abi: f.artifacts.TestFeed.abi, functionName: "updatedAt" });
      assert.ok((updatedAt as bigint) >= beforeReset.timestamp);
    }
    await f.rpc("evm_mine");
    const planned = await post("/plans", {});
    assert.equal(planned.body.state, "READY");
    const executed = await post("/local/execute", { jobId: planned.body.job.id });
    assert.equal(executed.body.job.state, "VERIFIED");
    assert.equal(executed.body.job.receipt.environment, "LOCAL_EVM");
    assert.equal(executed.body.job.receipt.campaignProof, false);
  }
});
test("wallet challenges bind origin, chain, vault and signer; signatures cannot be replayed and sessions expire", async () => {
  const owner = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());
  let now = Date.now();
  const sessions = new WalletSessions("http://127.0.0.1:1234", app.fixture!.vault, [owner.address], () => now);
  assert.throws(() => sessions.challenge(other.address), /owner or operator/);
  const challenge = sessions.challenge(owner.address);
  assert.match(challenge.message, /Chain: 97/); assert.ok(challenge.message.includes(app.fixture!.vault));
  const signature = await owner.signMessage({ message: challenge.message });
  const session = await sessions.exchange(challenge.nonce, signature);
  assert.equal(sessions.address(session.token), owner.address);
  await assert.rejects(() => sessions.exchange(challenge.nonce, signature), /already used/);
  const wrong = sessions.challenge(owner.address);
  const wrongSignature = await other.signMessage({ message: wrong.message });
  await assert.rejects(() => sessions.exchange(wrong.nonce, wrongSignature), /Invalid wallet signature/);
  const expired = sessions.challenge(owner.address); now += 120001;
  await assert.rejects(() => sessions.exchange(expired.nonce, signature), /expired/);
  now += 900001; assert.throws(() => sessions.address(session.token), /session required/);
});
test("journal serializes concurrent mutations and failed mutation never corrupts the last committed state", async () => {
  const store = new JobStore(join(directory, "atomic.json")); await store.load();
  await Promise.all([store.change(s => { s.frozen = true; }), store.change(s => { assert.equal(s.frozen, true); })]);
  await assert.rejects(() => store.change(s => { s.frozen = false; throw new Error("Abort"); }));
  assert.equal(store.view.frozen, true);
  const reload = new JobStore(join(directory, "atomic.json")); await reload.load(); assert.equal(reload.view.frozen, true);
});
