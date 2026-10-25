import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { DependencyScanner } from "../src/bsc/dependency-scan.js";
import { failedDependencyReport, saveDependencyReport } from "../src/bsc/dependency-report.js";

function report(now: number) {
  return { schemaVersion: 2, state: "CANDIDATES_INSPECTED", checkedAt: new Date(now).toISOString(),
    chainId: 97, environment: "BSC_TESTNET", blockNumber: "123", recent: true, matchingReads: true, canonical: true,
    campaignProof: false, financialTransactionCreated: false, deploymentReady: false,
    policy: { maxActionUsd: "10000000000000000000", maxSlippageBps: 100, maxOracleAgeSeconds: "3600" },
    primary: { complete: true, timestamp: String(Math.floor(now / 1000)), router: { matchesPublishedAddresses: true },
      rounds: [], assets: [], routes: [{ compatibleCandidate: true }] } };
}
test("read-only jobs are single-flight, keep durable summaries, enforce cooldown, and replace success on failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentguard-scan-"));
  let now = Date.now(), calls = 0, release!: () => void;
  const scanner = new DependencyScanner({ enabled: true, path: join(directory, "scan.json"), now: () => now,
    run: async () => { calls++; if (calls > 1) throw new Error("https://rpc.invalid/private-key");
      await new Promise<void>(resolve => { release = resolve; }); return report(now); } });
  try {
    assert.equal(scanner.start().code, 202);
    assert.equal(scanner.start().code, 202);
    assert.equal(scanner.status().state, "RUNNING"); assert.equal(calls, 1);
    release(); await scanner.idle();
    assert.equal(scanner.status().state, "SUCCEEDED");
    const summary = await scanner.summary();
    assert.equal(summary.state, "REVIEW_REQUIRED");
    assert.equal(summary.deploymentReady, false); assert.equal(summary.scan.financialTransactionCreated, false);
    assert.equal(JSON.parse(await readFile(join(directory, "scan.json"), "utf8")).blockNumber, "123");
    assert.equal((await stat(join(directory, "scan.json"))).mode & 0o777, 0o600);
    assert.equal(scanner.start().code, 429);
    now += 60001;
    assert.equal(scanner.start().code, 202); await scanner.idle();
    assert.equal(calls, 2); assert.equal(scanner.status().state, "FAILED");
    assert.equal((await scanner.summary()).state, "UNAVAILABLE");
    assert.equal(JSON.parse(await readFile(join(directory, "scan.json"), "utf8")).state, "RPC_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(await scanner.summary()), /private-key|rpc\.invalid/);
  } finally { await scanner.close(); await rm(directory, { recursive: true }); }
});
test("disabled and closed scanners never invoke RPC work", async () => {
  let calls = 0;
  const scanner = new DependencyScanner({ enabled: false, path: "unused", run: async () => { calls++; } });
  assert.equal(scanner.start().code, 403);
  await scanner.close();
  assert.equal(scanner.status().enabled, false); assert.equal(calls, 0);
  const closed = new DependencyScanner({ enabled: true, path: "unused", run: async () => { calls++; } });
  await closed.close();
  assert.equal(closed.start().code, 403); assert.equal(calls, 0);
});
test("timeout aborts the probe and shutdown waits for cleanup without leaving stale success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentguard-abort-"));
  let aborted = 0;
  const scanner = new DependencyScanner({ enabled: true, path: join(directory, "scan.json"), cooldownMs: 0, timeoutMs: 15,
    run: signal => new Promise((_, reject) => {
      signal.addEventListener("abort", () => { aborted++; reject(new Error("private transport message")); }, { once: true });
    }) });
  try {
    scanner.start(); await scanner.idle();
    assert.equal(aborted, 1); assert.equal(scanner.status().state, "FAILED");
    scanner.start(); await scanner.close();
    assert.equal(aborted, 2); assert.equal(scanner.status().enabled, false);
    assert.equal((await scanner.summary()).state, "UNAVAILABLE");
  } finally { await scanner.close(); await rm(directory, { recursive: true }); }
});
test("unwritable report storage cannot resurrect a prior success in the API", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentguard-disk-")), file = join(directory, "not-a-directory");
  await writeFile(file, "occupied");
  const scanner = new DependencyScanner({ enabled: true, path: join(file, "scan.json"), run: async () => report(Date.now()) });
  try {
    scanner.start(); await scanner.idle();
    assert.equal(scanner.status().state, "FAILED"); assert.equal((await scanner.summary()).state, "UNAVAILABLE");
  } finally { await scanner.close(); await rm(directory, { recursive: true }); }
});
test("shared report storage repairs old permissions, preserves complete JSON on failure, and removes temporary files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentguard-report-")), path = join(directory, "scan.json");
  try {
    const original = report(Date.now());
    await writeFile(path, JSON.stringify(original));
    await chmod(path, 0o644);
    await saveDependencyReport(path, original);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const cyclic: any = {}; cyclic.self = cyclic;
    await assert.rejects(saveDependencyReport(path, cyclic));
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), original);
    await saveDependencyReport(path, failedDependencyReport());
    assert.equal(JSON.parse(await readFile(path, "utf8")).state, "RPC_UNAVAILABLE");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ["scan.json"]);
  } finally { await rm(directory, { recursive: true }); }
});
test("interrupting the terminal entrypoint aborts pending RPC and replaces an old successful report", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentguard-cli-")), path = join(directory, ".runtime", "bsc-dependencies.json");
  await saveDependencyReport(path, report(Date.now()));
  // An IPC handshake makes cancellation deterministic, with no network access.
  const bootstrap = `globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    const signal = options.signal;
    if (signal.aborted) { reject(new Error("private endpoint detail")); return; }
    signal.addEventListener("abort", () => reject(new Error("private endpoint detail")), { once: true });
    process.send("waiting");
  });`;
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"),
    "--import", `data:text/javascript,${encodeURIComponent(bootstrap)}`,
    fileURLToPath(new URL("../src/bsc/dependency-probe.ts", import.meta.url))], {
    cwd: directory, env: { ...process.env, BSC_TESTNET_RPC_URL: "https://primary.invalid/private-key",
      BSC_VERIFIER_RPC_URL: "https://secondary.invalid/private-key" }, stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout!.on("data", data => { output += data; });
  child.stderr!.on("data", data => { output += data; });
  const exited = once(child, "exit");
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    const started = once(child, "message");
    await Promise.race([started, exited.then(() => { throw new Error(`CLI exited before RPC handshake: ${output}`); })]);
    child.kill("SIGINT");
    const [code, signal] = await exited;
    assert.equal(code, 1); assert.equal(signal, null);
    assert.equal(JSON.parse(await readFile(path, "utf8")).state, "RPC_UNAVAILABLE");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(join(directory, ".runtime")), ["bsc-dependencies.json"]);
    assert.doesNotMatch(output, /private-key|private endpoint detail|primary\.invalid/);
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    await rm(directory, { recursive: true });
  }
});
