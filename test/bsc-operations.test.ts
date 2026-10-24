import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceBoundary, trustedHost, sameOrigin } from "../src/bsc/boundary.js";
import { claimJournal } from "../src/bsc/journal-lock.js";
import { pendingMonitor } from "../src/bsc/operations.js";
import { JobStore, type Job } from "../src/bsc/store.js";

test("public boundary requires explicit testnet HTTPS origin and ignores forwarded headers", () => {
  assert.deepEqual(serviceBoundary({ mode: "local" }), { host: "127.0.0.1", publicOrigin: undefined });
  for (const origin of ["http://agent.example", "https://user:pass@agent.example", "https://agent.example/path", "https://agent.example/?key=secret", "https://127.0.0.1", "https://localhost", "https://app.localhost"]) {
    assert.throws(() => serviceBoundary({ mode: "testnet", publicOrigin: origin }));
  }
  assert.throws(() => serviceBoundary({ mode: "local", publicOrigin: "https://agent.example" }));
  assert.throws(() => serviceBoundary({ mode: "local", listenHost: "0.0.0.0" }));
  assert.throws(() => serviceBoundary({ mode: "testnet", listenHost: "0.0.0.0" }));
  assert.deepEqual(serviceBoundary({ mode: "testnet", listenHost: "0.0.0.0", publicOrigin: "https://agent.example/" }), { host: "0.0.0.0", publicOrigin: "https://agent.example" });
  assert.equal(trustedHost({ host: "attacker.example", "x-forwarded-host": "agent.example" }, "https://agent.example"), false);
  assert.equal(trustedHost({ host: "agent.example", "x-forwarded-host": "attacker.example" }, "https://agent.example"), true);
  assert.equal(sameOrigin({ origin: "https://attacker.example", "x-forwarded-proto": "https" }, "https://agent.example"), false);
  assert.equal(sameOrigin({ origin: "https://agent.example", "sec-fetch-site": "cross-site" }, "https://agent.example"), false);
  assert.equal(sameOrigin({ origin: "https://agent.example" }, "https://agent.example"), true);
});

test("journal lease rejects a second writer and never removes a replaced lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentguard-lock-")), path = join(dir, "journal.json");
  try {
    const release = await claimJournal(path);
    await assert.rejects(() => claimJournal(path), { code: "EEXIST" });
    await release();
    const release2 = await claimJournal(path);
    const replacement = JSON.stringify({ token: "replacement" });
    await writeFile(`${path}.lock`, replacement);
    await assert.rejects(release2, /ownership changed/);
    assert.equal(await readFile(`${path}.lock`, "utf8"), replacement);
  } finally { await rm(dir, { recursive: true }); }
});

test("pending monitor coalesces scans, continues after RPC errors and reports stale transactions without creating proofs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentguard-monitor-"));
  try {
    const store = new JobStore(join(dir, "journal.json")); await store.load();
    const jobs = ["pending", "bad-rpc", "awaiting", "complete"].map((id, index) => ({
      id, state: id === "awaiting" ? "AWAITING_SIGNATURE" : id === "complete" ? "VERIFIED" : "VERIFYING",
      transactionHash: `0x${String(index).repeat(64)}`, createdAt: new Date().toISOString(),
      receipt: id === "complete" ? { state: "VERIFIED" } : undefined
    })) as Job[];
    await store.change(s => { s.jobs = jobs; });
    let now = 0, calls: string[] = [], release!: () => void;
    let barrier: Promise<void> | undefined = new Promise(resolve => { release = resolve; });
    const monitor = pendingMonitor(store, async (id, hash) => {
      calls.push(id); assert.equal(hash, jobs.find(j => j.id === id)!.transactionHash);
      if (barrier) await barrier;
      if (id === "bad-rpc") throw new Error("Secret RPC URL must never enter the report");
      return { state: "PENDING" };
    }, () => now);
    const a = monitor.run(), b = monitor.run(); assert.equal(a, b);
    release(); await a; barrier = undefined;
    assert.deepEqual(calls, ["pending", "bad-rpc"]);
    assert.equal(monitor.summary().errorCount, 1);
    assert.equal(monitor.summary().stalePending.length, 0);
    now = 600001; calls = []; await monitor.run();
    assert.equal(monitor.summary().stalePending.length, 2);
    assert.equal(store.view.jobs[0].receipt, undefined);
    assert.equal(store.view.frozen, false);
    assert.equal(JSON.stringify(monitor.summary()).includes("Secret"), false);
    await store.change(s => { s.jobs = s.jobs.filter(j => j.id !== "bad-rpc"); });
    await monitor.run(); assert.equal(monitor.summary().errorCount, 0);
    assert.equal(monitor.summary().pending, 1);
  } finally { await rm(dir, { recursive: true }); }
});
