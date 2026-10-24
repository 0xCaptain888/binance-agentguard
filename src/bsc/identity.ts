import { createHash } from "node:crypto";
import { decodeEventLog, encodeFunctionData, getAddress, parseAbi, TransactionReceiptNotFoundError,
  type Address, type Hash, type PublicClient } from "viem";
import { json } from "./rebalancer.js";

// Source: erc-8004/erc-8004-contracts README, BSC Testnet deployment.
// Presence/owner must still be checked on RPC before use.
export const identityRegistry = getAddress("0x8004A818BFB912233c491871b3d84c89A494BD9e");
export const identityAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "event Registered(uint256 indexed agentId,string agentURI,address indexed owner)"
]);

export type Registration = { agentId: string; owner: Address; transactionHash: Hash; evidenceHash: string };

function publicOrigin(baseUrl: string) {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    !url.hostname.includes(".") || url.hostname === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.endsWith(".localhost"))
    throw new Error("Use a public HTTPS hostname origin before registration");
  return url.origin;
}

export function registrationUri(baseUrl: string) { return `${publicOrigin(baseUrl)}/.well-known/agent-registration.json`; }

export function registrationCard(baseUrl: string, registration?: Registration) {
  const origin = new URL(baseUrl).origin;
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "AgentGuard BSC Rebalancer",
    description: "Policy-bounded, two-asset rebalancing. Per-owner vaults enforce USD budgets, oracle freshness, slippage and target improvement. Independent RPC verification. Testnet reference implementation.",
    image: `${origin}/bsc/mark.svg`,
    services: [{ name: "web", endpoint: `${origin}/bsc/` },
      { name: "AgentGuard REST", endpoint: `${origin}/api/v1`, version: "1.0.0" }],
    category: "rebalancing", chainId: 97, x402Support: false,
    active: !!registration,
    registrations: registration ? [{ agentId: registration.agentId, agentRegistry: `eip155:97:${identityRegistry}` }] : [],
    supportedTrust: [],
    ...(registration ? { owner: registration.owner, registrationEvidence: {
      transactionHash: registration.transactionHash, evidenceHash: registration.evidenceHash
    } } : {}),
    status: registration ? "REGISTERED_NOT_MARKETPLACE_VERIFIED" : "UNREGISTERED_DEVELOPMENT",
    marketplace: { listed: false, adapterStatus: "PENDING_MARKETPLACE_SPECIFICATION" }
  };
}

export function registrationTransaction(baseUrl: string, owner: Address) {
  const agentURI = registrationUri(baseUrl);
  return { from: owner, to: identityRegistry, chainId: "0x61", value: "0x0",
    data: encodeFunctionData({ abi: identityAbi, functionName: "register", args: [agentURI] }) };
}

export async function prepareRegistration(client: PublicClient, baseUrl: string, owner: Address,
  chainId: 97 | 31337 = 97, registry: Address = identityRegistry) {
  if (await client.getChainId() !== chainId) throw new Error("Wrong registration chain");
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const code = await client.getCode({ address: registry, blockNumber });
  if (!code || code === "0x") throw new Error("ERC-8004 identity registry has no contract code");
  const agentURI = registrationUri(baseUrl);
  const data = encodeFunctionData({ abi: identityAbi, functionName: "register", args: [agentURI] });
  await client.call({ account: owner, to: registry, data, blockNumber });
  return { status: "UNSIGNED_ERC8004_REGISTRATION", chainId, environment: chainId === 97 ? "BSC_TESTNET" : "LOCAL_EVM",
    campaignProof: false, registry, owner, agentURI, simulatedAtBlock: blockNumber,
    transaction: { from: owner, to: registry, chainId: `0x${chainId.toString(16)}`, value: "0x0", data },
    note: "Unsigned identity registration. The owner wallet must confirm once. Registration alone is not a marketplace listing or campaign qualification." };
}

