import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sha256 } from "./core.js";

const file = fileURLToPath(new URL("../evidence/public/2026-09-02-ai-live-readonly-001.json", import.meta.url));
const evidence = JSON.parse(await readFile(file, "utf8"));
const { evidenceHash, ...receiptInputs } = evidence.receipt;

const checks = {
  evidenceType: evidence.evidenceType === "LIVE_READ_ONLY_AGENT",
  liveMarketSource: evidence.marketObservation?.source === "binance-mcp",
  blockedWithoutOrder: evidence.receipt?.state === "BLOCKED" && evidence.receipt?.order === undefined,
  confirmationRequired: evidence.receipt?.verification?.reasons?.includes("user_confirmation_required"),
  intentBound: sha256(evidence.plan?.intent) === evidence.receipt?.intentHash,
  policyBound: sha256(evidence.policy) === evidence.receipt?.policyHash,
  receiptBound: sha256(receiptInputs) === evidenceHash
};

if (Object.values(checks).some((passed) => !passed)) {
  throw new Error(`AI live evidence verification failed: ${JSON.stringify(checks)}`);
}

console.log(JSON.stringify({
  valid: true,
  file,
  evidenceType: evidence.evidenceType,
  state: evidence.receipt.state,
  market: `${evidence.marketObservation.symbol}@${evidence.marketObservation.ask}`,
  reason: evidence.receipt.verification.reasons[0],
  orderSubmitted: false,
  evidenceHash
}, null, 2));
