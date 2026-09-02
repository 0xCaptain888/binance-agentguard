const defaults = { symbol: "BNBUSDT", maxAction: 5, maxDaily: 10, dailySpend: 0, maxSlippage: 50, confirmed: true };
const quote = { bid: 687.31, ask: 687.32, source: "binance-agentic-simulator" };
const simulatedSlippageBps = 12;
let latestReceipt;

function readPolicy() {
  const number = (id, fallback) => { const value = Number(document.querySelector(`#${id}`)?.value); return Number.isFinite(value) ? Math.max(0, value) : fallback; };
  return { symbol: document.querySelector("#policy-symbol").value, maxAction: number("policy-action", defaults.maxAction), maxDaily: number("policy-daily", defaults.maxDaily), dailySpend: number("policy-spend", defaults.dailySpend), maxSlippage: number("policy-slippage", defaults.maxSlippage), confirmed: document.querySelector("#policy-confirmed").checked };
}

function updatePolicySummary(policy) {
  document.querySelector("#policy-summary-symbol").textContent = policy.symbol;
  document.querySelector("#policy-summary-action").textContent = `≤ ${policy.maxAction} USDT`;
  document.querySelector("#policy-summary-daily").textContent = `≤ ${policy.maxDaily} USDT`;
  document.querySelector("#policy-summary-slippage").textContent = `${policy.maxSlippage} bps`;
}

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
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function addStep(container, step, detail) {
  const row = document.createElement("div"); row.className = "timeline-row";
  const label = document.createElement("small"); label.textContent = step;
  const text = document.createElement("span"); text.textContent = detail;
  row.append(label, text); container.append(row);
}

function renderMatrix(parsed, policy, state, order, checks) {
  const rows = [
    ["Symbol allowed", policy.symbol, parsed.symbol, parsed.symbol === policy.symbol],
    ["Per-action budget", `≤ ${policy.maxAction} USDT`, `${parsed.amount} USDT`, parsed.amount <= policy.maxAction],
    ["Daily budget", `≤ ${policy.maxDaily} USDT`, `${policy.dailySpend + parsed.amount} USDT total`, policy.dailySpend + parsed.amount <= policy.maxDaily],
    ["User confirmation", "Required", policy.confirmed ? "Granted" : "Missing", policy.confirmed],
    ["Order filled", "FILLED", order?.status ?? "Not submitted", state === "BLOCKED" ? null : checks.orderFilled],
    ["Identity bound", "Intent ↔ order", order ? (checks.identityBound ? "Bound" : "Mismatch") : "Not applicable", state === "BLOCKED" ? null : checks.identityBound],
    ["Notional within policy", `≤ ${policy.maxAction} USDT`, order ? `${order.quoteQty} USDT` : "Not applicable", state === "BLOCKED" ? null : checks.notionalWithinPolicy],
    ["Slippage within policy", `≤ ${policy.maxSlippage} bps`, order ? `${simulatedSlippageBps} bps` : "Not applicable", state === "BLOCKED" ? null : checks.slippageWithinPolicy]
  ];
  const body = document.querySelector("#verification-matrix"); body.replaceChildren();
  for (const [name, expected, observed, passed] of rows) {
    const row = document.createElement("tr");
    for (const value of [name, expected, observed]) { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); }
    const result = document.createElement("td"); const badge = document.createElement("span"); badge.className = `result ${passed === null ? "na" : passed ? "pass" : "fail"}`; badge.textContent = passed === null ? "N/A" : passed ? "PASS" : "FAIL"; result.append(badge); row.append(result); body.append(row);
  }
}

