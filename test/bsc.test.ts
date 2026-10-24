import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseUnits, type PublicClient } from "viem";
import { startLocalFixture, type LocalFixture } from "../src/bsc/local.js";
import { executeLocal } from "../src/bsc/demo.js";
import { planFromChain, proposeRebalance, readSnapshot, verifyExecution, type Plan } from "../src/bsc/rebalancer.js";
import { vaultAbi, tokenAbi } from "../src/bsc/abi.js";

let f: LocalFixture;
let checkpoint: string;
before(async () => { f = await startLocalFixture(); checkpoint = String(await f.rpc("evm_snapshot")); });
after(async () => { if (f) await f.close(); });
async function reset() {
  await f.rpc("evm_revert", [checkpoint]); checkpoint = String(await f.rpc("evm_snapshot"));
}
async function ready(): Promise<Plan> {
  const { decision } = await planFromChain(f.client, f.vault);
  assert.equal(decision.state, "READY");
  if (decision.state !== "READY") throw new Error("Expected ready plan");
  return decision.plan;
}
const override = (methods: Record<string, unknown>) => ({ ...f.client, ...methods }) as PublicClient;
const differentHash = `0x${"ab".repeat(32)}` as const;

test("BSC local bytecode executes a real swap and verifies event, calldata and token transfers", async () => {
  await reset(); const result = await executeLocal(f, await ready());
  assert.equal(result.state, "VERIFIED");
  assert.ok(Object.values(result.checks).every(Boolean));
  assert.equal(result.environment, "LOCAL_EVM"); assert.equal(result.campaignProof, false);
  assert.equal(result.blockHash, (await f.client.getBlock({ blockNumber: result.blockNumber })).hash);
  assert.match(result.snapshotBlockHash, /^0x[0-9a-f]{64}$/);
  assert.ok(result.confirmations >= 2n);
  const s = await readSnapshot(f.client, f.vault);
  assert.equal(s.balance0, parseUnits("70", 18)); assert.equal(s.balance1, parseUnits("30", 6));
  assert.equal(s.spentTodayUsd, parseUnits("10", 18)); assert.equal(s.nonce, 1n);
  const allowance = await f.client.readContract({ address: f.token0, abi: f.artifacts.TestToken.abi,
    functionName: "allowance", args: [f.vault, f.router] });
  assert.equal(allowance, 0n);
});

test("verifier rejects transaction, receipt and execution block identity mismatches", async () => {
  await reset(); const plan = await ready(), proof = await executeLocal(f, plan);
  const hash = proof.transactionHash;
  const tx = await f.client.getTransaction({ hash });
  const receipt = await f.client.getTransactionReceipt({ hash });
  const cases = [
    [{ getTransaction: async () => ({ ...tx, hash: differentHash }) }, "transactionBound"],
    [{ getTransactionReceipt: async () => ({ ...receipt, transactionHash: differentHash }) }, "transactionBound"],
    [{ getTransactionReceipt: async () => ({ ...receipt, from: f.stranger }) }, "transactionBound"],
    [{ getTransactionReceipt: async () => ({ ...receipt, to: f.token0 }) }, "transactionBound"],
    [{ getTransactionReceipt: async () => ({ ...receipt, transactionIndex: receipt.transactionIndex + 1 }) }, "transactionBound"],
    [{ getTransaction: async () => ({ ...tx, blockHash: differentHash }) }, "canonicalBlock"],
    [{ getTransaction: async () => ({ ...tx, blockNumber: receipt.blockNumber + 1n }) }, "canonicalBlock"]
  ] as const;
  for (const [methods, check] of cases) {
    const failed = await verifyExecution(override(methods), plan, hash);
    assert.equal(failed.state, "FROZEN"); assert.equal(failed.checks[check], false);
  }
});

test("verifier rejects removed or foreign receipt log metadata even when event data matches", async () => {
  await reset(); const plan = await ready(), proof = await executeLocal(f, plan);
  const receipt = await f.client.getTransactionReceipt({ hash: proof.transactionHash });
  assert.ok(receipt.logs.length > 0);
  for (const change of [{ removed: true }, { transactionHash: differentHash }, { blockHash: differentHash },
    { blockNumber: receipt.blockNumber + 1n }, { transactionIndex: receipt.transactionIndex + 1 }]) {
    const failed = await verifyExecution(override({ getTransactionReceipt: async () => ({ ...receipt,
      logs: receipt.logs.map((log, index) => index === 0 ? { ...log, ...change } : log) }) }), plan, proof.transactionHash);
    assert.equal(failed.state, "FROZEN"); assert.equal(failed.checks.logsBound, false);
  }
});

test("verifier rechecks execution and snapshot block anchors after historical reads", async () => {
  await reset(); const plan = await ready(), proof = await executeLocal(f, plan);
  for (const [target, lastRead, check] of [[proof.blockNumber, 2, "canonicalBlock"],
    [plan.snapshotBlock, 3, "canonicalSnapshot"]] as const) {
    let reads = 0;
    const client = override({ getBlock: async (args: Parameters<PublicClient["getBlock"]>[0]) => {
      const block = await f.client.getBlock(args);
      if (args?.blockNumber === target && ++reads === lastRead) return { ...block, hash: differentHash };
      return block;
    } });
    const failed = await verifyExecution(client, plan, proof.transactionHash);
    assert.equal(reads, lastRead); assert.equal(failed.state, "FROZEN"); assert.equal(failed.checks[check], false);
  }
});

