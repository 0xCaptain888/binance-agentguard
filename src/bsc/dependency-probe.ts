import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import { BaseError, ContractFunctionRevertedError, getAddress, keccak256, parseAbi, zeroAddress, type Address, type PublicClient } from "viem";
import { testnetClients } from "./deployment.js";
import { failedDependencyReport, saveDependencyReport } from "./dependency-report.js";
import { json } from "./rebalancer.js";

// Official candidates, not a token-to-feed trust registry or deployment approval.
export const dependencySources = {
  router: "https://github.com/pancakeswap/pancake-developer/blob/e4778927f6e69ae6c1d90de08265c1d405f93703/docs/pages/contracts/v2/addresses.md",
  wrappedBNB: "https://github.com/pancakeswap/pancake-swap-sdk/blob/master/src/entities/token.ts",
  feeds: "https://docs.chain.link/data-feeds/price-feeds/addresses?network=bnb-chain",
  tokens: "https://registry.npmjs.org/@pancakeswap/tokens/-/tokens-0.10.0.tgz",
  linkToken: "https://docs.chain.link/resources/link-token-contracts#bnb-chain-testnet"
};
export type ProbeInventory = {
  router: Address; factory: Address; wrappedNative: Address;
  feeds: Record<string, Address>;
  tokens: { asset: string; address: Address; feed: string; decimals: number }[];
};
export const dependencyInventory: ProbeInventory = {
  router: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1",
  factory: "0x6725F303b657a9451d8BA641348b6761A6CC7a17",
  wrappedNative: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",
  feeds: {
    BNB: "0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526",
    ETH: "0x143db3CEEfbdfe5631aDD3E50f7614B6ba708BA7",
    LINK: "0x1B329402Cb1825C6F30A0d92aB9E2862BE47333f",
    CAKE: "0x81faeDDfeBc2F8Ac524327d70Cf913001732224C",
    USDT: "0xEca2605f0BCF2BA5966372C99837b1F182d3D620",
    USDC: "0x90c069C4538adAc136E051052E14c1cD799C41B7",
    BUSD: "0x9331b55D9830EF609A2aBCfAc0FBCE050A52fdEa",
    BTC: "0x5741306c21795FdCBb9b265Ea0255F499DFe515C"
  },
  tokens: [
    { asset: "WBNB", address: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd", feed: "BNB", decimals: 18 },
    { asset: "CAKE", address: "0x8d008B313C1d6C7fE2982F62d32Da7507cF43551", feed: "CAKE", decimals: 18 },
    { asset: "BUSD", address: "0xaB1a4d4f1D656d2450692D237fdD6C7f9146e814", feed: "BUSD", decimals: 18 },
    { asset: "USDT", address: "0x0fB5D7c73FA349A90392f873a4FA1eCf6a3d0a96", feed: "USDT", decimals: 18 },
    { asset: "USDC", address: "0xCA8eB2dec4Fe3a5abbFDc017dE48E461A936623D", feed: "USDC", decimals: 18 },
    { asset: "HBTC", address: "0x3Fb6a6C06c7486BD194BB99a078B89B9ECaF4c82", feed: "BTC", decimals: 18 },
    { asset: "WBTC", address: "0xfC8bFbe9644e1BC836b8821660593e7de711e564", feed: "BTC", decimals: 8 },
    { asset: "LINK", address: "0x84b9B910527Ad5C03A9Ca831909E21e236EA7b06", feed: "LINK", decimals: 18 }
  ]
};
export const dependencyPolicy = { maxActionUsd: 10n * 10n ** 18n, maxSlippageBps: 100, maxOracleAgeSeconds: 3600n };
type ProbePolicy = typeof dependencyPolicy;
const abi = parseAbi([
  "function factory() view returns (address)", "function WETH() view returns (address)",
  "function getPair(address,address) view returns (address)",
  "function description() view returns (string)", "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function symbol() view returns (string)",
  "function getAmountsOut(uint256 amountIn,address[] path) view returns (uint256[] amounts)"
]);
// Bound request concurrency on public RPCs; retain input ordering for comparison.
async function boundedMap<T, R>(values: T[], read: (value: T) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(values.length); let next = 0;
  await Promise.all([0, 1].map(async () => {
    for (;;) { const i = next++; if (i >= values.length) return; result[i] = await read(values[i]); }
  }));
  return result;
}
function reverted(error: unknown) {
  return error instanceof BaseError && error.walk(e => e instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError;
}
export function probeQuoteInput(priceIn: bigint, priceOut: bigint, decimalsIn: number, decimalsOut: number, policy: ProbePolicy) {
  if (priceIn <= 0n || priceOut <= 0n || ![decimalsIn, decimalsOut].every(n => Number.isInteger(n) && n >= 0 && n <= 18)) throw new Error("Invalid quote prerequisites");
  const amountIn = policy.maxActionUsd * 10n ** BigInt(decimalsIn) / priceIn;
  const notionalUsd = amountIn * priceIn / 10n ** BigInt(decimalsIn);
  const fair = notionalUsd * 10n ** BigInt(decimalsOut) / priceOut;
  const oracleFloor = (fair * BigInt(10000 - policy.maxSlippageBps) + 9999n) / 10000n;
  return { amountIn, notionalUsd, oracleFloor };
}
export async function inspectDependencies(rpc: PublicClient, blockNumber: bigint, inventory = dependencyInventory, policy = dependencyPolicy) {
  const anchored = await rpc.getBlock({ blockNumber });
  const [routerCode, factoryCode, nativeCode, actualFactory, actualNative] = await Promise.all([
    rpc.getCode({ address: inventory.router, blockNumber }), rpc.getCode({ address: inventory.factory, blockNumber }),
    rpc.getCode({ address: inventory.wrappedNative, blockNumber }),
    rpc.readContract({ address: inventory.router, abi, functionName: "factory", blockNumber }),
    rpc.readContract({ address: inventory.router, abi, functionName: "WETH", blockNumber })
  ]);
  const rounds = await boundedMap(Object.entries(inventory.feeds), async ([asset, value]) => {
    const address = getAddress(value);
    try {
      const code = await rpc.getCode({ address, blockNumber });
      if (!code || code === "0x") return { asset, address, status: "NO_CODE" as const };
      const [description, decimals, round] = await Promise.all([
        rpc.readContract({ address, abi, functionName: "description", blockNumber }),
        rpc.readContract({ address, abi, functionName: "decimals", blockNumber }),
        rpc.readContract({ address, abi, functionName: "latestRoundData", blockNumber })
      ]);
      const ageSeconds = anchored.timestamp - round[3];
      const metadataValid = decimals >= 0 && decimals <= 18 && description.length > 0 && description.length <= 64;
      const priceUsd = metadataValid ? round[1] * 10n ** 18n / 10n ** BigInt(decimals) : 0n;
      return { asset, address, status: "READ" as const, codeHash: keccak256(code), description, decimals, priceUsd,
        roundId: round[0], answer: round[1], startedAt: round[2], updatedAt: round[3], answeredInRound: round[4], ageSeconds,
        fresh: metadataValid && priceUsd > 0n && round[3] > 0n && ageSeconds >= 0n &&
          ageSeconds <= policy.maxOracleAgeSeconds && round[4] >= round[0] };
    } catch { return { asset, address, status: "UNAVAILABLE" as const }; }
  });
  const assets = await boundedMap(inventory.tokens, async token => {
    try {
      const code = await rpc.getCode({ address: token.address, blockNumber });
      if (!code || code === "0x") return { ...token, status: "NO_CODE" as const };
      const [symbol, decimals] = await Promise.all([
        rpc.readContract({ address: token.address, abi, functionName: "symbol", blockNumber }),
        rpc.readContract({ address: token.address, abi, functionName: "decimals", blockNumber })
      ]);
      return { ...token, status: "READ" as const, codeHash: keccak256(code), symbol, observedDecimals: decimals,
        metadataValid: decimals === token.decimals && decimals >= 0 && decimals <= 18 && symbol.length > 0 && symbol.length <= 64 };
    } catch { return { ...token, status: "UNAVAILABLE" as const }; }
  });
  const combinations = assets.flatMap((a, i) => assets.slice(i + 1).map(b => [a, b] as const));
  const routes = await boundedMap(combinations, async ([a, b]) => {
    const base = { assets: [a.asset, b.asset], tokens: [a.address, b.address], mappingReviewed: false as const };
    const feed0 = rounds.find(r => r.asset === a.feed), feed1 = rounds.find(r => r.asset === b.feed);
    if (a.status !== "READ" || b.status !== "READ" || !a.metadataValid || !b.metadataValid ||
      !feed0?.priceUsd || !feed1?.priceUsd || feed0.priceUsd <= 0n || feed1.priceUsd <= 0n) {
      return { ...base, status: "PREREQUISITES_UNAVAILABLE" as const, compatibleCandidate: false };
    }
    try {
      const pair = await rpc.readContract({ address: inventory.factory, abi, functionName: "getPair", args: [a.address, b.address], blockNumber });
      if (pair.toLowerCase() === zeroAddress) return { ...base, pair, status: "NO_PAIR" as const, compatibleCandidate: false };
      const code = await rpc.getCode({ address: pair, blockNumber });
      if (!code || code === "0x") return { ...base, pair, status: "PAIR_NO_CODE" as const, compatibleCandidate: false };
      const quotes = [];
      // Keep stale-feed quotes as observations; they can never be compatible.
      for (const direction of [0, 1] as const) {
        const input = probeQuoteInput(direction === 0 ? feed0.priceUsd : feed1.priceUsd,
          direction === 0 ? feed1.priceUsd : feed0.priceUsd, direction === 0 ? a.decimals : b.decimals,
          direction === 0 ? b.decimals : a.decimals, policy);
        try {
          const amounts = await rpc.readContract({ address: inventory.router, abi, functionName: "getAmountsOut",
            args: [input.amountIn, direction === 0 ? [a.address, b.address] : [b.address, a.address]], blockNumber });
          const aboveFloor = input.amountIn > 0n && input.notionalUsd > 0n && input.oracleFloor > 0n &&
            amounts.length === 2 && amounts[0] === input.amountIn && amounts[1] >= input.oracleFloor;
          quotes.push({ direction, ...input, status: "READ" as const, amountOut: amounts[1], aboveFloor });
        } catch (error) {
          quotes.push({ direction, ...input, status: reverted(error) ? "QUOTE_REVERTED" as const : "UNAVAILABLE" as const });
        }
      }
      const feedsFresh = !!feed0.fresh && !!feed1.fresh;
      return { ...base, pair, pairCodeHash: keccak256(code), status: "INSPECTED" as const, feedsFresh, quotes,
        compatibleCandidate: feedsFresh && quotes.every(q => "aboveFloor" in q && q.aboveFloor) };
    } catch { return { ...base, status: "UNAVAILABLE" as const, compatibleCandidate: false }; }
  });
  const complete = !rounds.some(r => r.status === "UNAVAILABLE") && !assets.some(a => a.status === "UNAVAILABLE") &&
    !routes.some(r => r.status === "UNAVAILABLE" || ("quotes" in r && r.quotes.some(q => q.status === "UNAVAILABLE")));
  return { blockHash: anchored.hash, timestamp: anchored.timestamp, complete,
    router: { address: inventory.router, codeHash: keccak256(routerCode ?? "0x"), factoryCodeHash: keccak256(factoryCode ?? "0x"),
      factory: actualFactory, wrappedNative: actualNative, matchesPublishedAddresses:
        !!routerCode && routerCode !== "0x" && !!factoryCode && factoryCode !== "0x" && !!nativeCode && nativeCode !== "0x" &&
        getAddress(actualFactory) === getAddress(inventory.factory) && getAddress(actualNative) === getAddress(inventory.wrappedNative) },
    rounds, assets, routes };
}
export async function probeDependencies(client: PublicClient, verifier: PublicClient, inventory = dependencyInventory, policy = dependencyPolicy) {
  if (await client.getChainId() !== 97 || await verifier.getChainId() !== 97) throw new Error("Only chain 97 is supported");
  const block = await client.getBlock();
  if (block.number === null || !block.hash) throw new Error("Mined block required");
  const primary = await inspectDependencies(client, block.number, inventory, policy);
  const independent = await inspectDependencies(verifier, block.number, inventory, policy);
  const heads = await Promise.all([client.getBlock({ blockNumber: block.number }), verifier.getBlock({ blockNumber: block.number })]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const recent = block.timestamp >= now - 120n && block.timestamp <= now + 30n;
  const matchingReads = json(primary) === json(independent);
  const canonical = primary.blockHash === block.hash && independent.blockHash === block.hash && heads.every(b => b.hash === block.hash);
  const state = !recent || !matchingReads || !canonical ? "RPC_VERIFICATION_FAILED" :
    !primary.complete || !independent.complete ? "DEPENDENCY_READS_INCOMPLETE" : "CANDIDATES_INSPECTED";
  return { schemaVersion: 2, state, chainId: 97, environment: "BSC_TESTNET", checkedAt: new Date().toISOString(), blockNumber: block.number,
    policy, recent, matchingReads, canonical, sources: dependencySources, primary, independent,
    campaignProof: false, financialTransactionCreated: false, deploymentReady: false,
    note: "Read-only candidate discovery. Every unordered token combination is evaluated; existing direct pairs are quoted in both directions when prerequisites are readable. Candidate feed mappings are unreviewed. Full deployment preflight and an explicitly chosen operator are still required." };
}
async function main() {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 120000);
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    try { loadEnvFile(".env"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const { client, verifier } = await testnetClients(process.env.BSC_TESTNET_RPC_URL, process.env.BSC_VERIFIER_RPC_URL, controller.signal);
    const result = await probeDependencies(client, verifier);
    controller.signal.throwIfAborted();
    await saveDependencyReport(".runtime/bsc-dependencies.json", result);
    console.log(json(result));
    if (result.state !== "CANDIDATES_INSPECTED") process.exitCode = 2;
  } catch {
    // A failed refresh replaces an old successful snapshot, rather than leaving it looking current.
    await saveDependencyReport(".runtime/bsc-dependencies.json", failedDependencyReport());
    console.error("Dependency probe unavailable. Check the two configured chain-97 RPCs. No endpoint secrets were printed and no transaction was sent.");
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  console.error("Dependency report could not be saved. No transaction was sent."); process.exitCode = 1;
});
