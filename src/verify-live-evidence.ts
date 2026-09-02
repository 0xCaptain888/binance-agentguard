import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256 } from "./core.js";

type PublicEvidence = {
  evidenceHash?: unknown;
  source?: unknown;
  network?: unknown;
  intent?: { taskId?: unknown; symbol?: unknown; side?: unknown; type?: unknown; quoteOrderQty?: unknown };
  order?: { orderId?: unknown; clientOrderId?: unknown; status?: unknown; executedQty?: unknown; cummulativeQuoteQty?: unknown };
  independentVerification?: { agentGuardState?: unknown; orderFilled?: unknown; identityBound?: unknown; notionalWithinPolicy?: unknown; slippageWithinPolicy?: unknown; independentQuery?: unknown };
};

function fail(message: string): never {
  console.error(`LIVE_EVIDENCE_INVALID: ${message}`);
  process.exit(1);
}

const file = resolve(process.argv[2] ?? "evidence/public/2026-09-02-bnbusdt-buy-001.json");
let parsed: PublicEvidence;
try {
  parsed = JSON.parse(await readFile(file, "utf8")) as PublicEvidence;
} catch (error) {
  fail(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
}

if (!parsed || typeof parsed !== "object") fail("document must be a JSON object");
if (parsed.source !== "Binance MCP Server") fail("source is not Binance MCP Server");
if (parsed.network !== "Binance Spot") fail("network is not Binance Spot");
if (parsed.intent?.symbol !== "BNBUSDT" || parsed.intent.side !== "BUY" || parsed.intent.type !== "MARKET") fail("intent does not describe the expected BNBUSDT market buy");
if (parsed.order?.status !== "FILLED") fail("order status is not FILLED");
if (!parsed.order?.orderId || parsed.order.clientOrderId !== parsed.intent.taskId) fail("order identity is not bound to the intent");

const checks = parsed.independentVerification;
if (!checks || checks.agentGuardState !== "VERIFIED" || checks.orderFilled !== true || checks.identityBound !== true || checks.notionalWithinPolicy !== true || checks.slippageWithinPolicy !== true || checks.independentQuery !== true) {
  fail("independent verification checks are incomplete or failed");
}

const { evidenceHash, ...withoutHash } = parsed;
if (typeof evidenceHash !== "string") fail("evidenceHash is missing");
const computedHash = sha256(withoutHash);
if (computedHash !== evidenceHash) fail(`evidenceHash mismatch (expected ${evidenceHash}, computed ${computedHash})`);

console.log(JSON.stringify({
  valid: true,
  file,
  state: checks.agentGuardState,
  orderId: parsed.order.orderId,
  taskId: parsed.intent.taskId,
  executedQty: parsed.order.executedQty,
  cummulativeQuoteQty: parsed.order.cummulativeQuoteQty,
  evidenceHash
}, null, 2));
