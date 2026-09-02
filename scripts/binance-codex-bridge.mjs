#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const WRITE_TOOLS = new Set(["spot.newOrder"]);
const timeoutMs = Number(process.env.BINANCE_BRIDGE_TIMEOUT_MS ?? 90000);
const allowWrite = process.env.BINANCE_BRIDGE_ALLOW_WRITE === "1";

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function runCodex(request) {
  return new Promise((resolve, reject) => {
    const write = WRITE_TOOLS.has(request.toolName);
    if (write && !allowWrite) {
      reject(new Error("write tool rejected: set BINANCE_BRIDGE_ALLOW_WRITE=1 only after explicit user confirmation"));
      return;
    }

    // MCP calls need an approval-capable sandbox.  The process is ephemeral and
    // runs from the repository, but the bridge never passes credentials to it.
    // The request-level allow-list below remains the authority for write tools.
    const args = ["--approve-for-me", "exec", "--ephemeral", "--json", "--skip-git-repo-check", "-s", "workspace-write", "-"];
    const child = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let errorOutput = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`codex bridge timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { errorOutput += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`codex exited with ${code}: ${errorOutput.trim().slice(-1000)}`));
        return;
      }
      const events = output.split(/\r?\n/).filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });

      // The MCP server result is present in an item.completed/mcp_tool_call
      // event.  Do not depend on a model-generated final message (which may be
      // absent when the tool is called exactly once).
      const calls = events.filter((event) => event.type === "item.completed" && event.item?.type === "mcp_tool_call");
      const call = calls.at(-1)?.item;
      if (call?.error) {
        reject(new Error(`Binance MCP tool failed: ${JSON.stringify(call.error)}`));
        return;
      }
      if (call?.result !== undefined) {
        resolve(call.result);
        return;
      }

      // Fallback for CLI versions that emit only an agent message.
      const last = events.filter((event) => event.type === "item.completed" && event.item?.type === "agent_message").at(-1)?.item?.text;
      if (!last) {
        reject(new Error(`codex returned no MCP result: ${output.slice(-1500)}`));
        return;
      }
      try { resolve(JSON.parse(last)); }
      catch { reject(new Error(`codex agent message was not JSON: ${last.slice(0, 1000)}`)); }
    });
    const prompt = [
      "Use the Binance MCP Server.",
      "Call the visible MCP tool `tool_execute` exactly once.",
      `Pass this exact JSON object to tool_execute: ${JSON.stringify({ toolName: request.toolName, arguments: request.arguments ?? {} })}`,
      "Do not call tool_search or any other tool.",
      "After the tool call, output only the raw JSON result, with no markdown or explanation."
    ].join("\n");
    child.stdin.end(prompt);
  });
}

const input = createInterface({ input: process.stdin });
input.on("line", async (line) => {
  if (!line.trim()) return;
  let request;
  try { request = JSON.parse(line); }
  catch (error) { emit({ error: { message: `invalid bridge request: ${error.message}` } }); return; }
  try { emit({ id: request.id, result: await runCodex(request) }); }
  catch (error) { emit({ id: request.id, error: { message: error instanceof Error ? error.message : String(error) } }); }
});