test("verifier uses an uncached final head and cannot certify lost confirmations", async () => {
  await reset(); const plan = await ready(), proof = await executeLocal(f, plan);
  let fresh = false;
  const failed = await verifyExecution(override({ getBlockNumber: async (args: { cacheTime?: number }) => {
    fresh = args.cacheTime === 0; return proof.blockNumber - 1n;
  } }), plan, proof.transactionHash);
  assert.equal(fresh, true); assert.equal(failed.state, "FROZEN");
  assert.equal(failed.checks.sufficientlyConfirmed, false); assert.equal(failed.confirmations, 0n);
});

test("RPC failure during final block or head checks returns no execution proof", async () => {
  await reset(); const plan = await ready(), proof = await executeLocal(f, plan);
  let reads = 0;
  await assert.rejects(() => verifyExecution(override({ getBlock: async (args: Parameters<PublicClient["getBlock"]>[0]) => {
    if (args?.blockNumber === proof.blockNumber && ++reads === 2) throw new Error("Final block RPC unavailable");
    return f.client.getBlock(args);
  } }), plan, proof.transactionHash), /Final block RPC unavailable/);
  await assert.rejects(() => verifyExecution(override({ getBlockNumber: async () => {
    throw new Error("Final head RPC unavailable");
  } }), plan, proof.transactionHash), /Final head RPC unavailable/);
});

test("operator cannot withdraw, alter policy or pause a user's vault", async () => {
  await reset();
  await assert.rejects(() => f.write(f.vault, vaultAbi, "withdraw", [true, 1n], f.operator));
  await assert.rejects(() => f.write(f.vault, f.artifacts.AgentGuardVault.abi, "setPolicy", [f.policy], f.operator));
  await assert.rejects(() => f.write(f.vault, vaultAbi, "setPaused", [true], f.operator));
});

test("unknown caller and replayed nonce cannot execute", async () => {
  await reset(); const plan = await ready();
  const args = [plan.sellToken0, plan.amountIn, plan.minAmountOut, plan.deadline, plan.nonce, plan.id];
  await assert.rejects(() => f.write(f.vault, vaultAbi, "rebalance", args, f.stranger));
  await executeLocal(f, plan);
  await assert.rejects(() => f.write(f.vault, vaultAbi, "rebalance", args, f.operator));
});

test("owner pause blocks planning and direct contract execution; owner can still withdraw", async () => {
  await reset(); const plan = await ready();
  await f.write(f.vault, vaultAbi, "setPaused", [true]);
  const result = await planFromChain(f.client, f.vault);
  assert.deepEqual(result.decision, { state: "BLOCKED", reasons: ["vault_paused"] });
  await assert.rejects(() => f.write(f.vault, vaultAbi, "rebalance",
    [plan.sellToken0, plan.amountIn, plan.minAmountOut, plan.deadline, plan.nonce, plan.id], f.operator));
  await f.write(f.vault, vaultAbi, "withdraw", [true, 1n]);
});

test("USD budget cannot be bypassed by selling an 18-decimal token", async () => {
  await reset(); const p = await ready();
  await assert.rejects(() => f.write(f.vault, vaultAbi, "rebalance",
    [true, parseUnits("11", 18), parseUnits("10.89", 6), p.deadline, p.nonce, p.id], f.operator));
  assert.equal((await readSnapshot(f.client, f.vault)).spentTodayUsd, 0n);
});

test("daily USD budget is cumulatively enforced and planner clamps to remaining budget", async () => {
  await reset();
  for (let i = 0; i < 2; i++) {
    const proof = await executeLocal(f, await ready());
    assert.equal(proof.state, "VERIFIED", `Budget test trade failed: ${proof.reasons.join(", ")}; hash ${proof.transactionHash}`);
    assert.equal((await readSnapshot(f.client, f.vault)).spentTodayUsd, parseUnits(String((i + 1) * 10), 18));
  }
  const p = await ready(); assert.equal(p.notionalUsd, parseUnits("5", 18));
  await executeLocal(f, p);
  const blocked = await planFromChain(f.client, f.vault);
  assert.equal(blocked.decision.state, "BLOCKED");
  if (blocked.decision.state === "BLOCKED") assert.ok(blocked.decision.reasons.includes("daily_budget_exhausted"));
});

test("local execution buffers gas and verifies when the mined timestamp advances after estimation", async () => {
  await reset(); await executeLocal(f, await ready());
  const plan = await ready(), original = f.client.estimateGas;
  let estimate = 0n;
  try {
    f.client.estimateGas = async (...args) => {
      estimate = await original(...args);
      const block = await f.client.getBlock();
      await f.rpc("evm_setNextBlockTimestamp", [Number(block.timestamp + 2n)]);
      return estimate;
    };
    const proof = await executeLocal(f, plan);
    assert.equal(proof.state, "VERIFIED", proof.reasons.join(", "));
    const tx = await f.client.getTransaction({ hash: proof.transactionHash });
    assert.equal(tx.gas, estimate + (estimate + 4n) / 5n);
    assert.equal((await readSnapshot(f.client, f.vault)).spentTodayUsd, parseUnits("20", 18));
  } finally { f.client.estimateGas = original; }
});

