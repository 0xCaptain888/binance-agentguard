import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { getContractAddress, parseUnits, type Address, type PublicClient, type Hash } from "viem";
import { controlledFixture, type ControlledFixture } from "./support/controlled-fixture.js";
import { assertControlledRetryNonce, controlledOwner, controlledAbi, controlledDeploymentData, prepareControlledEnvironment,
  reconcileControlledPreparations, verifyControlledEnvironment, controlledVaultConfig, dependencyDisclosure,
  prepareControlledRefresh, verifyControlledRefresh } from "../src/bsc/controlled.js";
import { expectedRuntimeCode } from "../src/bsc/compiler.js";
import { deploymentData, parseDeploymentConfig, verifyDeployment } from "../src/bsc/deployment.js";
import { deploymentPreflight } from "../src/bsc/preflight.js";
import { json, planFromChain, verifyExecution } from "../src/bsc/rebalancer.js";

let f: ControlledFixture;
before(async () => { f = await controlledFixture(); });
after(async () => { await f?.close(); });
const override = (methods: Record<string, unknown>): PublicClient => new Proxy(f.client, {
  get(target, key) { return Object.hasOwn(methods, key) ? methods[key as string] : Reflect.get(target, key); }
});
test("controlled preparation is chain-97-only, recent, funded and never broadcasts", async () => {
  const nonce = await f.client.getTransactionCount({ address: f.owner });
  const prepared = await prepareControlledEnvironment(f.client, f.owner);
  assert.equal(prepared.transaction.data, controlledDeploymentData(f.owner));
  assert.equal(prepared.transaction.value, "0x0"); assert.equal(prepared.transaction.chainId, "0x61");
  assert.equal(prepared.transaction.type, "0x0");
  assert.equal(BigInt(prepared.transaction.gas), prepared.gas.limit);
  assert.equal(BigInt(prepared.transaction.gasPrice), prepared.gas.gasPrice);
  assert.equal(prepared.gas.bufferedCost, prepared.gas.limit * prepared.gas.gasPrice);
  assert.equal(prepared.initCodeBytes, (prepared.transaction.data.length - 2) / 2);
  assert.equal(prepared.dependencyMode, "CONTROLLED_TEST_ASSETS"); assert.equal(prepared.marketEvidence, false);
  assert.equal(await f.client.getTransactionCount({ address: f.owner }), nonce);
  assert.throws(() => controlledOwner("0x0000000000000000000000000000000000000000"));
  await assert.rejects(() => prepareControlledEnvironment(override({ getChainId: async () => 56 }), f.owner), /97 only/);
  await assert.rejects(() => prepareControlledEnvironment(override({ getBalance: async () => 0n }), f.owner), /Insufficient/);
  await assert.rejects(() => prepareControlledEnvironment(override({ getGasPrice: async () => 0n }), f.owner), /Insufficient/);
  await assert.rejects(() => prepareControlledEnvironment(override({ estimateGas: async () => (await f.client.getBlock()).gasLimit }), f.owner), /block gas limit/);
  await assert.rejects(() => prepareControlledEnvironment(override({ getCode: async () => "0x01" }), f.owner), /EOA/);
  await assert.rejects(() => prepareControlledEnvironment(override({ getBlock: async () => ({ number: 1n, hash: "0x01", timestamp: 1n }) }), f.owner), /Recent/);
  await assert.rejects(() => prepareControlledEnvironment(f.client, f.owner, prepared.blockNumber + 1n));
  await assert.rejects(() => prepareControlledEnvironment(override({
    getBlock: async () => f.client.getBlock({ blockNumber: prepared.blockNumber })
  }), f.owner, prepared.blockNumber + 1n), /anchor block mismatch/);
});
test("independent preparation requires one anchor, matching balance and gas estimate, and buffers the higher gas price", async () => {
  const primary = await prepareControlledEnvironment(f.client, f.owner);
  const independent = await prepareControlledEnvironment(f.client, f.owner, primary.blockNumber);
  const maxGasPrice = primary.gas.gasPrice + 1n;
  const withPrice = (gasPrice: bigint) => ({ ...independent,
    gas: { ...independent.gas, gasPrice, bufferedCost: independent.gas.limit * gasPrice },
    transaction: { ...independent.transaction, gasPrice: `0x${gasPrice.toString(16)}` }
  });
  const reconciled = reconcileControlledPreparations(primary, withPrice(maxGasPrice));
  assert.equal(reconciled.independentChecked, true);
  assert.equal(reconciled.gas.gasPrice, maxGasPrice);
  assert.equal(reconciled.gas.bufferedCost, primary.gas.limit * maxGasPrice);
  assert.equal(BigInt(reconciled.transaction.gasPrice), maxGasPrice);
  assert.throws(() => reconcileControlledPreparations(primary, { ...independent, blockHash: `0x${"ab".repeat(32)}` as Hash }), /disagrees/);
  assert.throws(() => reconcileControlledPreparations(primary, {
    ...independent, gas: { ...independent.gas, ownerBalance: independent.gas.ownerBalance + 1n }
  }), /disagrees/);
  assert.throws(() => reconcileControlledPreparations(primary, {
    ...independent, gas: { ...independent.gas, estimate: independent.gas.estimate + 1n }
  }), /disagrees/);
  assert.throws(() => reconcileControlledPreparations(primary, withPrice(primary.gas.ownerBalance)), /exceeds/);
  assert.throws(() => reconcileControlledPreparations(primary, {
    ...independent, transaction: { ...independent.transaction, gasPrice: "0x0" }
  }), /disagrees/);
  assert.throws(() => reconcileControlledPreparations(primary, {
    ...independent, transaction: { ...independent.transaction, gas: "0x1" }
  }), /disagrees/);
});
test("the exact prepared legacy deployment envelope mines and independently verifies on an isolated chain", async () => {
  const primary = await prepareControlledEnvironment(f.client, f.owner);
  const independent = await prepareControlledEnvironment(f.client, f.owner, primary.blockNumber);
  const prepared = reconcileControlledPreparations(primary, independent);
  const nonce = await f.client.getTransactionCount({ address: f.owner, blockTag: "pending" });
  const hash = await f.rpc("eth_sendTransaction", [{ ...prepared.transaction, nonce: `0x${nonce.toString(16)}` }]) as Hash;
  const receipt = await f.wait(hash); assert.equal(receipt.status, "success");
  await f.rpc("evm_mine");
  const tx = await f.client.getTransaction({ hash });
  assert.equal(tx.type, "legacy");
  assert.equal(tx.gasPrice, prepared.gas.gasPrice); assert.equal(tx.gas, prepared.gas.limit);
  assert.equal((await verifyControlledEnvironment(f.client, f.client, f.owner, hash, nonce)).state, "VERIFIED");
});
test("same-nonce recovery checks latest and pending on both RPCs without broadcasting", async () => {
  const nonce = await f.client.getTransactionCount({ address: f.owner, blockTag: "pending" });
  await assertControlledRetryNonce(f.client, f.client, f.owner, nonce);
  await assert.rejects(() => assertControlledRetryNonce(f.client, f.client, f.owner, -1), /Valid saved/);
  await assert.rejects(() => assertControlledRetryNonce(f.client, f.client, f.owner, nonce + 1), /Saved nonce/);
  await assert.rejects(() => assertControlledRetryNonce(f.client, override({ getChainId: async () => 56 }), f.owner, nonce), /97 only/);
  for (const tag of ["latest", "pending"]) {
    const advanced = override({ getTransactionCount: async ({ blockTag }: any) => blockTag === tag ? nonce + 1 : nonce });
    await assert.rejects(() => assertControlledRetryNonce(f.client, advanced, f.owner, nonce), /Saved nonce/);
    await assert.rejects(() => assertControlledRetryNonce(advanced, f.client, f.owner, nonce), /Saved nonce/);
  }
  await assert.rejects(() => assertControlledRetryNonce(f.client, override({ getTransactionCount: async () => undefined }), f.owner, nonce), /Saved nonce/);
  await assert.rejects(() => assertControlledRetryNonce(f.client, override({ getTransactionCount: async () => { throw new Error("Unavailable"); } }), f.owner, nonce), /Unavailable/);
  assert.equal(await f.client.getTransactionCount({ address: f.owner, blockTag: "pending" }), nonce);
});
test("real creation attests exact immutable runtime and all five deterministic child addresses", async () => {
  const { hash, address } = await f.deploy(); await f.rpc("evm_mine");
  // Constructor replay uses the creator's post-deployment nonce. Attestation must not rely on it.
  const noReplay = override({ call: async () => { throw new Error("Do not replay factory creation"); } });
  const proof = await verifyControlledEnvironment(noReplay, f.client, f.owner, hash);
  assert.equal(proof.state, "VERIFIED", json(proof));
  assert.ok(proof.primary.state !== "PENDING");
  assert.ok(Object.values(proof.primary.checks).every(Boolean));
  assert.equal(proof.primary.dependencies?.router.toLowerCase(), getContractAddress({ from: address, nonce: 1n }).toLowerCase());
  assert.equal(proof.primary.dependencies?.feed1.toLowerCase(), getContractAddress({ from: address, nonce: 5n }).toLowerCase());
  assert.match(proof.evidenceHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(proof.campaignProof, false); assert.equal(proof.marketEvidence, false);
  const tx = await f.client.getTransaction({ hash });
  assert.equal((await verifyControlledEnvironment(f.client, f.client, f.owner, hash, tx.nonce)).state, "VERIFIED");
  const wrongNonce = await verifyControlledEnvironment(f.client, f.client, f.owner, hash, tx.nonce + 1);
  assert.equal(wrongNonce.state, "MISMATCH");
  assert.equal(wrongNonce.primary.checks?.requestNonce, false);
  assert.throws(() => expectedRuntimeCode(f.artifacts.ControlledEnvironment, {}), /Missing expected immutable/);
  const raw = controlledVaultConfig(proof, f.owner, "OWNER_MANUAL");
  assert.equal(raw.operator, raw.owner); assert.equal(raw.executionMode, "OWNER_MANUAL");
  assert.throws(() => controlledVaultConfig(proof, f.owner, "DELEGATED"), /labelled honestly/);
  assert.throws(() => controlledVaultConfig(proof, f.operator, "OWNER_MANUAL"), /labelled honestly/);
  assert.equal(controlledVaultConfig(proof, f.operator, "DELEGATED").operator, f.operator);
  assert.throws(() => controlledVaultConfig(proof, f.owner, undefined), /Explicit/);
  const disclosure = await dependencyDisclosure(f.client, raw.router, 97);
  assert.equal(disclosure.dependencyMode, "CONTROLLED_TEST_ASSETS");
});
test("unknown, one-confirmation, mismatched owner, bad runtime, child substitution and reorg cannot pass", async () => {
  const { hash } = await f.deploy();
  assert.equal((await verifyControlledEnvironment(f.client, f.client, f.owner, hash)).state, "PENDING");
  assert.equal((await verifyControlledEnvironment(f.client, f.client, f.owner, `0x${"ab".repeat(32)}`)).state, "PENDING");
  await f.rpc("evm_mine");
  const good = await verifyControlledEnvironment(f.client, f.client, f.owner, hash);
  assert.equal((await verifyControlledEnvironment(f.client, f.client, f.stranger, hash)).state, "MISMATCH");
  assert.throws(() => controlledVaultConfig({ ...good, state: "PENDING" }, f.owner, "OWNER_MANUAL"));
  const wrongRuntime = override({ getCode: async () => "0x00" });
  assert.equal((await verifyControlledEnvironment(f.client, wrongRuntime, f.owner, hash)).state, "MISMATCH");
  const badChild = override({ readContract: async (args: any) => args.functionName === "token0" && args.abi === controlledAbi ?
    f.stranger : f.client.readContract(args) });
  assert.equal((await verifyControlledEnvironment(f.client, badChild, f.owner, hash)).state, "MISMATCH");
  const childCode = override({ getCode: async (args: any) => args.address.toLowerCase() === good.primary.contractAddress?.toLowerCase() ?
    f.client.getCode(args) : "0x00" });
  assert.equal((await verifyControlledEnvironment(f.client, childCode, f.owner, hash)).state, "MISMATCH");
  const tx = await f.client.getTransaction({ hash });
  const wrongTxHash = override({ getTransaction: async () => ({ ...tx, hash: `0x${"aa".repeat(32)}` }) });
  const wrongTxProof = await verifyControlledEnvironment(f.client, wrongTxHash, f.owner, hash);
  assert.equal(wrongTxProof.state, "MISMATCH");
  assert.equal(wrongTxProof.independent.checks?.transactionBound, false);
  let heads = 0;
  const lostConfirmation = override({ getBlockNumber: async () => ++heads === 1 ?
    f.client.getBlockNumber({ cacheTime: 0 }) : tx.blockNumber! });
  const regressedProof = await verifyControlledEnvironment(f.client, lostConfirmation, f.owner, hash);
  assert.equal(regressedProof.state, "MISMATCH"); assert.equal(regressedProof.canonical, false);
  let reads = 0;
  const reorg = override({ getBlock: async (args: any) => {
    const block = await f.client.getBlock(args); return ++reads > 1 ? { ...block, hash: `0x${"ff".repeat(32)}` as Hash } : block;
  } });
  assert.equal((await verifyControlledEnvironment(f.client, reorg, f.owner, hash)).state, "MISMATCH");
  await assert.rejects(() => verifyControlledEnvironment(f.client, override({ getTransactionReceipt: async () => { throw new Error("RPC unavailable"); } }), f.owner, hash), /RPC unavailable/);
  await assert.rejects(() => verifyControlledEnvironment(f.client, f.client, f.owner, hash, -1), /valid optional request nonce/);
});
test("controlled feeds require owner refresh; router enforces pair, reserve, deadline and slippage", async () => {
  const { hash } = await f.deploy(); await f.rpc("evm_mine");
  const proof = await verifyControlledEnvironment(f.client, f.client, f.owner, hash);
  const raw = controlledVaultConfig(proof, f.owner, "OWNER_MANUAL"), a = f.artifacts;
  await assert.rejects(() => f.write(raw.feed0, a.ControlledFeed.abi, "refresh", [], f.stranger));
  await f.write(raw.feed0, a.ControlledFeed.abi, "refresh");
  assert.equal((await f.client.readContract({ address: raw.feed0, abi: a.ControlledFeed.abi, functionName: "latestRoundData" }) as bigint[])[0], 2n);
  for (const [amount, path] of [[1n, [raw.token0, raw.token1]], [parseUnits("10001", 18), [raw.token0, raw.token1]],
    [parseUnits("1", 18), [raw.token0, f.stranger]] ] as const) {
    await assert.rejects(() => f.client.readContract({ address: raw.router, abi: a.ControlledRouter.abi, functionName: "getAmountsOut", args: [amount, path] }));
  }
  await assert.rejects(() => f.write(raw.router, a.ControlledRouter.abi, "initialize", [raw.token0, raw.token1]));
  const timestamp = (await f.client.getBlock()).timestamp;
  await assert.rejects(() => f.write(raw.router, a.ControlledRouter.abi, "swapExactTokensForTokens", [parseUnits("1", 18), 0n, [raw.token0, raw.token1], f.owner, timestamp - 1n]));
  await assert.rejects(() => f.write(raw.router, a.ControlledRouter.abi, "swapExactTokensForTokens", [parseUnits("1", 18), parseUnits("2", 6), [raw.token0, raw.token1], f.owner, timestamp + 100n]));
});
test("controlled environment supports a real bounded vault swap with independent receipt checks and stale-feed blocking", async () => {
  const { hash } = await f.deploy(); await f.rpc("evm_mine");
  const proof = await verifyControlledEnvironment(f.client, f.client, f.owner, hash);
  const raw = controlledVaultConfig(proof, f.owner, "OWNER_MANUAL"), config = parseDeploymentConfig(raw), a = f.artifacts;
  assert.equal((await deploymentPreflight(f.client, f.client, config)).state, "READY");
  const vaultHash = await f.wallet.sendTransaction({ account: f.owner, data: deploymentData(config) });
  const receipt = await f.wait(vaultHash), vault = receipt.contractAddress as Address;
  await f.rpc("evm_mine");
  assert.equal((await verifyDeployment(f.client, config, vaultHash)).state, "VERIFIED");
  for (const [token, amount, side] of [[raw.token0, parseUnits("80", 18), true], [raw.token1, parseUnits("20", 6), false]] as const) {
    await f.write(token, a.ControlledToken.abi, "approve", [vault, amount]);
    await f.write(vault, a.AgentGuardVault.abi, "deposit", [side, amount]);
  }
  const { decision } = await planFromChain(f.client, vault);
  assert.equal(decision.state, "READY"); if (decision.state !== "READY") throw new Error(json(decision));
  const estimate = await f.client.estimateGas({ account: f.owner, to: vault, data: decision.plan.data });
  const swap = await f.wallet.sendTransaction({ account: f.owner, to: vault, data: decision.plan.data, gas: estimate * 120n / 100n });
  await f.wait(swap); await f.rpc("evm_mine");
  assert.equal((await verifyExecution(f.client, decision.plan, swap)).state, "VERIFIED");
  const checkpoint = await f.rpc("evm_snapshot");
  try {
    await f.rpc("evm_increaseTime", [3601]); await f.rpc("evm_mine");
    await assert.rejects(() => planFromChain(f.client, vault));
    for (const feed of [raw.feed0, raw.feed1]) await f.write(feed, a.ControlledFeed.abi, "refresh");
    assert.equal((await planFromChain(f.client, vault)).decision.state, "READY");
  } finally { await f.rpc("evm_revert", [checkpoint]); }
});
test("refresh recovery binds the saved nonce, exact call, sender, destination and canonical two-RPC receipt", async () => {
  const deployment = await f.deploy(); await f.rpc("evm_mine");
  const proof = await verifyControlledEnvironment(f.client, f.client, f.owner, deployment.hash);
  const prepared = await prepareControlledRefresh(f.client, f.client, proof);
  assert.equal(prepared.transactions.length, 2);
  assert.equal(prepared.transactions[0].data, "0xf8ac93e8");
  const feed = proof.primary.dependencies!.feed0;
  const nonce = await f.client.getTransactionCount({ address: f.owner });
  const hash = await f.write(feed, f.artifacts.ControlledFeed.abi, "refresh");
  assert.equal((await verifyControlledRefresh(f.client, f.client, proof, hash, 0, nonce)).state, "PENDING");
  await f.rpc("evm_mine");
  const verified = await verifyControlledRefresh(f.client, f.client, proof, hash, 0, nonce);
  assert.equal(verified.state, "VERIFIED"); assert.equal(verified.canonical, true); assert.equal(verified.matchingReads, true);
  assert.equal((await verifyControlledRefresh(f.client, f.client, proof, hash, 0, nonce + 1)).state, "MISMATCH");
  assert.equal((await verifyControlledRefresh(f.client, f.client, proof, hash, 1, nonce)).state, "MISMATCH");
  assert.equal((await verifyControlledRefresh(f.client, f.client, proof, `0x${"ab".repeat(32)}`, 0, nonce)).state, "PENDING");
  const tx = await f.client.getTransaction({ hash });
  for (const patch of [{ from: f.stranger }, { to: f.stranger }, { input: "0x1234" }, { value: 1n }, { hash: deployment.hash }, { blockHash: deployment.hash }]) {
    const bad = override({ getTransaction: async () => ({ ...tx, ...patch }) });
    assert.equal((await verifyControlledRefresh(f.client, bad, proof, hash, 0, nonce)).state, "MISMATCH");
  }
  const receipt = await f.client.getTransactionReceipt({ hash });
  const reverted = override({ getTransactionReceipt: async () => ({ ...receipt, status: "reverted" }) });
  assert.equal((await verifyControlledRefresh(f.client, reverted, proof, hash, 0, nonce)).state, "MISMATCH");
  assert.equal((await verifyControlledRefresh(reverted, reverted, proof, hash, 0, nonce)).state, "REVERTED");
  const block = await f.client.getBlock({ blockNumber: receipt.blockNumber });
  assert.equal((await verifyControlledRefresh(f.client, override({ getBlock: async () => ({ ...block, hash: deployment.hash }) }), proof, hash, 0, nonce)).state, "MISMATCH");
  let heads = 0;
  const lostConfirmation = override({ getBlockNumber: async () => ++heads === 1 ?
    f.client.getBlockNumber({ cacheTime: 0 }) : receipt.blockNumber });
  const regressedProof = await verifyControlledRefresh(f.client, lostConfirmation, proof, hash, 0, nonce);
  assert.equal(regressedProof.state, "MISMATCH"); assert.equal(regressedProof.canonical, false);
  await assert.rejects(() => verifyControlledRefresh(f.client, override({ getTransactionReceipt: async () => { throw new Error("RPC down"); } }), proof, hash, 0, nonce), /RPC down/);
  await assert.rejects(() => verifyControlledRefresh(f.client, f.client, proof, hash, 0, -1));
});
test("refresh gas covers a timestamp change between estimation and mining", async () => {
  const checkpoint = await f.rpc("evm_snapshot");
  try {
    const deployment = await f.deploy(); await f.rpc("evm_mine");
    const proof = await verifyControlledEnvironment(f.client, f.client, f.owner, deployment.hash);
    const prepared = await prepareControlledRefresh(f.client, f.client, proof);
    const tx = prepared.transactions[0];
    const estimate = await f.client.estimateGas({ account: f.owner, to: tx.to, data: tx.data, blockTag: "latest" });
    assert.ok(BigInt(tx.gas) >= (estimate * 120n + 99n) / 100n);
    const block = await f.client.getBlock();
    await f.rpc("evm_setNextBlockTimestamp", [Number(block.timestamp + 2n)]);
    const hash = await f.wallet.sendTransaction({ account: f.owner, to: tx.to, data: tx.data, gas: BigInt(tx.gas) });
    assert.equal((await f.wait(hash)).status, "success");
    const round = await f.client.readContract({ address: tx.to, abi: f.artifacts.ControlledFeed.abi, functionName: "latestRoundData" }) as bigint[];
    assert.equal(round[3], block.timestamp + 2n);
    await f.rpc("evm_setNextBlockTimestamp", [Number(block.timestamp + 4n)]);
    await f.write(tx.to, f.artifacts.ControlledFeed.abi, "refresh");
  } finally { await f.rpc("evm_revert", [checkpoint]); }
});
