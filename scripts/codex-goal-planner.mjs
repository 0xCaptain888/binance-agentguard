#!/usr/bin/env node

import { spawn } from "node:child_process";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const timeoutMs = Number(process.env.BINANCE_AI_PLANNER_TIMEOUT_MS ?? 90000);

const prompt = [
  "You are the planning brain of Binance AgentGuard.",
  "Convert the user's trading goal into one bounded SPOT TradeIntent.",
  "Do not call tools. Do not execute or authorize a trade.",
  "The external policy engine, not you, makes the final authorization decision.",
  `Goal: ${JSON.stringify(request.goal)}`,
  `Task ID: ${JSON.stringify(request.taskId)}`,
  `Policy: ${JSON.stringify(request.policy)}`,
  "Return only valid JSON with this exact shape:",
  '{"goal":"...","interpretation":"...","intent":{"taskId":"...","actor":"binance-agentguard-ai-planner","symbol":"BNBUSDT","side":"BUY","quoteAsset":"USDT","baseAsset":"BNB","notionalQuote":5,"maxSlippageBps":50,"purpose":"..."},"constraints":["..."],"reasoningSummary":"brief safety-focused summary","confidence":0.0}',
  "Preserve the requested amount even when it violates policy so the policy engine can BLOCK it.",
  "Supported quote asset is USDT. Infer BNBUSDT, BTCUSDT, ETHUSDT or SOLUSDT from the goal."
].join("\n");

const child = spawn("codex", ["exec", "--ephemeral", "--json", "--skip-git-repo-check", "-s", "read-only", "-"], { stdio: ["pipe", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
child.stdin.end(prompt);

const code = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("close", resolve);
});
clearTimeout(timer);
if (code !== 0) throw new Error(`AI planner failed: ${stderr.trim().slice(-1000)}`);

const messages = stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
}).filter((event) => event.type === "item.completed" && event.item?.type === "agent_message");
let text = messages.at(-1)?.item?.text?.trim();
if (!text) throw new Error("AI planner returned no agent message");
if (text.startsWith("```")) text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
const plan = JSON.parse(text);

if (plan?.intent?.taskId !== request.taskId) throw new Error("AI planner changed the task identity");
if (!["BUY", "SELL"].includes(plan?.intent?.side)) throw new Error("AI planner returned an invalid side");
if (!Number.isFinite(plan?.intent?.notionalQuote) || plan.intent.notionalQuote <= 0) throw new Error("AI planner returned an invalid notional");
if (typeof plan?.intent?.symbol !== "string" || !plan.intent.symbol.endsWith("USDT")) throw new Error("AI planner returned an invalid symbol");
if (!Number.isFinite(plan?.intent?.maxSlippageBps) || plan.intent.maxSlippageBps < 0) throw new Error("AI planner returned invalid slippage");
plan.intent.actor = "binance-agentguard-ai-planner";
plan.intent.quoteAsset = "USDT";
plan.intent.baseAsset = plan.intent.symbol.slice(0, -4);
plan.intent.purpose = request.goal;
process.stdout.write(`${JSON.stringify(plan)}\n`);