test("stale, zero, negative and future oracle answers fail closed", async () => {
  await reset(); const now = (await f.client.getBlock()).timestamp;
  for (const [answer, time] of [[100000000n, now - 4000n], [0n, now], [-1n, now], [100000000n, now + 4000n]]) {
    await f.write(f.feed0, f.artifacts.TestFeed.abi, "set", [answer, time]);
    await assert.rejects(() => readSnapshot(f.client, f.vault));
  }
});

test("router output below oracle floor is rejected before signing", async () => {
  await reset(); await f.write(f.router, f.artifacts.TestRouter.abi, "setOutputBps", [9500n]);
  const result = await planFromChain(f.client, f.vault);
  assert.deepEqual(result.decision, { state: "BLOCKED", reasons: ["quote_below_oracle_floor"] });
});

test("operator cannot lower minimum output to evade oracle bounds", async () => {
  await reset(); const p = await ready();
  await assert.rejects(() => f.write(f.vault, vaultAbi, "rebalance",
    [true, p.amountIn, 1n, p.deadline, p.nonce, p.id], f.operator));
});

test("bad router output reverts balances, nonce and daily budget atomically", async () => {
  await reset(); const p = await ready();
  await f.write(f.router, f.artifacts.TestRouter.abi, "setOutputBps", [9000n]);
  await assert.rejects(() => f.write(f.vault, vaultAbi, "rebalance",
    [true, p.amountIn, p.minAmountOut, p.deadline, p.nonce, p.id], f.operator));
  const s = await readSnapshot(f.client, f.vault);
  assert.equal(s.nonce, 0n); assert.equal(s.spentTodayUsd, 0n); assert.equal(s.balance0, parseUnits("80", 18));
});

test("wrong direction and large overshoot cannot be used to churn a position", async () => {
  await reset(); const p = await ready();
  await assert.rejects(() => f.write(f.vault, vaultAbi, "rebalance",
    [false, parseUnits("10", 6), parseUnits("9.9", 18), p.deadline, p.nonce, p.id], f.operator));
  await f.write(f.vault, f.artifacts.AgentGuardVault.abi, "setPolicy",
    [{ ...f.policy, maxActionUsd: parseUnits("100", 18), maxDailyUsd: parseUnits("100", 18) }]);
  await assert.rejects(() => f.write(f.vault, vaultAbi, "rebalance",
    [true, parseUnits("70", 18), parseUnits("69.3", 6), p.deadline, p.nonce, p.id], f.operator));
});

test("cooldown and expired plans are enforced by the contract", async () => {
  await reset();
  await f.write(f.vault, f.artifacts.AgentGuardVault.abi, "setPolicy", [{ ...f.policy, cooldownSeconds: 600 }]);
  await executeLocal(f, await ready());
  const blocked = await planFromChain(f.client, f.vault);
  assert.equal(blocked.decision.state, "BLOCKED");
  await reset(); const p = await ready();
  await f.rpc("evm_increaseTime", [100]); await f.rpc("evm_mine");
  await assert.rejects(() => f.write(f.vault, vaultAbi, "rebalance",
    [true, p.amountIn, p.minAmountOut, p.deadline, p.nonce, p.id], f.operator));
});

test("unrelated successful transaction and modified plan cannot become VERIFIED", async () => {
  await reset(); const p = await ready();
  const hash = await f.write(f.token0, tokenAbi, "approve", [f.vault, 0n]);
  await f.rpc("evm_mine");
  const wrong = await verifyExecution(f.client, p, hash);
  assert.equal(wrong.state, "FROZEN"); assert.equal(wrong.checks.calldataBound, false);
  const receipt = await executeLocal(f, p);
  const changed = { ...p, data: encodeFunctionData({ abi: vaultAbi, functionName: "setPaused", args: [true] }) };
  assert.equal((await verifyExecution(f.client, changed, receipt.transactionHash)).state, "FROZEN");
  await assert.rejects(() => verifyExecution(f.client, { ...p, chainId: 97 }, receipt.transactionHash), /chain mismatch/);
});

test("within-target-band and unsupported mainnet proposals never call a router", async () => {
  await reset(); const s = await readSnapshot(f.client, f.vault);
  const never = async () => { throw new Error("Quote must not be called"); };
  const balanced = await proposeRebalance({ ...s, balance0: parseUnits("50", 18), balance1: parseUnits("50", 6) }, never);
  assert.deepEqual(balanced, { state: "BLOCKED", reasons: ["within_target_band"] });
  const mainnet = await proposeRebalance({ ...s, chainId: 56 }, never);
  assert.deepEqual(mainnet, { state: "BLOCKED", reasons: ["unsupported_chain"] });
});
