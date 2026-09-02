import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { type BinanceAgenticGateway, type Order, type Quote, type TradingPolicy } from "./core.js";
import { runNaturalLanguageTask, type AgentPlan, type GoalPlanner } from "./agent.js";

/**
 * Small bridge protocol for running the same guard against Binance MCP.
 * The bridge is intentionally injected: this process never receives or stores
 * Binance credentials. It sends one JSON request per line and expects one JSON
 * response per line on stdout.
 */
type Bridge = { call<T>(toolName: string, args: Record<string, unknown>): Promise<T>; close(): void };

function plannerFromCommand(command: string, policy: TradingPolicy): GoalPlanner {
  return (goal, taskId) => new Promise<AgentPlan>((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "inherit"] });
    let output = "";
    let settled = false;
    const timeoutMs = Number(process.env.BINANCE_AGENT_PLANNER_COMMAND_TIMEOUT_MS ?? 120000);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Agent planner timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Agent planner exited with ${code}`));
      const line = output.trim().split(/\r?\n/).at(-1);
      if (!line) return reject(new Error("Agent planner returned no output"));
      try { resolve(JSON.parse(line) as AgentPlan); }
      catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
    });
    child.stdin.end(JSON.stringify({ goal, taskId, policy }));
  });
}

function bridgeFromCommand(command: string): Bridge {
  const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout });
  const pending: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  lines.on("line", (line) => {
    const request = pending.shift();
    if (!request) return;
    try {
      const response = JSON.parse(line) as { result?: unknown; error?: { message?: string } };
      if (response.error) request.reject(new Error(response.error.message ?? "MCP bridge error"));
      else request.resolve(response.result);
    } catch (error) {
      request.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  return {
    call<T>(toolName: string, args: Record<string, unknown>) {
      return new Promise<T>((resolve, reject) => {
        pending.push({ resolve: (value) => resolve(value as T), reject });
        child.stdin.write(`${JSON.stringify({ id: randomUUID(), toolName, arguments: args })}\n`);
      });
    },
    close() { child.kill(); lines.close(); }
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error("MCP response was not an object");
}

function unwrap(value: unknown): unknown {
  const object = asObject(value);
  if ("structuredContent" in object) return object.structuredContent;
  if (Array.isArray(object.content) && object.content[0] && typeof object.content[0] === "object" && "text" in object.content[0]) {
    const text = (object.content[0] as { text: string }).text;
    try { return JSON.parse(text); } catch { return text; }
  }
  return value;
}

function quoteFromBinance(value: unknown): Quote {
  const unwrapped = unwrap(value);
  const item = Array.isArray(unwrapped) ? asObject(unwrapped[0]) : asObject(unwrapped);
  const ask = Number(item.askPrice ?? item.ask ?? item.lastPrice ?? item.price);
  const bid = Number(item.bidPrice ?? item.bid ?? item.lastPrice ?? item.price);
  if (!Number.isFinite(ask) || !Number.isFinite(bid)) throw new Error("Binance quote did not contain numeric bid/ask");
  return { symbol: String(item.symbol ?? "BNBUSDT"), bid, ask, observedAt: new Date().toISOString(), source: "binance-mcp" };
}

function orderFromBinance(value: unknown): Order {
  const item = asObject(unwrap(value));
  const executedQty = Number(item.executedQty ?? item.origQty ?? 0);
  const quoteQty = Number(item.cummulativeQuoteQty ?? item.quoteQty ?? item.origQuoteOrderQty ?? 0);
  const avgPrice = Number(item.avgPrice ?? (executedQty ? quoteQty / executedQty : 0));
  return {
    orderId: String(item.orderId), symbol: String(item.symbol), side: item.side as Order["side"],
    status: item.status as Order["status"], executedQty, quoteQty, avgPrice,
    clientOrderId: String(item.clientOrderId ?? item.origClientOrderId ?? ""),
    executedAt: new Date(Number(item.transactTime ?? item.updateTime ?? Date.now())).toISOString()
  };
}

function gateway(bridge: Bridge, tools: { quote: string; place: string; order: string }): BinanceAgenticGateway {
  return {
    name: "binance-agentic-mcp",
    async getQuote(symbol) { return quoteFromBinance(await bridge.call(tools.quote, { symbol })); },
    async placeSpotOrder({ intent }) {
      const response = await bridge.call(tools.place, { symbol: intent.symbol, side: intent.side, type: "MARKET", quoteOrderQty: intent.notionalQuote, newClientOrderId: intent.taskId, newOrderRespType: "FULL" });
      return orderFromBinance(response);
    },
    async getOrder(symbol, orderId) { return orderFromBinance(await bridge.call(tools.order, { symbol, orderId: Number(orderId) })); }
  };
}

const args = new Set(process.argv.slice(2));
const readOnly = args.has("--read-only") || !args.has("--write");
const confirmed = args.has("--confirm") && process.env.BINANCE_LIVE_WRITE_CONFIRM === "I_UNDERSTAND_REAL_BINANCE_WRITE";
// Use the repository-provided Codex bridge by default.  Deployments can still
// inject a different bridge through BINANCE_MCP_BRIDGE; credentials never enter
// this process or the repository.
const bridgeCommand = process.env.BINANCE_MCP_BRIDGE ?? "node scripts/binance-codex-bridge.mjs";

const bridge = bridgeFromCommand(bridgeCommand);
const tools = { quote: process.env.BINANCE_MCP_QUOTE_TOOL ?? "spot.ticker24hr", place: process.env.BINANCE_MCP_ORDER_TOOL ?? "spot.newOrder", order: process.env.BINANCE_MCP_VERIFY_TOOL ?? "spot.allOrders" };
const policy: TradingPolicy = { id: "binance-live-policy", version: "1.0.0", allowedMarkets: ["SPOT"], allowedSymbols: ["BNBUSDT"], maxNotionalQuote: 5, maxDailyNotionalQuote: 5, maxSlippageBps: 50, requireUserConfirmation: true };
const goal = process.env.BINANCE_AGENT_GOAL ?? "Buy 5 USDT of BNB only if the current market and policy allow it.";
const taskId = `agentguard-live-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
const planner = process.env.BINANCE_AGENT_PLANNER === "codex"
  ? plannerFromCommand(process.env.BINANCE_AGENT_PLANNER_CMD ?? "node scripts/codex-goal-planner.mjs", policy)
  : undefined;

try {
  if (!readOnly && !confirmed) throw new Error("Write mode requires --confirm and BINANCE_LIVE_WRITE_CONFIRM=I_UNDERSTAND_REAL_BINANCE_WRITE");
  const account = await bridge.call("spot.getAccount", { omitZeroBalances: true });
  const agent = await runNaturalLanguageTask({
    goal,
    taskId,
    policy,
    gateway: gateway(bridge, tools),
    // Read-only mode deliberately omits confirmation, so the guard returns a
    // BLOCKED receipt after planning and quote observation without an order.
    userConfirmed: !readOnly,
    planner
  });
  console.log(JSON.stringify({ mode: readOnly ? "read-only" : "write", account: unwrap(account), plan: agent.plan, trace: agent.trace, state: agent.result.state, receipt: agent.result.receipt }, null, 2));
  if (readOnly) process.exit(0);
} finally {
  bridge.close();
}
