import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
const script = await readFile(new URL("../site/agent-console.js", import.meta.url), "utf8");
const requiredHtml = [
  "Judge in 60 seconds",
  "Executable policy",
  "Three layers of evidence",
  "Why Binance",
  "Authority stays bounded",
  "accountable action layer",
  "Not a kill switch",
  "VERIFIED example",
  "BLOCKED example",
  "FROZEN example",
  "12512896470",
  "2026-09-02-ai-live-readonly-001.json",
  "agent-console.js"
];
const requiredScript = ["notionalWithinPolicy", "evidenceHash", "runGoal", "crypto.subtle"];
const missing = [
  ...requiredHtml.filter((value) => !html.includes(value)),
  ...requiredScript.filter((value) => !script.includes(value))
];

if (missing.length) throw new Error(`Judge site is missing: ${missing.join(", ")}`);
console.log(JSON.stringify({ valid: true, requiredSignals: requiredHtml.length + requiredScript.length }, null, 2));
