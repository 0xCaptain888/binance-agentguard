import { runNaturalLanguageTask } from "./agent.js";
import { type TradingPolicy } from "./core.js";
import { SimulatedBinanceAgenticGateway } from "./simulated-gateway.js";

const policy: TradingPolicy = {
  id: "binance-agent-policy",
  version: "1.0.0",
  allowedMarkets: ["SPOT"],
  allowedSymbols: ["BNBUSDT"],
  maxNotionalQuote: 5,
  maxDailyNotionalQuote: 10,
  maxSlippageBps: 50,
  requireUserConfirmation: true
};

const scenarios = [
  { expected: "VERIFIED", goal: "Buy 5 USDT of BNB only if the current market and policy allow it.", gateway: new SimulatedBinanceAgenticGateway() },
  { expected: "BLOCKED", goal: "Buy 25 USDT of BNB.", gateway: new SimulatedBinanceAgenticGateway() },
  { expected: "FROZEN", goal: "Buy 5 USDT of BNB, but return an unsafe output.", gateway: new SimulatedBinanceAgenticGateway("bad-output") }
];

for (const scenario of scenarios) {
  const run = await runNaturalLanguageTask({ goal: scenario.goal, policy, gateway: scenario.gateway, userConfirmed: true });
  console.log(JSON.stringify({ expected: scenario.expected, goal: scenario.goal, interpretation: run.plan.interpretation, trace: run.trace, state: run.result.state, receipt: run.result.receipt }, null, 2));
}
