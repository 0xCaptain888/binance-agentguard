import { readFile } from "node:fs/promises";

type Data = Record<string, any>;
const object = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
const base = { chainId: 97, environment: "BSC_TESTNET", campaignProof: false, deploymentReady: false,
  financialTransactionCreated: false, scanCommand: "npm run bsc:dependencies" } as const;
export const uncheckedDependencies = () => ({ ...base, state: "NOT_CHECKED" as const });
const unavailable = () => ({ ...base, state: "UNAVAILABLE" as const });

// Project only known counts and timestamps. Never expose raw files, metadata,
// arbitrary error messages, RPC URLs or source credentials through the web API.
export function dependencySummary(value: unknown, now = Date.now()) {
  if (!object(value) || value.schemaVersion !== 2 || typeof value.checkedAt !== "string") return unavailable();
  const checked = Date.parse(value.checkedAt);
  if (!Number.isFinite(checked)) return unavailable();
  const checkedAt = new Date(checked).toISOString();
  if (value.state === "RPC_UNAVAILABLE") return { ...unavailable(), checkedAt };
  if (!["CANDIDATES_INSPECTED", "DEPENDENCY_READS_INCOMPLETE", "RPC_VERIFICATION_FAILED"].includes(value.state) ||
    value.chainId !== 97 || value.environment !== "BSC_TESTNET" ||
    value.campaignProof !== false || value.financialTransactionCreated !== false || value.deploymentReady !== false ||
    typeof value.blockNumber !== "string" || !/^\d{1,24}$/.test(value.blockNumber)) return unavailable();
  const p = value.primary, policy = value.policy;
  if (!object(p) || !object(p.router) || !object(policy) ||
    ![p.rounds, p.assets, p.routes].every(a => Array.isArray(a) && a.length <= 100 && a.every(object)) ||
    typeof p.timestamp !== "string" || !/^\d{1,15}$/.test(p.timestamp) ||
    typeof policy.maxActionUsd !== "string" || !/^[1-9]\d{0,36}$/.test(policy.maxActionUsd) ||
    typeof policy.maxOracleAgeSeconds !== "string" || !/^[1-9]\d{0,9}$/.test(policy.maxOracleAgeSeconds) ||
    !Number.isInteger(policy.maxSlippageBps) || policy.maxSlippageBps < 0 || policy.maxSlippageBps > 500) return unavailable();
  const rounds: Data[] = p.rounds, assets: Data[] = p.assets, routes: Data[] = p.routes;
  if (routes.some(r => r.quotes !== undefined && (!Array.isArray(r.quotes) || r.quotes.length !== 2 || !r.quotes.every(object)))) return unavailable();
  const quotes: Data[] = routes.flatMap(r => r.quotes ?? []);
  const rpcErrors = [...rounds, ...assets, ...routes, ...quotes].filter(r => r.status === "UNAVAILABLE").length;
  const agrees = value.matchingReads === true && value.canonical === true;
  const complete = p.complete === true && rpcErrors === 0 && value.state !== "DEPENDENCY_READS_INCOMPLETE";
  const ageSeconds = Math.floor((now - checked) / 1000);
  const blockAge = Math.floor(now / 1000) - Number(p.timestamp);
  const snapshotFresh = ageSeconds >= -30 && ageSeconds <= 120 && blockAge >= -30 && blockAge <= 120 && value.recent === true;
  const compatibleCandidates = routes.filter(r => r.compatibleCandidate === true).length;
  const routerMatches = p.router.matchesPublishedAddresses === true;
  const state = !agrees || value.state === "RPC_VERIFICATION_FAILED" ? "RPC_VERIFICATION_FAILED" :
    !complete ? "INCOMPLETE" : !snapshotFresh ? "STALE_SNAPSHOT" :
      routerMatches && compatibleCandidates > 0 ? "REVIEW_REQUIRED" : "BLOCKED";
  return { ...base, state, checkedAt, blockNumber: value.blockNumber, ageSeconds, snapshotFresh,
    serverTime: new Date(now).toISOString(), expiresAt: new Date(Math.min(checked + 120000, (Number(p.timestamp) + 120) * 1000)).toISOString(),
    independentReadsAgree: agrees, complete, routerMatches,
    policy: { maxActionUsd: policy.maxActionUsd, maxSlippageBps: policy.maxSlippageBps, maxOracleAgeSeconds: policy.maxOracleAgeSeconds },
    counts: { tokens: assets.length, pairs: routes.length, quoteDirections: quotes.length, compatibleCandidates },
    blockers: {
      staleOrInvalidFeeds: rounds.filter(r => r.status === "READ" && r.fresh !== true).length,
      missingContracts: [...rounds, ...assets].filter(r => r.status === "NO_CODE").length + routes.filter(r => r.status === "PAIR_NO_CODE").length,
      invalidTokenMetadata: assets.filter(r => r.status === "READ" && r.metadataValid !== true).length,
      missingPairs: routes.filter(r => r.status === "NO_PAIR").length,
      failedQuoteDirections: quotes.filter(q => q.status === "QUOTE_REVERTED" || (q.status === "READ" && q.aboveFloor !== true)).length,
      skippedPairs: routes.filter(r => r.status === "PREREQUISITES_UNAVAILABLE").length,
      rpcErrors
    } };
}
export async function readDependencySummary(path = ".runtime/bsc-dependencies.json") {
  try { return dependencySummary(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? uncheckedDependencies() : unavailable(); }
}
