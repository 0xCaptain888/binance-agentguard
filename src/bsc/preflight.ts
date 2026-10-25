import { keccak256, parseAbi, type PublicClient } from "viem";
import { deploymentData, type DeploymentConfig } from "./deployment.js";
import { json } from "./rebalancer.js";
import { tokenAbi, routerAbi } from "./abi.js";

const feedAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"
]);
type Check = { name: string; passed: boolean; detail: string };

// Read-only compatibility probe. Passing is not a dependency audit or execution proof.
export async function inspectDeployment(client: PublicClient, config: DeploymentConfig, chainId: 97 | 31337 = 97, atBlock?: bigint) {
  if (await client.getChainId() !== chainId) throw new Error("Wrong preflight chain");
  const block = await client.getBlock(atBlock === undefined ? {} : { blockNumber: atBlock });
  if (block.number === null || !block.hash) throw new Error("Mined block required");
  const blockNumber = block.number;
  const checks: Check[] = [];
  const check = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });
  const now = BigInt(Math.floor(Date.now() / 1000));
  check("recent_block", block.timestamp <= now + 30n && block.timestamp >= now - 120n,
    "The anchored block must be recent (within 120 seconds) and not over 30 seconds in the future.");
  const assets: { symbol: string; decimals: number; priceUsd: bigint }[] = [];
  const oracles: { asset: number; feed: string; decimals: number; roundId: bigint; answer: bigint;
    startedAt: bigint; updatedAt: bigint; answeredInRound: bigint; ageSeconds: bigint; maxAgeSeconds: number; fresh: boolean }[] = [];
  const codeHashes: Record<string, string> = {};
  let ownerBalance: bigint | null = null, gasEstimate: bigint | null = null, gasPrice: bigint | null = null;
  try {
    const ownerCode = await client.getCode({ address: config.owner, blockNumber });
    codeHashes.owner = keccak256(ownerCode ?? "0x");
    check("owner_wallet", !ownerCode || ownerCode === "0x", "This release requires an EOA owner; contract-wallet sessions are unsupported.");
    ownerBalance = await client.getBalance({ address: config.owner, blockNumber });
    check("owner_test_gas", ownerBalance > 0n, "The configured owner needs native test gas on the selected chain.");
  } catch { check("owner_readable", false, "Owner account could not be read at the anchored block."); }
  for (const key of ["token0", "token1", "router", "feed0", "feed1"] as const) {
    try {
      const code = await client.getCode({ address: config[key], blockNumber });
      codeHashes[key] = keccak256(code ?? "0x");
      check(`${key}_code`, !!code && code !== "0x", "Dependency must have contract code at the anchored block.");
    } catch { check(`${key}_code`, false, "Dependency code could not be read."); }
  }
  for (const index of [0, 1] as const) {
    try {
      const address = index === 0 ? config.token0 : config.token1;
      const feed = index === 0 ? config.feed0 : config.feed1;
      const [symbol, decimals, feedDecimals, round] = await Promise.all([
        client.readContract({ address, abi: tokenAbi, functionName: "symbol", blockNumber }),
        client.readContract({ address, abi: tokenAbi, functionName: "decimals", blockNumber }),
        client.readContract({ address: feed, abi: feedAbi, functionName: "decimals", blockNumber }),
        client.readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData", blockNumber })
      ]);
      const metadataOk = Number.isInteger(decimals) && decimals >= 0 && decimals <= 18 &&
        Number.isInteger(feedDecimals) && feedDecimals >= 0 && feedDecimals <= 18 && typeof symbol === "string" && symbol.length > 0 && symbol.length <= 64;
      check(`asset${index}_metadata`, metadataOk, "Readable symbol and token/feed decimals between 0 and 18 are required.");
      const fresh = round[1] > 0n && round[3] > 0n && round[3] <= block.timestamp &&
        block.timestamp - round[3] <= BigInt(config.policy.maxOracleAge) && round[4] >= round[0];
      const ageSeconds = block.timestamp - round[3];
      oracles.push({ asset: index, feed, decimals: feedDecimals, roundId: round[0], answer: round[1],
        startedAt: round[2], updatedAt: round[3], answeredInRound: round[4], ageSeconds,
        maxAgeSeconds: config.policy.maxOracleAge, fresh });
      check(`asset${index}_price`, fresh,
        `Oracle age ${ageSeconds}s; maximum ${config.policy.maxOracleAge}s. Answer must be positive, timestamp nonzero and not future-dated, and round completed. Refresh the dependency; no cached price is substituted.`);
      if (metadataOk && fresh) assets[index] = { symbol, decimals, priceUsd: round[1] * 10n ** 18n / 10n ** BigInt(feedDecimals) };
    } catch { check(`asset${index}_readable`, false, "Token or oracle interface could not be read. No cached price is substituted."); }
  }
  if (assets[0]?.priceUsd > 0n && assets[1]?.priceUsd > 0n) {
    for (const direction of [0, 1] as const) {
      const input = assets[direction], output = assets[direction === 0 ? 1 : 0];
      const amountIn = config.policy.maxActionUsd * 10n ** BigInt(input.decimals) / input.priceUsd;
      try {
        const path = direction === 0 ? [config.token0, config.token1] : [config.token1, config.token0];
        const amounts = await client.readContract({ address: config.router, abi: routerAbi, functionName: "getAmountsOut", args: [amountIn, path], blockNumber });
        const notional = amountIn * input.priceUsd / 10n ** BigInt(input.decimals);
        const fairOut = notional * 10n ** BigInt(output.decimals) / output.priceUsd;
        const floor = (fairOut * BigInt(10000 - config.policy.maxSlippageBps) + 9999n) / 10000n;
        check(`route_${direction}_quote`, amountIn > 0n && notional > 0n && amounts.length === 2 && amounts[0] === amountIn && amounts[1] > 0n && amounts[1] >= floor,
          "Direct route at the action limit must quote above the configured oracle floor. A quote does not guarantee a fill.");
      } catch { check(`route_${direction}_quote`, false, "Direct route at the action limit is unavailable. Review router, pair liquidity and asset selection."); }
    }
  } else check("route_prerequisites", false, "Both assets need valid positive oracle prices before checking routes.");
  try {
    gasEstimate = await client.estimateGas({ account: config.owner, data: deploymentData(config), value: 0n, blockNumber });
    gasPrice = await client.getGasPrice();
    const bufferedCost = (gasEstimate * gasPrice * 120n + 99n) / 100n;
    check("deployment_gas", gasEstimate > 0n && gasPrice > 0n && ownerBalance !== null && ownerBalance >= bufferedCost,
      "Owner balance must cover the current estimate with a 20% buffer. Wallet fees may change before confirmation.");
  } catch { check("deployment_gas", false, "Constructor gas estimation failed. Check owner test gas and dependency interfaces."); }
  check("canonical_block", (await client.getBlock({ blockNumber })).hash === block.hash, "The block hash must remain unchanged during inspection.");
  return { state: checks.every(c => c.passed) ? "READY" as const : "BLOCKED" as const, chainId,
    environment: chainId === 97 ? "BSC_TESTNET" : "LOCAL_EVM", campaignProof: false, financialTransactionCreated: false,
    checkedAt: new Date().toISOString(), blockNumber, blockHash: block.hash, checks, assets, oracles, codeHashes,
    gas: { ownerBalance, estimate: gasEstimate, gasPrice, bufferPercent: 20 },
    note: "Read-only compatibility checks at one block. Feed-to-asset mapping, router trust and token behavior still require human review. Not an audit, fill guarantee or campaign proof." };
}

export async function deploymentPreflight(client: PublicClient, verifier: PublicClient, config: DeploymentConfig, chainId: 97 | 31337 = 97) {
  const primary = await inspectDeployment(client, config, chainId);
  const independent = await inspectDeployment(verifier, config, chainId, primary.blockNumber);
  const sameBlock = primary.blockHash === independent.blockHash;
  // Gas price is a current provider estimate; anchored balances, assets and constructor gas must agree.
  const facts = (r: typeof primary) => ({ assets: r.assets, oracles: r.oracles, codeHashes: r.codeHashes, balance: r.gas.ownerBalance, gas: r.gas.estimate, checks: r.checks });
  const matchingReads = json(facts(primary)) === json(facts(independent));
  const canonical = await Promise.all([client.getBlock({ blockNumber: primary.blockNumber }), verifier.getBlock({ blockNumber: primary.blockNumber })]);
  const stillCanonical = canonical.every(b => b.hash === primary.blockHash);
  return { state: primary.state === "READY" && independent.state === "READY" && sameBlock && matchingReads && stillCanonical ? "READY" as const : "BLOCKED" as const,
    sameBlock, matchingReads, stillCanonical, primary, independent, campaignProof: false, financialTransactionCreated: false };
}
