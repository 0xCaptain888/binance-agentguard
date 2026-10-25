import { mkdir, writeFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { getAddress, keccak256, parseAbi, type PublicClient } from "viem";
import { testnetClients } from "./deployment.js";
import { json } from "./rebalancer.js";

// Official address candidates, not a token-to-feed trust registry or deployment approval.
const sources = {
  router: "https://github.com/pancakeswap/pancake-developer/blob/e4778927f6e69ae6c1d90de08265c1d405f93703/docs/pages/contracts/v2/addresses.md",
  wrappedBNB: "https://github.com/pancakeswap/pancake-swap-sdk/blob/master/src/entities/token.ts",
  feeds: "https://docs.chain.link/data-feeds/price-feeds/addresses?network=bnb-chain",
  tokens: "https://registry.npmjs.org/@pancakeswap/tokens/-/tokens-0.10.0.tgz"
};
const router = "0xD99D1c33F9fC3444f8101754aBC46c52416550D1";
const factory = "0x6725F303b657a9451d8BA641348b6761A6CC7a17";
const wrappedBNB = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";
const feeds = {
  BNB: "0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526",
  ETH: "0x143db3CEEfbdfe5631aDD3E50f7614B6ba708BA7",
  LINK: "0x1B329402Cb1825C6F30A0d92aB9E2862BE47333f",
  CAKE: "0x81faeDDfeBc2F8Ac524327d70Cf913001732224C",
  USDT: "0xEca2605f0BCF2BA5966372C99837b1F182d3D620",
  USDC: "0x90c069C4538adAc136E051052E14c1cD799C41B7",
  BUSD: "0x9331b55D9830EF609A2aBCfAc0FBCE050A52fdEa"
} as const;
const tokens = {
  CAKE: "0x8d008B313C1d6C7fE2982F62d32Da7507cF43551",
  BUSD: "0xaB1a4d4f1D656d2450692D237fdD6C7f9146e814",
  USDT: "0x0fB5D7c73FA349A90392f873a4FA1eCf6a3d0a96",
  USDC: "0xCA8eB2dec4Fe3a5abbFDc017dE48E461A936623D"
} as const;
const abi = parseAbi([
  "function factory() view returns (address)", "function WETH() view returns (address)",
  "function description() view returns (string)", "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function symbol() view returns (string)",
  "function getAmountsOut(uint256 amountIn,address[] path) view returns (uint256[] amounts)"
]);

async function main() {
  try { loadEnvFile(".env"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const { client, verifier } = await testnetClients(process.env.BSC_TESTNET_RPC_URL, process.env.BSC_VERIFIER_RPC_URL);
  const block = await client.getBlock();
  if (block.number === null || !block.hash) throw new Error("Mined block required");
  const blockNumber = block.number;
  const maxAgeSeconds = 3600n;
  const inspect = async (rpc: PublicClient) => {
    const anchored = await rpc.getBlock({ blockNumber });
    const code = await rpc.getCode({ address: router, blockNumber });
    const [actualFactory, actualWBNB, tokenCode] = await Promise.all([
      rpc.readContract({ address: router, abi, functionName: "factory", blockNumber }),
      rpc.readContract({ address: router, abi, functionName: "WETH", blockNumber }),
      rpc.getCode({ address: wrappedBNB, blockNumber })
    ]);
    const rounds = await Promise.all(Object.entries(feeds).map(async ([asset, value]) => {
      const address = getAddress(value);
      try {
        const [description, decimals, round] = await Promise.all([
          rpc.readContract({ address, abi, functionName: "description", blockNumber }),
          rpc.readContract({ address, abi, functionName: "decimals", blockNumber }),
          rpc.readContract({ address, abi, functionName: "latestRoundData", blockNumber })
        ]);
        const ageSeconds = anchored.timestamp - round[3];
        return { asset, address, description, decimals, roundId: round[0], answer: round[1],
          startedAt: round[2], updatedAt: round[3], answeredInRound: round[4], ageSeconds,
          fresh: round[1] > 0n && round[3] > 0n && ageSeconds >= 0n && ageSeconds <= maxAgeSeconds && round[4] >= round[0] };
      } catch { return { asset, address, error: "Feed unavailable at the anchored block" }; }
    }));
    const routes = await Promise.all(Object.entries(tokens).map(async ([asset, token]) => {
      const bnb = rounds.find(r => r.asset === "BNB"), other = rounds.find(r => r.asset === asset);
      try {
        const [symbol, decimals] = await Promise.all([
          rpc.readContract({ address: token, abi, functionName: "symbol", blockNumber }),
          rpc.readContract({ address: token, abi, functionName: "decimals", blockNumber })
        ]);
        if (!bnb?.answer || !other?.answer || bnb.answer <= 0n || other.answer <= 0n ||
          decimals > 18 || bnb.decimals !== 8 || other.decimals !== 8) throw new Error();
        const quotes = await Promise.all([0, 1].map(async direction => {
          const priceIn = direction === 0 ? bnb.answer! : other.answer!;
          const priceOut = direction === 0 ? other.answer! : bnb.answer!;
          const inDecimals = direction === 0 ? 18 : decimals;
          const outDecimals = direction === 0 ? decimals : 18;
          const amountIn = 10n * 10n ** 8n * 10n ** BigInt(inDecimals) / priceIn;
          try {
            const amounts = await rpc.readContract({ address: router, abi, functionName: "getAmountsOut",
              args: [amountIn, direction === 0 ? [wrappedBNB, token] : [token, wrappedBNB]], blockNumber });
            const notional = amountIn * priceIn / 10n ** BigInt(inDecimals);
            const fair = notional * 10n ** BigInt(outDecimals) / priceOut;
            const floor = (fair * 9900n + 9999n) / 10000n;
            return { direction, amountIn, amountOut: amounts[1], oracleFloor: floor,
              aboveFloor: amountIn > 0n && floor > 0n && amounts.length === 2 && amounts[0] === amountIn && amounts[1] >= floor };
          } catch { return { direction, amountIn, error: "Direct quote unavailable" }; }
        }));
        return { asset, token, symbol, decimals, feedsFresh: !!bnb.fresh && !!other.fresh, quotes,
          compatibleCandidate: !!bnb.fresh && !!other.fresh && quotes.every(q => "aboveFloor" in q && q.aboveFloor),
          mappingReviewed: false };
      } catch { return { asset, token, error: "Token metadata or feed unavailable", compatibleCandidate: false }; }
    }));
    return { blockHash: anchored.hash, timestamp: anchored.timestamp,
      router: { address: router, codeHash: keccak256(code ?? "0x"), factory: actualFactory, wrappedBNB: actualWBNB,
        matchesPublishedAddresses: !!code && code !== "0x" && !!tokenCode && tokenCode !== "0x" &&
          getAddress(actualFactory) === getAddress(factory) && getAddress(actualWBNB) === getAddress(wrappedBNB) },
      rounds, routes };
  };
  const primary = await inspect(client), independent = await inspect(verifier);
  const heads = await Promise.all([client.getBlock({ blockNumber }), verifier.getBlock({ blockNumber })]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const recent = block.timestamp >= now - 120n && block.timestamp <= now + 30n;
  const matchingReads = json(primary) === json(independent);
  const canonical = heads.every(b => b.hash === block.hash);
  const result = { state: recent && matchingReads && canonical ? "CANDIDATES_INSPECTED" : "RPC_VERIFICATION_FAILED",
    chainId: 97, environment: "BSC_TESTNET", checkedAt: new Date().toISOString(), blockNumber,
    maxOracleAgeSeconds: maxAgeSeconds, recent, matchingReads, canonical, sources, primary, independent,
    campaignProof: false, financialTransactionCreated: false, deploymentReady: false,
    note: "Read-only dependency discovery. Fresh feed candidates are not token mappings. A second reviewed token, direct pair liquidity, operator and full deployment preflight are still required. No signature or broadcast." };
  await mkdir(".runtime", { recursive: true });
  await writeFile(".runtime/bsc-dependencies.json", json(result) + "\n", { mode: 0o600 });
  console.log(json(result));
  if (result.state === "RPC_VERIFICATION_FAILED") process.exitCode = 2;
}
main().catch(() => {
  console.error("Dependency probe unavailable. Check the two configured chain-97 RPCs. No endpoint secrets were printed and no transaction was sent.");
  process.exitCode = 1;
});
