import { createHash } from "node:crypto";

export type GuardState = "VERIFIED" | "BLOCKED" | "FROZEN";
export type Side = "BUY" | "SELL";

export type Quote = {
  symbol: string;
  bid: number;
  ask: number;
  observedAt: string;
  source: string;
};

export type TradeIntent = {
  taskId: string;
  actor: string;
  symbol: string;
  side: Side;
  quoteAsset: string;
  baseAsset: string;
  notionalQuote: number;
  maxSlippageBps: number;
  purpose: string;
};

export type TradingPolicy = {
  id: string;
  version: string;
  allowedMarkets: readonly ["SPOT"];
  allowedSymbols: readonly string[];
  maxNotionalQuote: number;
  maxDailyNotionalQuote: number;
  maxSlippageBps: number;
  requireUserConfirmation: boolean;
};

export type Order = {
  orderId: string;
  symbol: string;
  side: Side;
  status: "FILLED" | "PARTIALLY_FILLED" | "REJECTED";
  executedQty: number;
  quoteQty: number;
  avgPrice: number;
  clientOrderId: string;
  executedAt: string;
};

export interface BinanceAgenticGateway {
  readonly name: string;
  getQuote(symbol: string): Promise<Quote>;
  placeSpotOrder(input: { intent: TradeIntent; quote: Quote }): Promise<Order>;
  getOrder(symbol: string, orderId: string): Promise<Order>;
}

export type Verification = {
  passed: boolean;
  reasons: string[];
  checks: Record<string, boolean>;
};

export type Receipt = {
  receiptVersion: "1";
  taskId: string;
  state: GuardState;
  gateway: string;
  intentHash: string;
  policyHash: string;
  quote?: Quote;
  order?: Order;
  verification: Verification;
  evidenceHash: string;
  createdAt: string;
};

export type RunResult = {
  state: GuardState;
  receipt: Receipt;
};

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

export function evaluatePolicy(intent: TradeIntent, policy: TradingPolicy, dailySpend = 0): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!policy.allowedSymbols.includes(intent.symbol)) reasons.push("symbol_not_allowed");
  if (intent.notionalQuote > policy.maxNotionalQuote) reasons.push("per_action_budget_exceeded");
  if (dailySpend + intent.notionalQuote > policy.maxDailyNotionalQuote) reasons.push("daily_budget_exceeded");
  if (intent.maxSlippageBps > policy.maxSlippageBps) reasons.push("slippage_tolerance_exceeded");
  return { passed: reasons.length === 0, reasons };
}

export function verifyOrder(intent: TradeIntent, policy: TradingPolicy, quote: Quote, order: Order): Verification {
  const checks = {
    orderFilled: order.status === "FILLED",
    identityBound: order.symbol === intent.symbol && order.side === intent.side && order.clientOrderId === intent.taskId,
    notionalWithinPolicy: order.quoteQty <= policy.maxNotionalQuote,
    slippageWithinPolicy: quote.ask > 0 && Math.abs(order.avgPrice - quote.ask) / quote.ask * 10_000 <= policy.maxSlippageBps,
  };
  const reasons = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return { passed: reasons.length === 0, reasons, checks };
}

export async function runAgentTask(input: {
  intent: TradeIntent;
  policy: TradingPolicy;
  gateway: BinanceAgenticGateway;
  dailySpend?: number;
  userConfirmed?: boolean;
  now?: () => string;
}): Promise<RunResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const policyHash = sha256(input.policy);
  const intentHash = sha256(input.intent);
  const policyDecision = evaluatePolicy(input.intent, input.policy, input.dailySpend ?? 0);
  if (!policyDecision.passed || (input.policy.requireUserConfirmation && !input.userConfirmed)) {
    const reasons = [...policyDecision.reasons];
    if (input.policy.requireUserConfirmation && !input.userConfirmed) reasons.push("user_confirmation_required");
    const verification: Verification = { passed: false, reasons, checks: {} };
    const partial = { receiptVersion: "1" as const, taskId: input.intent.taskId, state: "BLOCKED" as const, gateway: input.gateway.name, intentHash, policyHash, verification, createdAt: now() };
    return { state: "BLOCKED", receipt: { ...partial, evidenceHash: sha256(partial) } };
  }

  const quote = await input.gateway.getQuote(input.intent.symbol);
  const order = await input.gateway.placeSpotOrder({ intent: input.intent, quote });
  const canonicalOrder = await input.gateway.getOrder(input.intent.symbol, order.orderId);
  const verification = verifyOrder(input.intent, input.policy, quote, canonicalOrder);
  const state: GuardState = verification.passed ? "VERIFIED" : "FROZEN";
  const partial = { receiptVersion: "1" as const, taskId: input.intent.taskId, state, gateway: input.gateway.name, intentHash, policyHash, quote, order: canonicalOrder, verification, createdAt: now() };
  return { state, receipt: { ...partial, evidenceHash: sha256(partial) } };
}
