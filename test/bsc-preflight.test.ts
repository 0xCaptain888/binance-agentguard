import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { type PublicClient, type Hash } from "viem";
import { startLocalFixture, type LocalFixture } from "../src/bsc/local.js";
import { parseDeploymentConfig, type DeploymentConfig } from "../src/bsc/deployment.js";
import { inspectLocalConfiguration } from "../src/bsc/doctor.js";
import { deploymentPreflight, inspectDeployment } from "../src/bsc/preflight.js";

let f: LocalFixture, config: DeploymentConfig, raw: Record<string, unknown>;
const endpoints = { BSC_TESTNET_RPC_URL: "https://primary.invalid/private-key", BSC_VERIFIER_RPC_URL: "https://independent.invalid/other-secret" };
before(async () => {
  f = await startLocalFixture();
  raw = { owner: f.owner, operator: f.operator, token0: f.token0, token1: f.token1, router: f.router,
    feed0: f.feed0, feed1: f.feed1, policy: { ...f.policy, maxActionUsd: "10", maxDailyUsd: "25" } };
  config = parseDeploymentConfig(raw);
});
after(async () => { await f?.close(); });
function override(methods: Record<string, unknown>): PublicClient {
  return new Proxy(f.client, { get(target, key) { return Object.hasOwn(methods, key) ? methods[key as string] : Reflect.get(target, key); } });
}
async function isolated(action: () => Promise<void>) {
  const snapshot = await f.rpc("evm_snapshot");
  try { await action(); } finally { await f.rpc("evm_revert", [snapshot]); }
}

test("offline doctor identifies missing public fields and RPCs without echoing credentials", () => {
  const missing = inspectLocalConfiguration(undefined, {});
  assert.equal(missing.state, "BLOCKED"); assert.equal(missing.issues.length, 9);
  const invalid = inspectLocalConfiguration({ ...raw, owner: "private-key-do-not-print" }, {
    BSC_TESTNET_RPC_URL: "private-key-do-not-print", BSC_VERIFIER_RPC_URL: "http://private-key-do-not-print" });
  assert.equal(invalid.state, "BLOCKED"); assert.doesNotMatch(JSON.stringify(invalid), /private-key-do-not-print/);
  assert.equal(invalid.financialTransactionCreated, false);
});
test("offline doctor rejects shared providers and malformed policy without implying chain readiness", () => {
  const ready = inspectLocalConfiguration(raw, endpoints);
  assert.equal(ready.state, "CONFIGURED_NOT_CHAIN_VERIFIED"); assert.equal(ready.campaignProof, false);
  const shared = inspectLocalConfiguration(raw, { ...endpoints, BSC_VERIFIER_RPC_URL: "https://primary.invalid/different-key" });
  assert.ok(shared.issues.some(i => i.field === "independent_rpc"));
  assert.doesNotMatch(JSON.stringify(shared), /different-key|private-key|other-secret/);
  assert.equal(inspectLocalConfiguration({ ...raw, policy: {} }, endpoints).state, "BLOCKED");
});
test("real local EVM preflight checks both directions and constructor gas without creating a transaction", async () => {
  const nonce = await f.client.getTransactionCount({ address: f.owner });
  const report = await deploymentPreflight(f.client, f.client, config, 31337);
  assert.equal(report.state, "READY", JSON.stringify(report.primary.checks));
  assert.equal(report.primary.environment, "LOCAL_EVM"); assert.equal(report.campaignProof, false);
  assert.equal(report.financialTransactionCreated, false); assert.ok(report.primary.gas.estimate! > 0n);
  assert.ok(report.primary.checks.some(c => c.name === "route_0_quote" && c.passed));
  assert.ok(report.primary.checks.some(c => c.name === "route_1_quote" && c.passed));
  assert.equal(await f.client.getTransactionCount({ address: f.owner }), nonce);
});
test("stale, negative and future oracle answers block readiness without substituting prices", async () => {
  for (const kind of ["stale", "negative", "future"]) await isolated(async () => {
    const block = await f.client.getBlock();
    await f.write(f.feed0, f.artifacts.TestFeed.abi, "set", [kind === "negative" ? -1n : 100000000n,
      kind === "stale" ? 1n : kind === "future" ? block.timestamp + 10000n : block.timestamp]);
    const report = await inspectDeployment(f.client, config, 31337);
    assert.equal(report.state, "BLOCKED"); assert.equal(report.checks.find(c => c.name === "asset0_price")?.passed, false);
    assert.equal(report.checks.find(c => c.name === "route_prerequisites")?.passed, false);
  });
});
test("route below the oracle floor blocks both directions even with a valid constructor", async () => isolated(async () => {
  await f.write(f.router, f.artifacts.TestRouter.abi, "setOutputBps", [9000n]);
  const report = await inspectDeployment(f.client, config, 31337);
  assert.equal(report.state, "BLOCKED");
  assert.equal(report.checks.find(c => c.name === "route_0_quote")?.passed, false);
  assert.equal(report.checks.find(c => c.name === "route_1_quote")?.passed, false);
}));
test("unfunded owners and unsupported contract-wallet owners cannot pass preflight", async () => {
  const unfunded = await inspectDeployment(f.client, { ...config, owner: "0x0000000000000000000000000000000000001234" }, 31337);
  assert.equal(unfunded.state, "BLOCKED"); assert.equal(unfunded.checks.find(c => c.name === "owner_test_gas")?.passed, false);
  assert.equal(unfunded.checks.find(c => c.name === "deployment_gas")?.passed, false);
  const contract = await inspectDeployment(f.client, { ...config, owner: f.router }, 31337);
  assert.equal(contract.checks.find(c => c.name === "owner_wallet")?.passed, false);
});
test("disagreeing provider facts or canonical block hashes never produce READY", async () => {
  const mismatch = await deploymentPreflight(f.client, override({ getBalance: async (args: any) => (await f.client.getBalance(args)) - 1n }), config, 31337);
  assert.equal(mismatch.state, "BLOCKED"); assert.equal(mismatch.matchingReads, false);
  const otherFork = override({ getBlock: async (args: any) => ({ ...await f.client.getBlock(args), hash: `0x${"ff".repeat(32)}` as Hash }) });
  const fork = await deploymentPreflight(f.client, otherFork, config, 31337);
  assert.equal(fork.state, "BLOCKED"); assert.equal(fork.sameBlock, false);
  let reads = 0;
  const reorg = override({ getBlock: async (args: any) => {
    const b = await f.client.getBlock(args); return ++reads >= 3 ? { ...b, hash: `0x${"ee".repeat(32)}` as Hash } : b;
  } });
  assert.equal((await deploymentPreflight(reorg, f.client, config, 31337)).stillCanonical, false);
});
test("wrong chain, old chain heads and RPC outages fail closed", async () => {
  await assert.rejects(() => inspectDeployment(f.client, config), /Wrong preflight chain/);
  const old = await inspectDeployment(override({ getBlock: async (args: any) => ({ ...await f.client.getBlock(args), timestamp: 1n }) }), config, 31337);
  assert.equal(old.state, "BLOCKED"); assert.equal(old.checks.find(c => c.name === "recent_block")?.passed, false);
  await assert.rejects(() => deploymentPreflight(f.client, override({ getBlock: async () => { throw new Error("RPC unavailable"); } }), config, 31337), /RPC unavailable/);
});
