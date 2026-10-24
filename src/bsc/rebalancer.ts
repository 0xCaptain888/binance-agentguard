import { createHash } from "node:crypto";
import { decodeFunctionData, encodeFunctionData, getAddress, keccak256, parseEventLogs, toHex,
  type Address, type Hash, type Hex, type PublicClient } from "viem";
import { vaultAbi, tokenAbi, routerAbi } from "./abi.js";

export const json = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);
const ceilDiv = (n: bigint, d: bigint) => (n + d - 1n) / d;
export type Snapshot = {
  chainId: number; vault: Address; blockNumber: bigint; blockTimestamp: bigint;
  owner: Address; operator: Address; router: Address; token0: Address; token1: Address;
  decimals0: number; decimals1: number; symbol0: string; symbol1: string;
  balance0: bigint; balance1: bigint; price0: bigint; price1: bigint;
  maxActionUsd: bigint; maxDailyUsd: bigint; targetBps: number; slippageBps: number;
  cooldownSeconds: number; maxOracleAge: number; paused: boolean; nonce: bigint;
  spentTodayUsd: bigint; lastExecutionAt: bigint;
  pricingAvailable?: boolean;
};
export type Plan = {
  id: Hash; chainId: number; vault: Address; owner: Address; operator: Address;
  tokenIn: Address; tokenOut: Address; sellToken0: boolean; amountIn: bigint;
  minAmountOut: bigint; quotedAmountOut: bigint; notionalUsd: bigint;
  nonce: bigint; deadline: bigint; snapshotBlock: bigint; snapshotHash: Hash;
  driftBeforeBps: bigint; expectedDriftAfterBps: bigint; data: Hex;
};
export type Decision = { state: "READY"; plan: Plan } | { state: "BLOCKED"; reasons: string[] };

export function portfolio(s: Snapshot, b0 = s.balance0, b1 = s.balance1) {
  const v0 = b0 * s.price0 / 10n ** BigInt(s.decimals0);
  const v1 = b1 * s.price1 / 10n ** BigInt(s.decimals1);
  const share = v0 + v1 ? v0 * 10000n / (v0 + v1) : 0n;
  const difference = share - BigInt(s.targetBps);
  return { totalUsd: v0 + v1, value0Usd: v0, value1Usd: v1, shareBps: share,
    driftBps: difference < 0n ? -difference : difference };
}

export async function readSnapshot(client: PublicClient, vault: Address, atBlock?: bigint, allowUnavailablePrices = false): Promise<Snapshot> {
  const chainId = await client.getChainId();
  if (chainId !== 97 && chainId !== 31337) throw new Error("Only BSC testnet (97) and local EVM (31337) are enabled");
  const block = await client.getBlock(atBlock === undefined ? {} : { blockNumber: atBlock });
  if (block.number === null) throw new Error("Pending block cannot anchor a plan");
  const blockNumber = block.number;
  type ReadName = "owner" | "operator" | "token0" | "token1" | "router" | "paused" | "executionNonce" | "prices" | "policy" | "spentTodayUsd" | "spendDay" | "lastExecutionAt";
  const read = <T>(functionName: ReadName) => client.readContract({ address: vault, abi: vaultAbi, functionName, blockNumber }) as Promise<T>;
  const [owner, operator, token0, token1, router, paused, nonce, prices, policy, spent, spendDay, lastExecutionAt] = await Promise.all([
    read<Address>("owner"), read<Address>("operator"), read<Address>("token0"), read<Address>("token1"), read<Address>("router"),
    read<boolean>("paused"), read<bigint>("executionNonce"), read<readonly [bigint, bigint]>("prices").catch(error => {
      // Control-plane reads can survive an unavailable oracle. Planning and proof
      // verification use the strict default and never substitute cached prices.
      if (!allowUnavailablePrices) throw error;
      return null;
    }),
    read<readonly [bigint, bigint, number, number, number, number]>("policy"), read<bigint>("spentTodayUsd"),
    read<bigint>("spendDay"), read<bigint>("lastExecutionAt")
  ]);
  const [balance0, balance1, decimals0, decimals1, symbol0, symbol1] = await Promise.all([
    client.readContract({ address: token0, abi: tokenAbi, functionName: "balanceOf", args: [vault], blockNumber }),
    client.readContract({ address: token1, abi: tokenAbi, functionName: "balanceOf", args: [vault], blockNumber }),
    client.readContract({ address: token0, abi: tokenAbi, functionName: "decimals", blockNumber }),
    client.readContract({ address: token1, abi: tokenAbi, functionName: "decimals", blockNumber }),
    client.readContract({ address: token0, abi: tokenAbi, functionName: "symbol", blockNumber }),
    client.readContract({ address: token1, abi: tokenAbi, functionName: "symbol", blockNumber })
  ]);
  return { chainId, vault: getAddress(vault), blockNumber, blockTimestamp: block.timestamp, owner, operator, token0, token1, router,
    paused, nonce, price0: prices?.[0] ?? 0n, price1: prices?.[1] ?? 0n, pricingAvailable: prices !== null,
    maxActionUsd: policy[0], maxDailyUsd: policy[1],
    targetBps: policy[2], slippageBps: policy[3], cooldownSeconds: policy[4], maxOracleAge: policy[5],
    spentTodayUsd: spendDay === block.timestamp / 86400n ? spent : 0n, lastExecutionAt,
    balance0, balance1, decimals0, decimals1, symbol0, symbol1 };
}