async function runGoal(goal) {
  const policy = readPolicy(); updatePolicySummary(policy);
  const parsed = parseGoal(goal); const goalHash = await hash(goal.trim());
  const intent = { taskId: `judge-${goalHash.slice(0, 12)}`, actor: "binance-agentguard-planner", symbol: parsed.symbol, side: parsed.side, quoteAsset: "USDT", baseAsset: parsed.baseAsset, notionalQuote: parsed.amount, maxSlippageBps: policy.maxSlippage, purpose: goal.trim() };
  const observedQuote = { symbol: parsed.symbol, ...quote, observedAt: "2026-09-02T00:00:00.000Z" };
  const trace = document.querySelector("#agent-timeline"); const status = document.querySelector("#agent-status"); const receiptEl = document.querySelector("#agent-receipt"); trace.replaceChildren();
  addStep(trace, "GOAL", "Received natural-language user goal"); addStep(trace, "QUOTE", `Observed ${observedQuote.symbol} ask=${observedQuote.ask} from ${observedQuote.source}`); addStep(trace, "INTENT", `${parsed.side} ${parsed.amount} USDT of ${parsed.symbol}`);
  const policyReasons = []; if (parsed.symbol !== policy.symbol) policyReasons.push("symbol_not_allowed"); if (parsed.amount > policy.maxAction) policyReasons.push("per_action_budget_exceeded"); if (policy.dailySpend + parsed.amount > policy.maxDaily) policyReasons.push("daily_budget_exceeded"); if (!policy.confirmed) policyReasons.push("user_confirmation_required");
  addStep(trace, "POLICY", policyReasons.length ? `BLOCKED: ${policyReasons.join(", ")}` : "Policy passed; authority granted inside the sandbox");
  let state = "VERIFIED"; let order; let checks = {}; let verificationReasons = [...policyReasons];
  if (policyReasons.length) state = "BLOCKED";
  else if (/unsafe|bad output|异常|错误结果/i.test(goal)) { state = "FROZEN"; order = { orderId: "SIM-1", status: "FILLED", quoteQty: parsed.amount * 2, clientOrderId: intent.taskId }; checks = { orderFilled: true, identityBound: true, notionalWithinPolicy: false, slippageWithinPolicy: simulatedSlippageBps <= policy.maxSlippage }; verificationReasons = ["notionalWithinPolicy"]; if (!checks.slippageWithinPolicy) verificationReasons.push("slippageWithinPolicy"); }
  else { order = { orderId: "SIM-1", status: "FILLED", quoteQty: parsed.amount, clientOrderId: intent.taskId }; checks = { orderFilled: true, identityBound: true, notionalWithinPolicy: true, slippageWithinPolicy: simulatedSlippageBps <= policy.maxSlippage }; if (!checks.slippageWithinPolicy) { state = "FROZEN"; verificationReasons = ["slippageWithinPolicy"]; } }
  addStep(trace, "EXECUTION", order ? (state === "FROZEN" ? "Gateway returned unsafe output" : "Simulator returned FILLED") : "Skipped — no order was submitted"); addStep(trace, "VERIFY", state === "VERIFIED" ? "All independent checks passed" : state === "FROZEN" ? "Notional check failed; task isolated" : "Verification skipped before execution");
  const partial = { receiptVersion: "1", taskId: intent.taskId, state, gateway: "binance-agentic-simulator", intentHash: await hash(intent), policyHash: await hash(policy), quote: state === "BLOCKED" ? undefined : observedQuote, order, verification: { passed: state === "VERIFIED", reasons: verificationReasons, checks }, createdAt: "2026-09-02T00:00:00.000Z" }; partial.evidenceHash = await hash(partial); latestReceipt = partial;
  addStep(trace, "RECEIPT", `Sealed with evidence hash ${partial.evidenceHash.slice(0, 16)}…`); status.textContent = `${state} · deterministic judge simulation`; status.className = `run-status ${state.toLowerCase()}`; receiptEl.textContent = JSON.stringify(partial, null, 2); renderMatrix(parsed, policy, state, order, checks);
  const panel = document.querySelector("#agent-integrity"); panel.className = "integrity"; panel.innerHTML = "<strong>Receipt ready to verify</strong><span>Recompute this receipt hash in the browser to prove integrity.</span>";
}

async function verifyReceipt() {
  const panel = document.querySelector("#agent-integrity"); if (!latestReceipt) return; const { evidenceHash, ...withoutHash } = latestReceipt; const computed = await hash(withoutHash); const valid = computed === evidenceHash; panel.className = `integrity ${valid ? "success" : "error"}`; panel.innerHTML = `<strong>${valid ? "Evidence integrity: VERIFIED" : "Evidence integrity: FAILED"}</strong><span>${valid ? "Receipt hash matches the canonical payload." : "Receipt was changed after sealing."}</span><code>Computed: ${computed}</code><code>Recorded: ${evidenceHash}</code>`;
}

async function verifyLiveEvidence() {
  const panel = document.querySelector("#live-evidence-integrity"); panel.className = "integrity"; panel.innerHTML = "<strong>Verifying public Binance evidence…</strong><span>Fetching the read-only evidence bundle.</span>";
  try { const response = await fetch("https://raw.githubusercontent.com/0xCaptain888/binance-agentguard/main/evidence/public/2026-09-02-bnbusdt-buy-001.json", { cache: "no-store" }); if (!response.ok) throw new Error(`HTTP ${response.status}`); const evidence = await response.json(); const { evidenceHash, ...withoutHash } = evidence; const computed = await hash(withoutHash); const valid = computed === evidenceHash; panel.className = `integrity ${valid ? "success" : "error"}`; panel.innerHTML = `<strong>${valid ? "Evidence integrity: VERIFIED" : "Evidence integrity: FAILED"}</strong><span>${valid ? "Public Binance order bundle matches its recorded hash." : "The public bundle does not match its recorded hash."}</span><code>Computed: ${computed}</code><code>Recorded: ${evidenceHash}</code>`; } catch (error) { panel.className = "integrity error"; panel.innerHTML = `<strong>Evidence verification unavailable</strong><span>${error instanceof Error ? error.message : String(error)}</span>`; }
}

function setPolicy(values) { document.querySelector("#policy-symbol").value = values.symbol; document.querySelector("#policy-action").value = values.maxAction; document.querySelector("#policy-daily").value = values.maxDaily; document.querySelector("#policy-spend").value = values.dailySpend; document.querySelector("#policy-slippage").value = values.maxSlippage; document.querySelector("#policy-confirmed").checked = values.confirmed; updatePolicySummary(readPolicy()); }
document.querySelectorAll("[data-goal]").forEach((button) => button.addEventListener("click", () => { document.querySelector("#agent-goal").value = button.dataset.goal; runGoal(button.dataset.goal); }));
document.querySelector("#run-agent").addEventListener("click", () => runGoal(document.querySelector("#agent-goal").value)); document.querySelector("#verify-agent-receipt").addEventListener("click", verifyReceipt); document.querySelector("#verify-live-evidence").addEventListener("click", verifyLiveEvidence); document.querySelector("#reset-policy").addEventListener("click", () => setPolicy(defaults)); document.querySelectorAll("#policy-symbol, #policy-action, #policy-daily, #policy-spend, #policy-slippage, #policy-confirmed").forEach((control) => control.addEventListener("change", () => updatePolicySummary(readPolicy()))); setPolicy(defaults); runGoal(document.querySelector("#agent-goal").value);
