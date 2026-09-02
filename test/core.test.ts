import test from "node:test";
import assert from "node:assert/strict";
import { runAgentTask, type TradeIntent, type TradingPolicy } from "../src/core.js";
import { SimulatedBinanceAgenticGateway } from "../src/simulated-gateway.js";

const policy: TradingPolicy = { id: "p", version: "1", allowedMarkets: ["SPOT"], allowedSymbols: ["BNBUSDT"], maxNotionalQuote: 5, maxDailyNotionalQuote: 10, maxSlippageBps: 50, requireUserConfirmation: true };
const intent = (taskId: string, notionalQuote: number): TradeIntent => ({ taskId, actor: "test", symbol: "BNBUSDT", side: "BUY", quoteAsset: "USDT", baseAsset: "BNB", notionalQuote, maxSlippageBps: 50, purpose: "test" });

test("verified execution releases a verifiable receipt", async () => {
  const result = await runAgentTask({ intent: intent("task-verified", 5), policy, gateway: new SimulatedBinanceAgenticGateway(), userConfirmed: true });
  assert.equal(result.state, "VERIFIED");
  assert.equal(result.receipt.verification.passed, true);
  assert.equal(result.receipt.receiptVersion, "1");
  assert.equal(result.receipt.evidenceHash.length, 64);
});

test("policy violation is blocked before the gateway is called", async () => {
  const result = await runAgentTask({ intent: intent("task-blocked", 25), policy, gateway: new SimulatedBinanceAgenticGateway(), userConfirmed: true });
  assert.equal(result.state, "BLOCKED");
  assert.deepEqual(result.receipt.verification.reasons, ["per_action_budget_exceeded", "daily_budget_exceeded"]);
  assert.equal(result.receipt.order, undefined);
});

test("post-execution mismatch freezes the task", async () => {
  const result = await runAgentTask({ intent: intent("task-bad-output", 5), policy, gateway: new SimulatedBinanceAgenticGateway("bad-output"), userConfirmed: true });
  assert.equal(result.state, "FROZEN");
  assert.equal(result.receipt.verification.passed, false);
  assert.ok(result.receipt.verification.reasons.includes("notionalWithinPolicy"));
});

test("writes require explicit user confirmation", async () => {
  const result = await runAgentTask({ intent: intent("task-no-confirm", 5), policy, gateway: new SimulatedBinanceAgenticGateway(), userConfirmed: false });
  assert.equal(result.state, "BLOCKED");
  assert.ok(result.receipt.verification.reasons.includes("user_confirmation_required"));
});
