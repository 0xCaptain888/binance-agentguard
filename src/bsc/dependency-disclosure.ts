import { parseAbi, type Address, type PublicClient } from "viem";

export const controlledDisclosure = {
  dependencyMode: "CONTROLLED_TEST_ASSETS", campaignProof: false, marketEvidence: false,
  note: "Synthetic test tokens, owner-refreshed fixed $1 feeds and pre-funded fixed-rate test router. Not market pricing, external liquidity, audited software or campaign qualification."
} as const;
export type DependencyDisclosure = {
  dependencyMode: "LOCAL_FIXTURES" | "CONTROLLED_TEST_ASSETS" | "UNREVIEWED_DEPENDENCIES";
  marketEvidence: false;
};
const markerAbi = parseAbi(["function controlledTestEnvironment() view returns (bool)"]);
// A marker only selects a more restrictive disclosure. It never attests code or market safety.
export async function dependencyDisclosure(client: PublicClient, router: Address, chainId: number, blockNumber?: bigint): Promise<DependencyDisclosure> {
  if (chainId === 31337) return { dependencyMode: "LOCAL_FIXTURES", marketEvidence: false };
  try {
    if (await client.readContract({ address: router, abi: markerAbi, functionName: "controlledTestEnvironment", blockNumber }) === true)
      return controlledDisclosure;
  } catch { /* Unavailable interfaces never become market evidence. */ }
  return { dependencyMode: "UNREVIEWED_DEPENDENCIES", marketEvidence: false };
}
