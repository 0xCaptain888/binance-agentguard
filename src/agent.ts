import {
  runAgentTask,
  type BinanceAgenticGateway,
  type Quote,
  type RunResult,
  type TradeIntent,
  type TradingPolicy
} from "./core.js";

export type AgentTraceStep = {
  step: "goal" | "quote" | "intent" | "policy" | "execution" | "verification" | "receipt";
  status: "completed" | "skipped";
  detail: string;
};

export type AgentPlan = {
  goal: string;
  interpretation: string;
  intent: TradeIntent;
  constraints: string[];
};

export type AgentRun = {
  plan: AgentPlan;
  trace: AgentTraceStep[];
  result: RunResult;
};

export type GoalPlanner = (goal: string, taskId: string) => AgentPlan | Promise<AgentPlan>;

function validatePlan(plan: AgentPlan, goal: string, taskId: string): AgentPlan {
  if (!plan || typeof plan !== "object" || !plan.intent) throw new Error("Agent planner returned no intent");
  if (plan.intent.taskId !== taskId) throw new Error("Agent planner changed the task identity");
  if (!(["BUY", "SELL"] as unknown[]).includes(plan.intent.side)) throw new Error("Agent planner returned an invalid side");
  if (typeof plan.intent.symbol !== "string" || !plan.intent.symbol.endsWith("USDT")) throw new Error("Agent planner returned an invalid symbol");
  if (plan.intent.quoteAsset !== "USDT") throw new Error("Agent planner returned an unsupported quote asset");
  if (plan.intent.baseAsset !== plan.intent.symbol.slice(0, -4)) throw new Error("Agent planner returned inconsistent assets");
  if (!Number.isFinite(plan.intent.notionalQuote) || plan.intent.notionalQuote <= 0) throw new Error("Agent planner returned an invalid notional");
  if (!Number.isFinite(plan.intent.maxSlippageBps) || plan.intent.maxSlippageBps < 0) throw new Error("Agent planner returned invalid slippage");
  return {
    ...plan,
    goal: goal.trim(),
    intent: {
      ...plan.intent,
      actor: "binance-agentguard-ai-planner",
      purpose: goal.trim()
    },
    constraints: Array.isArray(plan.constraints) ? plan.constraints.map(String) : []
  };
}

function amountFromGoal(goal: string): number {
  const match = goal.match(/(?:buy|sell|spend|use|for)\s*\$?\s*(\d+(?:\.\d+)?)\s*(?:usdt|usd)?/i)
    ?? goal.match(/(\d+(?:\.\d+)?)\s*(?:usdt|usd)/i);
  return match ? Number(match[1]) : 5;
}

function symbolFromGoal(goal: string): { symbol: string; baseAsset: string } {
  const normalized = goal.toUpperCase();
  if (normalized.includes("BTC")) return { symbol: "BTCUSDT", baseAsset: "BTC" };
  if (normalized.includes("ETH")) return { symbol: "ETHUSDT", baseAsset: "ETH" };
  if (normalized.includes("SOL")) return { symbol: "SOLUSDT", baseAsset: "SOL" };
  return { symbol: "BNBUSDT", baseAsset: "BNB" };
}

export function planTradeGoal(goal: string, taskId = `agent-goal-${Date.now()}`): AgentPlan {
  const cleaned = goal.trim();
  if (!cleaned) throw new Error("Agent goal cannot be empty");
  const { symbol, baseAsset } = symbolFromGoal(cleaned);
  const side = /\b(sell|出售|卖出)\b/i.test(cleaned) ? "SELL" : "BUY";
  const notionalQuote = amountFromGoal(cleaned);
  const intent: TradeIntent = {
    taskId,
    actor: "binance-agentguard-planner",
    symbol,
    side,
    quoteAsset: "USDT",
    baseAsset,
    notionalQuote,
    maxSlippageBps: 50,
    purpose: cleaned
  };
  return {
    goal: cleaned,
    interpretation: `${side} ${notionalQuote} USDT of ${symbol} after policy checks`,
    intent,
    constraints: [
      "SPOT market only",
      "symbol must be allowed by policy",
      "requested notional is checked against per-action and daily budgets",
      "post-execution fill, identity, notional and slippage must verify"
    ]
  };
}

class PreflightQuoteGateway implements BinanceAgenticGateway {
  readonly name: string;
  constructor(private readonly upstream: BinanceAgenticGateway, private readonly preflight: Quote) {
    this.name = upstream.name;
  }
  getQuote(symbol: string): Promise<Quote> {
    return symbol === this.preflight.symbol ? Promise.resolve(this.preflight) : this.upstream.getQuote(symbol);
  }
  placeSpotOrder(input: { intent: TradeIntent; quote: Quote }) { return this.upstream.placeSpotOrder(input); }
  getOrder(symbol: string, orderId: string) { return this.upstream.getOrder(symbol, orderId); }
}

/**
 * Turns a user goal into a structured intent, observes market data and runs the
 * intent through the same policy/verification core used by the live gateway.
 */
export async function runNaturalLanguageTask(input: {
  goal: string;
  policy: TradingPolicy;
  gateway: BinanceAgenticGateway;
  dailySpend?: number;
  userConfirmed?: boolean;
  now?: () => string;
  taskId?: string;
  planner?: GoalPlanner;
}): Promise<AgentRun> {
  const taskId = input.taskId ?? `agent-goal-${Date.now()}`;
  const rawPlan = input.planner ? await input.planner(input.goal, taskId) : planTradeGoal(input.goal, taskId);
  const plan = validatePlan(rawPlan, input.goal, taskId);
  const trace: AgentTraceStep[] = [
    { step: "goal", status: "completed", detail: "Received natural-language user goal" }
  ];
  const quote = await input.gateway.getQuote(plan.intent.symbol);
  trace.push({ step: "quote", status: "completed", detail: `Observed ${quote.symbol} ask=${quote.ask} from ${quote.source}` });
  trace.push({ step: "intent", status: "completed", detail: plan.interpretation });
  trace.push({ step: "policy", status: "completed", detail: "Policy gate evaluated before any order call" });
  const result = await runAgentTask({
    intent: plan.intent,
    policy: input.policy,
    gateway: new PreflightQuoteGateway(input.gateway, quote),
    dailySpend: input.dailySpend,
    userConfirmed: input.userConfirmed,
    now: input.now
  });
  trace.push({ step: "execution", status: result.receipt.order ? "completed" : "skipped", detail: result.receipt.order ? "Gateway returned an order" : "No order was submitted" });
  trace.push({ step: "verification", status: result.receipt.order ? "completed" : "skipped", detail: result.receipt.order ? `${result.state} independent verification` : "Verification not applicable before execution" });
  trace.push({ step: "receipt", status: "completed", detail: `Receipt sealed with evidence hash ${result.receipt.evidenceHash}` });
  return { plan, trace, result };
}
