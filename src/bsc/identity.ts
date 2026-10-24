import { encodeFunctionData, getAddress, parseAbi, type Address } from "viem";

// Source: erc-8004/erc-8004-contracts README, BSC Testnet deployment.
// Presence/owner must still be checked on RPC before use.
export const identityRegistry = getAddress("0x8004A818BFB912233c491871b3d84c89A494BD9e");
export const identityAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "event Registered(uint256 indexed agentId,string agentURI,address indexed owner)"
]);

export function registrationCard(baseUrl: string, registration?: { agentId: string; owner: Address }) {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "AgentGuard BSC Rebalancer",
    description: "Policy-bounded, two-asset rebalancing. Per-owner vaults enforce USD budgets, oracle freshness, slippage and target improvement. Independent RPC verification. Testnet reference implementation.",
    image: `${baseUrl}/bsc/mark.svg`,
    services: [{ name: "web", endpoint: `${baseUrl}/bsc/` },
      { name: "AgentGuard REST", endpoint: `${baseUrl}/api/v1`, version: "1.0.0" }],
    category: "rebalancing", chainId: 97, x402Support: false,
    active: !!registration,
    registrations: registration ? [{ agentId: registration.agentId, agentRegistry: `eip155:97:${identityRegistry}` }] : [],
    supportedTrust: [],
    ...(registration ? { owner: registration.owner } : {}),
    status: registration ? "REGISTERED_NOT_MARKETPLACE_VERIFIED" : "UNREGISTERED_DEVELOPMENT",
    marketplace: { listed: false, adapterStatus: "PENDING_MARKETPLACE_SPECIFICATION" }
  };
}

export function registrationTransaction(baseUrl: string, owner: Address) {
  if (new URL(baseUrl).protocol !== "https:") throw new Error("Publish an HTTPS agent card before registering");
  return { from: owner, to: identityRegistry, chainId: "0x61", value: "0x0",
    data: encodeFunctionData({ abi: identityAbi, functionName: "register", args: [`${baseUrl}/.well-known/agent-registration.json`] }) };
}
