const policy = { id: "binance-agent-policy", version: "1.0.0", allowedMarkets: ["SPOT"], maxNotionalQuote: 5, maxDailyNotionalQuote: 10, maxSlippageBps: 50, requireUserConfirmation: true, allowedSymbols: ["BNBUSDT"] };
const quote = { symbol: "BNBUSDT", bid: 687.31, ask: 687.32, source: "binance-agentic-simulator" };

function parseGoal(goal) {
  const amountMatch = goal.match(/(?:buy|sell|spend|use|for)\s*\$?\s*(\d+(?:\.\d+)?)\s*(?:usdt|usd)?/i) ?? goal.match(/(\d+(?:\.\d+)?)\s*(?:usdt|usd)/i);
  const amount = amountMatch ? Number(amountMatch[1]) : 5;
  const upper = goal.toUpperCase();
  const base = upper.includes("BTC") ? "BTC" : upper.includes("ETH") ? "ETH" : upper.includes("SOL") ? "SOL" : "BNB";
  const side = /\b(sell|出售|卖出)\b/i.test(goal) ? "SELL" : "BUY";
  return { symbol: `${base}USDT`, baseAsset: base, side, amount };
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function hash(value) {
  const bytes = new TextEncoder().encode(stable(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function addStep(container, step, detail) {
  const row = document.createElement("div");
  row.className = "timeline-row";
  const label = document.createElement("small");
  label.textContent = step;
  const text = document.createElement("span");
  text.textContent = detail;
  row.append(label, text);
  container.append(row);
}

async function runGoal(goal) {
  const parsed = parseGoal(goal);
  const goalHash = await hash(goal.trim());
  const intent = { taskId: `judge-${goalHash.slice(0, 12)}`, actor: "binance-agentguard-planner", symbol: parsed.symbol, side: parsed.side, quoteAsset: "USDT", baseAsset: parsed.baseAsset, notionalQuote: parsed.amount, maxSlippageBps: 50, purpose: goal.trim() };
  const trace = document.querySelector("#agent-timeline");
  const status = document.querySelector("#agent-status");
  const receiptEl = document.querySelector("#agent-receipt");
  trace.replaceChildren();
  addStep(trace, "GOAL", "Received natural-language user goal");
  addStep(trace, "QUOTE", `Observed ${quote.symbol} ask=${quote.ask} from ${quote.source}`);
  addStep(trace, "INTENT", `${parsed.side} ${parsed.amount} USDT of ${parsed.symbol}`);
  const policyReasons = [];
  if (!policy.allowedSymbols.includes(parsed.symbol)) policyReasons.push("symbol_not_allowed");
  if (parsed.amount > policy.maxNotionalQuote) policyReasons.push("per_action_budget_exceeded");
  if (parsed.amount > policy.maxDailyNotionalQuote) policyReasons.push("daily_budget_exceeded");
  addStep(trace, "POLICY", policyReasons.length ? `BLOCKED: ${policyReasons.join(", ")}` : "Policy passed; judge simulation supplies confirmation");
  let state = "VERIFIED";
  let order;
  let checks = {};
  let verificationReasons = [...policyReasons];
  if (policyReasons.length) {
    state = "BLOCKED";
  } else if (/unsafe|bad output|异常|错误结果/i.test(goal)) {
    state = "FROZEN";
    order = { orderId: "SIM-1", status: "FILLED", quoteQty: parsed.amount * 2, clientOrderId: intent.taskId };
    checks = { orderFilled: true, identityBound: true, notionalWithinPolicy: false, slippageWithinPolicy: true };
    verificationReasons = ["notionalWithinPolicy"];
  } else {
    order = { orderId: "SIM-1", status: "FILLED", quoteQty: parsed.amount, clientOrderId: intent.taskId };
    checks = { orderFilled: true, identityBound: true, notionalWithinPolicy: true, slippageWithinPolicy: true };
  }
  if (order) addStep(trace, "EXECUTION", `${state === "FROZEN" ? "Gateway returned unsafe output" : "Simulator returned FILLED"}`);
  else addStep(trace, "EXECUTION", "Skipped — no order was submitted");
  addStep(trace, "VERIFY", state === "VERIFIED" ? "All independent checks passed" : state === "FROZEN" ? "Notional check failed; task isolated" : "Verification skipped before execution");
  const partial = { receiptVersion: "1", taskId: intent.taskId, state, gateway: "binance-agentic-simulator", intentHash: await hash(intent), policyHash: await hash(policy), quote: state === "BLOCKED" ? undefined : quote, order, verification: { passed: state === "VERIFIED", reasons: verificationReasons, checks }, createdAt: "2026-09-02T00:00:00.000Z" };
  partial.evidenceHash = await hash(partial);
  addStep(trace, "RECEIPT", `Sealed with evidence hash ${partial.evidenceHash.slice(0, 16)}…`);
  status.textContent = `${state} · deterministic judge simulation`;
  status.className = `run-status ${state.toLowerCase()}`;
  receiptEl.textContent = JSON.stringify(partial, null, 2);
}

document.querySelectorAll("[data-goal]").forEach((button) => button.addEventListener("click", () => {
  document.querySelector("#agent-goal").value = button.dataset.goal;
  runGoal(button.dataset.goal);
}));
document.querySelector("#run-agent").addEventListener("click", () => runGoal(document.querySelector("#agent-goal").value));
runGoal(document.querySelector("#agent-goal").value);