// Pure deterministic proposal. No signing or broadcasting happens in the planner.
export async function proposeRebalance(s: Snapshot, quote: (amount: bigint, path: Address[]) => Promise<bigint>,
  minimumDriftBps = 100): Promise<Decision> {
  const reasons: string[] = [];
  const p = portfolio(s);
  if (![97, 31337].includes(s.chainId)) reasons.push("unsupported_chain");
  if (s.paused) reasons.push("vault_paused");
  if (!Number.isInteger(minimumDriftBps) || minimumDriftBps < 1 || minimumDriftBps > 10000) reasons.push("invalid_drift_threshold");
  if (s.price0 <= 0n || s.price1 <= 0n || s.decimals0 > 18 || s.decimals1 > 18) reasons.push("invalid_asset_metadata");
  if (p.totalUsd === 0n) reasons.push("empty_vault");
  if (Number.isInteger(minimumDriftBps) && p.driftBps < BigInt(minimumDriftBps)) reasons.push("within_target_band");
  if (s.maxDailyUsd <= s.spentTodayUsd) reasons.push("daily_budget_exhausted");
  if (s.lastExecutionAt && s.blockTimestamp < s.lastExecutionAt + BigInt(s.cooldownSeconds)) reasons.push("cooldown_active");
  if (reasons.length) return { state: "BLOCKED", reasons };
  const sellToken0 = p.shareBps > BigInt(s.targetBps);
  const target0 = p.totalUsd * BigInt(s.targetBps) / 10000n;
  const excess = sellToken0 ? p.value0Usd - target0 : target0 - p.value0Usd;
  const remaining = s.maxDailyUsd - s.spentTodayUsd;
  const notionalCap = [excess, remaining, s.maxActionUsd].reduce((a, b) => a < b ? a : b);
  const unitIn = 10n ** BigInt(sellToken0 ? s.decimals0 : s.decimals1);
  const unitOut = 10n ** BigInt(sellToken0 ? s.decimals1 : s.decimals0);
  const priceIn = sellToken0 ? s.price0 : s.price1, priceOut = sellToken0 ? s.price1 : s.price0;
  const amountIn = notionalCap * unitIn / priceIn;
  if (!amountIn) return { state: "BLOCKED", reasons: ["amount_rounds_to_zero"] };
  const notionalUsd = amountIn * priceIn / unitIn;
  const tokenIn = sellToken0 ? s.token0 : s.token1, tokenOut = sellToken0 ? s.token1 : s.token0;
  const quotedAmountOut = await quote(amountIn, [tokenIn, tokenOut]);
  const fairOut = notionalUsd * unitOut / priceOut;
  const oracleFloor = ceilDiv(fairOut * BigInt(10000 - s.slippageBps), 10000n);
  const quoteFloor = quotedAmountOut * BigInt(10000 - s.slippageBps) / 10000n;
  const minAmountOut = oracleFloor > quoteFloor ? oracleFloor : quoteFloor;
  if (quotedAmountOut < minAmountOut || minAmountOut <= 0n) return { state: "BLOCKED", reasons: ["quote_below_oracle_floor"] };
  const resulting0 = sellToken0 ? s.balance0 - amountIn : s.balance0 + minAmountOut;
  const resulting1 = sellToken0 ? s.balance1 + minAmountOut : s.balance1 - amountIn;
  const expectedDriftAfterBps = portfolio(s, resulting0, resulting1).driftBps;
  if (expectedDriftAfterBps >= p.driftBps) return { state: "BLOCKED", reasons: ["drift_not_improved"] };
  const partial = { chainId: s.chainId, vault: s.vault, owner: s.owner, operator: s.operator, tokenIn, tokenOut, sellToken0,
    amountIn, minAmountOut, quotedAmountOut, notionalUsd, nonce: s.nonce, deadline: s.blockTimestamp + 90n,
    snapshotBlock: s.blockNumber, snapshotHash: keccak256(toHex(json(s))), driftBeforeBps: p.driftBps, expectedDriftAfterBps };
  const id = keccak256(toHex(json(partial)));
  const data = encodeFunctionData({ abi: vaultAbi, functionName: "rebalance",
    args: [sellToken0, amountIn, minAmountOut, partial.deadline, s.nonce, id] });
  return { state: "READY", plan: { id, ...partial, data } };
}

