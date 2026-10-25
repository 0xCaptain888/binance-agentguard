import test from "node:test";
import assert from "node:assert/strict";
import { ContractFunctionRevertedError, parseAbi, zeroAddress, type Address, type PublicClient } from "viem";
import { dependencyPolicy, inspectDependencies, probeDependencies, probeQuoteInput, type ProbeInventory } from "../src/bsc/dependency-probe.js";
import { dependencySummary } from "../src/bsc/dependency-status.js";
import { json } from "../src/bsc/rebalancer.js";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const inventory: ProbeInventory = {
  router: addr(1), factory: addr(2), wrappedNative: addr(3),
  feeds: { A: addr(11), B: addr(12), C: addr(13) },
  tokens: [
    { asset: "A", address: addr(3), feed: "A", decimals: 18 },
    { asset: "B", address: addr(4), feed: "B", decimals: 8 },
    { asset: "C", address: addr(5), feed: "C", decimals: 6 }
  ]
};
function fixture(override?: (args: any) => unknown) {
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const block = { number: 123n, timestamp, hash: `0x${"ab".repeat(32)}` };
  const calls: any[] = [];
  const readContract = async (args: any) => {
    calls.push(args);
    const changed = override?.(args);
    if (changed !== undefined) return changed;
    const token = inventory.tokens.find(t => t.address === args.address);
    switch (args.functionName) {
      case "factory": return inventory.factory;
      case "WETH": return inventory.wrappedNative;
      case "description": return "Test / USD";
      case "symbol": return token!.asset;
      case "decimals": return token?.decimals ?? 8;
      case "latestRoundData": return [1n, 100000000n, timestamp, timestamp, 1n];
      case "getPair": return addr(101);
      case "getAmountsOut": {
        const [amountIn, path] = args.args;
        const a = inventory.tokens.find(t => t.address === path[0])!, b = inventory.tokens.find(t => t.address === path[1])!;
        return [amountIn, amountIn * 10n ** BigInt(b.decimals) / 10n ** BigInt(a.decimals)];
      }
      default: throw new Error("Unexpected RPC read");
    }
  };
  const client = { getBlock: async () => block, getChainId: async () => 97, getCode: async () => "0x1234", readContract } as unknown as PublicClient;
  return { client, calls, block };
}
test("discovery checks non-native combinations, both directions and decimal scaling at one block", async () => {
  const f = fixture(), result = await inspectDependencies(f.client, 123n, inventory);
  assert.equal(result.complete, true); assert.equal(result.routes.length, 3);
  assert.ok(result.routes.every(r => r.compatibleCandidate && !r.mappingReviewed));
  const nonNative = result.routes.find(r => r.assets.join("/") === "B/C")!;
  assert.equal(nonNative.status, "INSPECTED");
  assert.equal(f.calls.filter(c => c.functionName === "getAmountsOut").length, 6);
  assert.ok(f.calls.every(c => c.blockNumber === 123n));
  const quote = probeQuoteInput(2n * 10n ** 18n, 5n * 10n ** 18n, 8, 6, dependencyPolicy);
  assert.deepEqual(quote, { amountIn: 500000000n, notionalUsd: 10n * 10n ** 18n, oracleFloor: 1980000n });
});
test("a missing pair is a chain observation; an RPC failure is an incomplete scan even when both providers fail equally", async () => {
  const absent = fixture(a => a.functionName === "getPair" ? zeroAddress : undefined);
  const absentReport = await probeDependencies(absent.client, absent.client, inventory);
  assert.equal(absentReport.state, "CANDIDATES_INSPECTED");
  assert.ok(absentReport.primary.routes.every(r => r.status === "NO_PAIR"));
  assert.equal(absentReport.deploymentReady, false);
  const failed = fixture(a => { if (a.functionName === "getPair") throw new Error("RPC transport failed with private endpoint secret"); });
  const report = await probeDependencies(failed.client, failed.client, inventory);
  assert.equal(report.matchingReads, true);
  assert.equal(report.state, "DEPENDENCY_READS_INCOMPLETE");
  assert.equal(report.deploymentReady, false);
  assert.doesNotMatch(json(report), /private endpoint secret/);
});
test("a genuine reverted quote stays distinct from transport failure, and never becomes a compatible candidate", async () => {
  const f = fixture(a => {
    if (a.functionName === "getAmountsOut") throw new ContractFunctionRevertedError({
      abi: parseAbi(["function getAmountsOut(uint256,address[]) view returns (uint256[])"]), functionName: "getAmountsOut", data: "0x"
    });
  });
  const result = await inspectDependencies(f.client, 123n, inventory);
  assert.equal(result.complete, true);
  assert.ok(result.routes.every(r => !r.compatibleCandidate && "quotes" in r && r.quotes.every(q => q.status === "QUOTE_REVERTED")));
});
test("stale feed and a single bad quote direction block compatibility without loosening policy", async () => {
  const stale = fixture(a => a.functionName === "latestRoundData" && a.address.toLowerCase() === addr(12) ? [1n, 100000000n, 1n, 1n, 1n] : undefined);
  const result = await inspectDependencies(stale.client, 123n, inventory);
  assert.equal(result.routes.filter(r => r.compatibleCandidate).length, 1);
  assert.ok(result.routes.filter(r => r.assets.includes("B")).every(r => !r.compatibleCandidate));
  const bad = fixture(a => a.functionName === "getAmountsOut" && a.args[1][0] === addr(4) ? [a.args[0], 1n] : undefined);
  const quotes = await inspectDependencies(bad.client, 123n, inventory);
  assert.ok(quotes.routes.filter(r => r.assets.includes("B")).every(r => !r.compatibleCandidate));
});
test("independent oracle provenance mismatch fails verification even if the displayed price matches", async () => {
  const a = fixture(), b = fixture(args => args.functionName === "latestRoundData" ?
    [2n, 100000000n, a.block.timestamp, a.block.timestamp, 2n] : undefined);
  const report = await probeDependencies(a.client, b.client, inventory);
  assert.equal(report.state, "RPC_VERIFICATION_FAILED");
  assert.equal(report.matchingReads, false);
});
test("saved summaries age out, never become deployable, and whitelist data instead of exposing raw credentials", async () => {
  const f = fixture(), raw = JSON.parse(json(await probeDependencies(f.client, f.client, inventory)));
  raw.endpoint = "https://secret.invalid/api-key";
  raw.primary.assets[0].symbol = "private-metadata-secret";
  const at = Date.parse(raw.checkedAt);
  const current = dependencySummary(raw, at);
  assert.equal(current.state, "REVIEW_REQUIRED");
  assert.equal(current.deploymentReady, false);
  assert.doesNotMatch(JSON.stringify(current), /api-key|private-metadata-secret|secret\.invalid/);
  assert.equal(dependencySummary(raw, at + 121000).state, "STALE_SNAPSHOT");
  raw.primary.complete = false;
  assert.equal(dependencySummary(raw, at).state, "INCOMPLETE");
  raw.state = "RPC_VERIFICATION_FAILED"; raw.matchingReads = false;
  assert.equal(dependencySummary(raw, at).state, "RPC_VERIFICATION_FAILED");
  assert.equal(dependencySummary({ ...raw, schemaVersion: 1 }, at).state, "UNAVAILABLE");
  assert.equal(dependencySummary({ schemaVersion: 2, state: "RPC_UNAVAILABLE", checkedAt: raw.checkedAt }, at).state, "UNAVAILABLE");
});