export async function verifyRegistration(primary: PublicClient, verifier: PublicClient, baseUrl: string, owner: Address,
  transactionHash: Hash, chainId: 97 | 31337 = 97, registry: Address = identityRegistry) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) throw new Error("Valid registration transaction hash required");
  if (await primary.getChainId() !== chainId || await verifier.getChainId() !== chainId) throw new Error("Wrong registration verification chain");
  const agentURI = registrationUri(baseUrl);
  const expectedData = encodeFunctionData({ abi: identityAbi, functionName: "register", args: [agentURI] });
  const base = { chainId, environment: chainId === 97 ? "BSC_TESTNET" : "LOCAL_EVM", campaignProof: false,
    registry, owner, agentURI, transactionHash };
  let receipt;
  try { receipt = await verifier.getTransactionReceipt({ hash: transactionHash }); }
  catch (error) {
    if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
    return { ...base, state: "PENDING" as const, reason: "Registration not yet included by verifier RPC" };
  }
  const head = await verifier.getBlockNumber({ cacheTime: 0 });
  if (head < receipt.blockNumber + 1n) return { ...base, state: "PENDING" as const, reason: "Waiting for two confirmations" };
  const [tx, block, independentReceipt, independentBlock] = await Promise.all([
    verifier.getTransaction({ hash: transactionHash }), verifier.getBlock({ blockNumber: receipt.blockNumber }),
    primary.getTransactionReceipt({ hash: transactionHash }), primary.getBlock({ blockNumber: receipt.blockNumber })
  ]);
  let event: { agentId: bigint; agentURI: string; owner: Address } | undefined;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== registry.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: identityAbi, eventName: "Registered", data: log.data, topics: log.topics });
      event = decoded.args as typeof event;
    } catch { /* Ignore other registry events. */ }
  }
  const eventAgentId = event?.agentId;
  const checks: Record<string, boolean> = {
    succeeded: receipt.status === "success", canonical: block.hash === receipt.blockHash && tx.blockHash === receipt.blockHash && tx.blockNumber === receipt.blockNumber,
    receiptBound: receipt.transactionHash.toLowerCase() === transactionHash.toLowerCase(), ownerSender: tx.from.toLowerCase() === owner.toLowerCase(),
    registryTarget: tx.to?.toLowerCase() === registry.toLowerCase(), exactCalldata: tx.input.toLowerCase() === expectedData.toLowerCase(), zeroNativeValue: tx.value === 0n,
    registeredEvent: !!eventAgentId || eventAgentId === 0n, eventOwner: event?.owner?.toLowerCase() === owner.toLowerCase(), eventUri: event?.agentURI === agentURI,
    independentReceipt: independentReceipt.blockHash === receipt.blockHash && independentReceipt.status === receipt.status &&
      independentReceipt.transactionHash.toLowerCase() === receipt.transactionHash.toLowerCase(),
    independentBlock: independentBlock.hash === block.hash, historicalOwner: false, historicalUri: false, currentOwner: false, currentUri: false, registryCode: false
  };
  if (eventAgentId !== undefined && Object.entries(checks).filter(([key]) => !["historicalOwner", "historicalUri", "currentOwner", "currentUri", "registryCode"].includes(key)).every(([, ok]) => ok)) {
    const [historicalOwner, historicalUri, currentOwner, currentUri, code] = await Promise.all([
      verifier.readContract({ address: registry, abi: identityAbi, functionName: "ownerOf", args: [eventAgentId], blockNumber: receipt.blockNumber }),
      verifier.readContract({ address: registry, abi: identityAbi, functionName: "tokenURI", args: [eventAgentId], blockNumber: receipt.blockNumber }),
      primary.readContract({ address: registry, abi: identityAbi, functionName: "ownerOf", args: [eventAgentId] }),
      primary.readContract({ address: registry, abi: identityAbi, functionName: "tokenURI", args: [eventAgentId] }),
      primary.getCode({ address: registry, blockNumber: receipt.blockNumber })
    ]);
    checks.historicalOwner = historicalOwner.toLowerCase() === owner.toLowerCase(); checks.historicalUri = historicalUri === agentURI;
    checks.currentOwner = currentOwner.toLowerCase() === owner.toLowerCase(); checks.currentUri = currentUri === agentURI;
    checks.registryCode = !!code && code !== "0x";
  }
  checks.canonical = checks.canonical && (await verifier.getBlock({ blockNumber: receipt.blockNumber })).hash === receipt.blockHash;
  const reasons = Object.keys(checks).filter(key => !checks[key]);
  const result = { ...base, state: reasons.length ? "MISMATCH" as const : "VERIFIED" as const,
    agentId: eventAgentId?.toString(), blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
    confirmations: head - receipt.blockNumber + 1n, checks, reasons, verifiedAt: new Date().toISOString(),
    note: "Identity registration attestation only. This does not prove a marketplace listing, independent hires, qualifying activity or campaign eligibility." };
  return { ...result, evidenceHash: `sha256:${createHash("sha256").update(json(result)).digest("hex")}` };
}

export function verifiedRegistration(proof: Awaited<ReturnType<typeof verifyRegistration>>): Registration | undefined {
  if (proof.state !== "VERIFIED" || !proof.agentId || !proof.evidenceHash) return undefined;
  return { agentId: proof.agentId, owner: proof.owner, transactionHash: proof.transactionHash, evidenceHash: proof.evidenceHash };
}
