import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { type PublicClient, type Hash } from "viem";
import { startLocalFixture, type LocalFixture } from "../src/bsc/local.js";
import { deploymentData, parseDeploymentConfig, prepareDeployment, testnetClients, verifyDeployment, type DeploymentConfig } from "../src/bsc/deployment.js";

let f: LocalFixture, config: DeploymentConfig;
before(async () => {
  f = await startLocalFixture();
  config = parseDeploymentConfig({ owner: f.owner, operator: f.operator, token0: f.token0, token1: f.token1,
    router: f.router, feed0: f.feed0, feed1: f.feed1, policy: { ...f.policy, maxActionUsd: "10", maxDailyUsd: "25" } });
});
after(async () => { await f?.close(); });
async function deploy() {
  const hash = await f.wallet.sendTransaction({ account: f.owner, data: deploymentData(config) });
  const receipt = await f.wait(hash); return { hash, receipt };
}
function override(methods: Record<string, unknown>): PublicClient { return new Proxy(f.client, {
  get(target, key) { return Object.hasOwn(methods, key) ? methods[key as string] : Reflect.get(target, key); }
}); }

test("deployment config rejects ambiguous precision, invalid policy, identical assets and non-origin service URLs", () => {
  const raw = { ...config, policy: { ...config.policy, maxActionUsd: "10", maxDailyUsd: "25" } };
  for (const policy of [{ maxActionUsd: "1e3" }, { maxActionUsd: "0.0000000000000000001" }, { maxDailyUsd: "1" },
    { maxSlippageBps: 501 }, { targetToken0Bps: 0 }, { cooldownSeconds: 0.5 }, { maxOracleAge: 0 }]) {
    assert.throws(() => parseDeploymentConfig({ ...raw, policy: { ...raw.policy, ...policy } }));
  }
  assert.throws(() => parseDeploymentConfig({ ...raw, token1: raw.token0 }));
  assert.throws(() => parseDeploymentConfig({ ...raw, owner: "0x0000000000000000000000000000000000000000" }));
  for (const publicBaseUrl of ["http://service.example", "https://service.example/path", "https://user:pass@service.example"])
    assert.throws(() => parseDeploymentConfig({ ...raw, publicBaseUrl }));
  assert.equal(parseDeploymentConfig({ ...raw, publicBaseUrl: "https://service.example/" }).publicBaseUrl, "https://service.example");
});
test("deployment preparation simulates constructor without sending transactions or accepting the wrong chain", async () => {
  const before = await f.client.getTransactionCount({ address: f.owner });
  const prepared = await prepareDeployment(f.client, config, 31337);
  assert.equal(prepared.transaction.data, deploymentData(config));
  assert.equal(prepared.transaction.from, config.owner); assert.equal(prepared.transaction.value, "0x0");
  assert.equal(prepared.environment, "LOCAL_EVM"); assert.equal(prepared.campaignProof, false);
  assert.equal(await f.client.getTransactionCount({ address: f.owner }), before);
  await assert.rejects(() => prepareDeployment(f.client, config));
  await assert.rejects(() => prepareDeployment(f.client, { ...config, router: f.stranger }, 31337));
});
test("deployment attestation matches real runtime including immutables and the initial policy at its historical block", async () => {
  const { hash, receipt } = await deploy();
  await f.write(receipt.contractAddress!, f.artifacts.AgentGuardVault.abi, "setPolicy", [{ ...config.policy, maxActionUsd: 1n }]);
  const proof = await verifyDeployment(f.client, config, hash, 31337);
  assert.equal(proof.state, "VERIFIED");
  if (proof.state !== "VERIFIED") throw new Error(JSON.stringify(proof));
  assert.ok(Object.values(proof.checks).every(Boolean));
  assert.equal(proof.contractAddress?.toLowerCase(), receipt.contractAddress?.toLowerCase());
  assert.equal(proof.campaignProof, false); assert.match(proof.evidenceHash, /^sha256:[0-9a-f]{64}$/);
});
test("one-confirmation and unknown deployments remain pending, never verified", async () => {
  const { hash } = await deploy();
  assert.equal((await verifyDeployment(f.client, config, hash, 31337)).state, "PENDING");
  assert.equal((await verifyDeployment(f.client, config, `0x${"99".repeat(32)}`, 31337)).state, "PENDING");
  await f.rpc("evm_mine");
  assert.equal((await verifyDeployment(f.client, config, hash, 31337)).state, "VERIFIED");
});
test("different owner, operator or budget cannot be attested against the same deployment", async () => {
  const { hash } = await deploy(); await f.rpc("evm_mine");
  for (const changed of [{ ...config, owner: f.stranger }, { ...config, operator: f.stranger },
    { ...config, policy: { ...config.policy, maxDailyUsd: config.policy.maxDailyUsd + 1n } }]) {
    const proof = await verifyDeployment(f.client, changed, hash, 31337);
    assert.equal(proof.state, "MISMATCH");
    if (proof.state === "MISMATCH") assert.equal(proof.checks.exactInitCode, false);
  }
});
test("an unrelated owner transaction is rejected as deployment evidence", async () => {
  const hash = await f.write(f.vault, f.artifacts.AgentGuardVault.abi, "setPaused", [false]); await f.rpc("evm_mine");
  const proof = await verifyDeployment(f.client, config, hash, 31337);
  assert.equal(proof.state, "MISMATCH");
  if (proof.state === "MISMATCH") { assert.equal(proof.checks.contractCreation, false); assert.equal(proof.checks.runtimeMatches, false); }
});
test("runtime mismatch and reorg during verification fail attestation", async () => {
  const { hash } = await deploy(); await f.rpc("evm_mine");
  const wrongCode = await verifyDeployment(override({ getCode: async () => "0x00" }), config, hash, 31337);
  assert.equal(wrongCode.state, "MISMATCH");
  if (wrongCode.state === "MISMATCH") assert.equal(wrongCode.checks.runtimeMatches, false);
  let reads = 0;
  const reorg = await verifyDeployment(override({ getBlock: async (args: any) => {
    const block = await f.client.getBlock(args); return ++reads > 1 ? { ...block, hash: `0x${"ff".repeat(32)}` as Hash } : block;
  } }), config, hash, 31337);
  assert.equal(reorg.state, "MISMATCH");
  if (reorg.state === "MISMATCH") assert.equal(reorg.checks.canonical, false);
});
test("RPC failures, wrong-chain verification and shared-provider setup cannot produce success", async () => {
  const hash = `0x${"ab".repeat(32)}` as Hash;
  await assert.rejects(() => verifyDeployment(override({ getTransactionReceipt: async () => { throw new Error("RPC offline"); } }), config, hash, 31337), /RPC offline/);
  await assert.rejects(() => verifyDeployment(f.client, config, hash), /Wrong verification chain/);
  await assert.rejects(() => testnetClients("https://rpc.example/a", "https://rpc.example/b"), /different RPC/);
  await assert.rejects(() => testnetClients("http://rpc.example", "https://other.example"), /HTTPS/);
});
