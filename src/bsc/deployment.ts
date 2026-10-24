import { createHash } from "node:crypto";
import { createPublicClient, encodeDeployData, getAddress, getContractAddress, http, isAddress, keccak256,
  parseUnits, TransactionReceiptNotFoundError, zeroAddress, type Address, type Hash, type Hex, type PublicClient } from "viem";
import { compileContracts } from "./compiler.js";
import { json } from "./rebalancer.js";

const addressKeys = ["owner", "operator", "token0", "token1", "router", "feed0", "feed1"] as const;
export type DeploymentConfig = Record<typeof addressKeys[number], Address> & {
  policy: { maxActionUsd: bigint; maxDailyUsd: bigint; targetToken0Bps: number; maxSlippageBps: number; cooldownSeconds: number; maxOracleAge: number };
  publicBaseUrl: string;
};
export function parseDeploymentConfig(value: unknown): DeploymentConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Deployment config must be an object");
  const input = value as Record<string, any>;
  const addresses = Object.fromEntries(addressKeys.map(key => {
    if (typeof input[key] !== "string" || !isAddress(input[key]) || input[key].toLowerCase() === zeroAddress) throw new Error(`Configure a nonzero ${key}`);
    return [key, getAddress(input[key])];
  })) as Record<typeof addressKeys[number], Address>;
  if (addresses.token0 === addresses.token1) throw new Error("Configure two different assets");
  const p = input.policy;
  if (!p || typeof p !== "object") throw new Error("Policy required");
  const usd = (key: string) => {
    if (typeof p[key] !== "string" || !/^(0|[1-9]\d{0,18})(\.\d{1,18})?$/.test(p[key])) throw new Error(`Invalid ${key}`);
    return parseUnits(p[key], 18);
  };
  const integer = (key: string, min: number, max: number) => {
    if (!Number.isSafeInteger(p[key]) || p[key] < min || p[key] > max) throw new Error(`Invalid ${key}`);
    return p[key] as number;
  };
  const policy = { maxActionUsd: usd("maxActionUsd"), maxDailyUsd: usd("maxDailyUsd"),
    targetToken0Bps: integer("targetToken0Bps", 1, 9999), maxSlippageBps: integer("maxSlippageBps", 0, 500),
    cooldownSeconds: integer("cooldownSeconds", 0, 4294967295), maxOracleAge: integer("maxOracleAge", 1, 4294967295) };
  if (policy.maxActionUsd <= 0n || policy.maxDailyUsd < policy.maxActionUsd) throw new Error("Invalid USD budgets");
  let publicBaseUrl = "";
  if (input.publicBaseUrl) {
    const url = new URL(input.publicBaseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Use a public HTTPS origin without path, query or credentials");
    publicBaseUrl = url.origin;
  }
  return { ...addresses, policy, publicBaseUrl };
}
export function deploymentData(config: DeploymentConfig): Hex {
  const { owner, operator, token0, token1, router, feed0, feed1, policy } = config;
  return encodeDeployData({ ...compileContracts().AgentGuardVault, args: [owner, operator, token0, token1, router, feed0, feed1, policy] });
}
export async function testnetClients(rpcUrl?: string, verifierRpcUrl?: string) {
  const endpoint = (value?: string) => {
    if (!value || new URL(value).protocol !== "https:") throw new Error("Configure HTTPS BSC testnet RPC endpoints");
    return value;
  };
  const primary = endpoint(rpcUrl), secondary = endpoint(verifierRpcUrl);
  if (new URL(primary).hostname === new URL(secondary).hostname) throw new Error("Use different RPC providers for deployment verification");
  const client = createPublicClient({ transport: http(primary), cacheTime: 0 });
  const verifier = createPublicClient({ transport: http(secondary), cacheTime: 0 });
  if ((await client.getChainId()) !== 97 || (await verifier.getChainId()) !== 97) throw new Error("Only BSC testnet 97 is enabled");
  return { client, verifier };
}
export async function prepareDeployment(client: PublicClient, config: DeploymentConfig, chainId: 97 | 31337 = 97) {
  if (await client.getChainId() !== chainId) throw new Error("Wrong deployment chain");
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  for (const key of ["token0", "token1", "router", "feed0", "feed1"] as const) {
    const code = await client.getCode({ address: config[key], blockNumber });
    if (!code || code === "0x") throw new Error(`${key} has no contract code`);
  }
  const data = deploymentData(config);
  // Simulation checks constructor invariants, not router/feed economic safety.
  const simulation = await client.call({ account: config.owner, data, blockNumber });
  if (!simulation.data || simulation.data === "0x") throw new Error("Deployment simulation returned no runtime code");
  return { status: "UNSIGNED_TESTNET_DEPLOYMENT", chainId, environment: chainId === 97 ? "BSC_TESTNET" : "LOCAL_EVM",
    campaignProof: false, createdAt: new Date().toISOString(), simulatedAtBlock: blockNumber, config,
    initCodeHash: keccak256(data), transaction: { from: config.owner, data, value: "0x0", chainId: `0x${chainId.toString(16)}` },
    note: "Unsigned deployment. Review dependencies and policy. Wallet confirmation spends test gas; no deposits or token approvals are bundled." };
}
export async function verifyDeployment(client: PublicClient, config: DeploymentConfig, transactionHash: Hash, chainId: 97 | 31337 = 97) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) throw new Error("Valid deployment transaction hash required");
  if (await client.getChainId() !== chainId) throw new Error("Wrong verification chain");
  const base = { chainId, environment: chainId === 97 ? "BSC_TESTNET" : "LOCAL_EVM", campaignProof: false,
    transactionHash, initCodeHash: keccak256(deploymentData(config)) };
  let receipt;
  try { receipt = await client.getTransactionReceipt({ hash: transactionHash }); }
  catch (error) {
    if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
    return { ...base, state: "PENDING" as const, reason: "Transaction not yet included by verifier RPC" };
  }
  const head = await client.getBlockNumber({ cacheTime: 0 });
  if (head < receipt.blockNumber + 1n) return { ...base, state: "PENDING" as const, reason: "Waiting for two confirmations" };
  const [tx, block] = await Promise.all([client.getTransaction({ hash: transactionHash }), client.getBlock({ blockNumber: receipt.blockNumber })]);
  const predicted = getContractAddress({ from: config.owner, nonce: BigInt(tx.nonce) });
  const checks: Record<string, boolean> = {
    succeeded: receipt.status === "success", canonical: block.hash === receipt.blockHash && tx.blockHash === receipt.blockHash && tx.blockNumber === receipt.blockNumber,
    receiptBound: receipt.transactionHash.toLowerCase() === transactionHash.toLowerCase() && receipt.from.toLowerCase() === config.owner.toLowerCase(),
    ownerSender: tx.from.toLowerCase() === config.owner.toLowerCase(), contractCreation: tx.to === null && receipt.to === null,
    exactInitCode: tx.input.toLowerCase() === deploymentData(config).toLowerCase(), zeroNativeValue: tx.value === 0n,
    predictedAddress: receipt.contractAddress?.toLowerCase() === predicted.toLowerCase(), runtimeMatches: false, initialConfigurationMatches: false
  };
  // Never interpret arbitrary contracts as a vault after a transaction mismatch.
  if (Object.entries(checks).filter(([key]) => !["runtimeMatches", "initialConfigurationMatches"].includes(key)).every(([, ok]) => ok)) {
    const address = receipt.contractAddress!, abi = compileContracts().AgentGuardVault.abi;
    const [code, simulated, ...values] = await Promise.all([
      client.getCode({ address, blockNumber: receipt.blockNumber }),
      client.call({ account: config.owner, data: deploymentData(config), blockNumber: receipt.blockNumber }),
      ...addressKeys.map(functionName => client.readContract({ address, abi, functionName, blockNumber: receipt.blockNumber })),
      client.readContract({ address, abi, functionName: "policy", blockNumber: receipt.blockNumber })
    ]);
    // Creation eth_call returns compiler runtime with all private/public immutables.
    // Archive-state failures propagate; they are not successful attestations.
    checks.runtimeMatches = !!code && code !== "0x" && code.toLowerCase() === simulated.data?.toLowerCase();
    checks.initialConfigurationMatches = addressKeys.every((key, i) => typeof values[i] === "string" && String(values[i]).toLowerCase() === config[key].toLowerCase()) &&
      json(values[addressKeys.length]) === json(Object.values(config.policy));
  }
  checks.canonical = checks.canonical && (await client.getBlock({ blockNumber: receipt.blockNumber })).hash === receipt.blockHash;
  const reasons = Object.keys(checks).filter(key => !checks[key]);
  const result = { ...base, state: reasons.length ? "MISMATCH" as const : "VERIFIED" as const, contractAddress: receipt.contractAddress,
    blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, confirmations: head - receipt.blockNumber + 1n, checks, reasons,
    verifiedAt: new Date().toISOString(), note: "Deployment-block attestation only. Policy may change later. This is not an audit, identity registration, listing or campaign qualification." };
  return { ...result, evidenceHash: `sha256:${createHash("sha256").update(json(result)).digest("hex")}` };
}