export async function planFromChain(client: PublicClient, vault: Address): Promise<{ snapshot: Snapshot; decision: Decision }> {
  const snapshot = await readSnapshot(client, vault);
  const decision = await proposeRebalance(snapshot, async (amountIn, path) => {
    const amounts = await client.readContract({ address: snapshot.router, abi: routerAbi, functionName: "getAmountsOut",
      args: [amountIn, path], blockNumber: snapshot.blockNumber });
    if (amounts.length !== 2) throw new Error("Invalid router quote");
    return amounts[1];
  });
  return { snapshot, decision };
}

export type Verification = { state: "VERIFIED" | "FROZEN"; chainId: number; transactionHash: Hash;
  blockNumber: bigint; blockHash: Hash; snapshotBlockHash: Hash; confirmations: bigint;
  planId: Hash; checks: Record<string, boolean>; reasons: string[]; evidenceHash: string;
  createdAt: string; environment: "LOCAL_EVM" | "BSC_TESTNET"; campaignProof: false };

export async function verifyExecution(client: PublicClient, plan: Plan, hash: Hash, confirmations = 2): Promise<Verification> {
  const chainId = await client.getChainId();
  if (![97, 31337].includes(chainId) || chainId !== plan.chainId) throw new Error("Verifier chain mismatch");
  if (!Number.isInteger(confirmations) || confirmations < 1) throw new Error("Invalid confirmations");
  // Only canonical RPC data is used here; no executor-supplied result is trusted.
  const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
  const [block, snapshotBlock] = await Promise.all([
    client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlock({ blockNumber: plan.snapshotBlock })
  ]);
  if (!block.hash || !snapshotBlock.hash) throw new Error("Mined blocks are required for verification");
  const events = parseEventLogs({ abi: vaultAbi, eventName: "Rebalanced", logs: receipt.logs.filter(l =>
    l.address.toLowerCase() === plan.vault.toLowerCase()), strict: true });
  const transfers = parseEventLogs({ abi: tokenAbi, eventName: "Transfer", logs: receipt.logs, strict: true });
  const event = events.length === 1 ? events[0].args : undefined;
  let snapshotBound = false;
  try {
    const snapshot = await readSnapshot(client, plan.vault, plan.snapshotBlock);
    snapshotBound = keccak256(toHex(json(snapshot))) === plan.snapshotHash &&
      snapshot.owner.toLowerCase() === plan.owner.toLowerCase() && snapshot.operator.toLowerCase() === plan.operator.toLowerCase() &&
      (plan.sellToken0 ? snapshot.token0 : snapshot.token1).toLowerCase() === plan.tokenIn.toLowerCase() &&
      (plan.sellToken0 ? snapshot.token1 : snapshot.token0).toLowerCase() === plan.tokenOut.toLowerCase() && snapshot.nonce === plan.nonce;
  } catch { /* Missing/pruned/reorganized snapshot cannot be certified. */ }
  let calldataBound = false;
  try {
    const decoded = decodeFunctionData({ abi: vaultAbi, data: tx.input });
    calldataBound = decoded.functionName === "rebalance" && tx.input === plan.data;
  } catch { /* Malformed/unrelated calldata must fail verification. */ }
  const transferredIn = transfers.filter(l => l.address.toLowerCase() === plan.tokenIn.toLowerCase() &&
    l.args.from.toLowerCase() === plan.vault.toLowerCase()).reduce((n, l) => n + l.args.value, 0n);
  const transferredOut = transfers.filter(l => l.address.toLowerCase() === plan.tokenOut.toLowerCase() &&
    l.args.to.toLowerCase() === plan.vault.toLowerCase()).reduce((n, l) => n + l.args.value, 0n);
  // Historical reads span multiple RPC calls. Recheck both anchors afterwards so
  // a fork change during those reads cannot turn mixed-chain data into evidence.
  // Transport errors in these final checks propagate without producing a proof.
  const [canonicalBlock, canonicalSnapshot, head] = await Promise.all([
    client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlock({ blockNumber: plan.snapshotBlock }),
    client.getBlockNumber({ cacheTime: 0 })
  ]);
  const same = (a: string | null | undefined, b: string | null | undefined) =>
    typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
  const checks = {
    transactionSucceeded: receipt.status === "success",
    transactionBound: same(tx.hash, hash) && same(receipt.transactionHash, hash) && same(tx.from, receipt.from) &&
      same(tx.to, receipt.to) && tx.transactionIndex === receipt.transactionIndex,
    canonicalBlock: same(block.hash, receipt.blockHash) && same(tx.blockHash, receipt.blockHash) &&
      tx.blockNumber === receipt.blockNumber && same(canonicalBlock.hash, receipt.blockHash),
    canonicalSnapshot: same(canonicalSnapshot.hash, snapshotBlock.hash),
    logsBound: receipt.logs.every(log => !log.removed && same(log.transactionHash, hash) &&
      same(log.blockHash, receipt.blockHash) && log.blockNumber === receipt.blockNumber && log.transactionIndex === receipt.transactionIndex),
    sufficientlyConfirmed: head >= receipt.blockNumber + BigInt(confirmations - 1),
    vaultBound: tx.to?.toLowerCase() === plan.vault.toLowerCase(),
    authorizedSender: [plan.owner.toLowerCase(), plan.operator.toLowerCase()].includes(tx.from.toLowerCase()),
    noNativeValue: tx.value === 0n, calldataBound, snapshotBound,
    withinDeadline: block.timestamp <= plan.deadline, afterSnapshot: receipt.blockNumber > plan.snapshotBlock,
    planBound: event?.planId === plan.id && event?.nonce === plan.nonce,
    inputBound: event?.tokenIn.toLowerCase() === plan.tokenIn.toLowerCase() && event?.amountIn === plan.amountIn,
    outputDelivered: !!event && event.amountOut >= plan.minAmountOut,
    notionalBound: event?.notionalUsd === plan.notionalUsd,
    driftImproved: !!event && event.driftAfterBps < event.driftBeforeBps,
    inputTransferMatches: transferredIn === plan.amountIn,
    outputTransferMatches: !!event && transferredOut === event.amountOut
  };
  const reasons = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  const body = { state: reasons.length ? "FROZEN" as const : "VERIFIED" as const, chainId, transactionHash: hash,
    blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, snapshotBlockHash: snapshotBlock.hash,
    confirmations: head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n,
    planId: plan.id, checks, reasons, createdAt: new Date().toISOString(),
    environment: chainId === 31337 ? "LOCAL_EVM" as const : "BSC_TESTNET" as const, campaignProof: false as const };
  return { ...body, evidenceHash: createHash("sha256").update(json(body)).digest("hex") };
}
