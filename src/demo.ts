import { runAgentTask, type TradeIntent, type TradingPolicy } from "./core.js";
import { SimulatedBinanceAgenticGateway } from "./simulated-gateway.js";

const policy: TradingPolicy = {
  id: "binance-demo-policy",
  version: "1.0.0",
  allowedMarkets: ["SPOT"],
  allowedSymbols: ["BNBUSDT"],
  maxNotionalQuote: 5,
  maxDailyNotionalQuote: 10,
  maxSlippageBps: 50,
  requireUserConfirmation: true
};

const base: Omit<TradeIntent, "taskId" | "notionalQuote" | "maxSlippageBps"> = {
  actor: "binance-agentguard-demo",
  symbol: "BNBUSDT",
  side: "BUY",
  quoteAsset: "USDT",
  baseAsset: "BNB",
  purpose: "small bounded spot allocation"
};

const runs = [
  { label: "VERIFIED", gateway: new SimulatedBinanceAgenticGateway("verified"), intent: { ...base, taskId: "task-verified", notionalQuote: 5, maxSlippageBps: 50 } },
  { label: "BLOCKED", gateway: new SimulatedBinanceAgenticGateway("verified"), intent: { ...base, taskId: "task-blocked", notionalQuote: 25, maxSlippageBps: 50 } },
  { label: "FROZEN", gateway: new SimulatedBinanceAgenticGateway("bad-output"), intent: { ...base, taskId: "task-bad-output", notionalQuote: 5, maxSlippageBps: 50 } }
];

for (const run of runs) {
  const result = await runAgentTask({ intent: run.intent, policy, gateway: run.gateway, userConfirmed: true });
  console.log(JSON.stringify({ expected: run.label, state: result.state, receipt: result.receipt }, null, 2));
}
