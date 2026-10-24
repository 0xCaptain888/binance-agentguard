import { mkdir, writeFile } from "node:fs/promises";
import { json } from "./rebalancer.js";

// A read-only probe. No identity mint, marketplace listing, hire, signature or payment.
const endpoint = "https://platform-backend.prod.termix.live/api/v1/config/contracts";
let probe: { status: string; httpStatus?: number };
try {
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(15000) });
  probe = { status: response.ok ? "REACHABLE_NOT_AUTHENTICATED" : "HTTP_ERROR", httpStatus: response.status };
  // Availability is not evidence that our agent is listed or that testnet is supported.
} catch { probe = { status: "UNREACHABLE" }; }
const report = {
  checkedAt: new Date().toISOString(), campaign: "BNB Chain Set and Earn",
  campaignSource: "https://www.bnbchain.org/en/hackathons/smart-money-era-set-and-earn",
  campaignDeadlineUtc: "2026-11-05T12:00:00Z", rewardType: "PHYSICAL_MERCH_NOT_CASH",
  readiness: "EXTERNAL_REQUIREMENTS_PENDING", financialTransactionCreated: false,
  localFixturesCountAsCampaignEvidence: false,
  termix: { endpoint, probe, documentedChains: [56, 8453, 4663],
    bscTestnetSupport: "NOT_DOCUMENTED", adapter: "NOT_IMPLEMENTED",
    docs: ["https://docs.termix.ai/aacp/network", "https://docs.termix.ai/aacp/agents", "https://docs.termix.ai/aacp/a2a"],
    blocker: "Our client permits chain 97 only. TermiX documented BNB network is 56. Confirm a shortlisted testnet marketplace or review a separate mainnet release before listing." },
  pending: ["Register campaign wallet before qualifying actions", "Publish HTTPS card and live service", "Deploy and register ERC-8004 identity owned by campaign wallet",
    "New listing on a shortlisted marketplace", "Hire 3 different agents across at least 2 shortlisted markets", "3 completed hires from independent non-builder-funded users", "5 actual category-consistent onchain actions across at least 3 days", "Public source repository"]
};
await mkdir(".runtime", { recursive: true });
await writeFile(".runtime/bsc-readiness.json", json(report) + "\n");
console.log(json(report));
