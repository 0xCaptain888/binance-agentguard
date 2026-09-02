# Binance Agent OS integration

## What is implemented now

The repository has a complete, deterministic vertical slice for Track A:

1. an Agent produces a structured `TradeIntent`;
2. AgentGuard evaluates the policy before any gateway call;
3. the gateway returns a quote and execution result;
4. an independent verifier checks identity, fill status, notional and slippage;
5. the task ends as `VERIFIED`, `BLOCKED` or `FROZEN`;
6. a receipt binds the intent hash, policy hash and evidence hash.

`src/binance-agentic.ts` is the live protocol boundary. It requires an authenticated transport from the user's Binance Agent OS/Agentic session and does not accept secrets from files in this repository.

## Official connection reference

- [Binance Agent Native overview](https://developers.binance.com/en/docs/agent-native/overview)
- [Binance MCP Server / Agentic](https://developers.binance.com/en/docs/agent-native/mcp-server/agentic)

The public documentation says the Agentic account is isolated, has no withdrawal scope, and requires confirmation before non-read actions. AgentGuard adds an independent policy and post-execution verification layer on top of those controls.

## Live-run acceptance criteria

Before calling a run “real”, record all of the following in `evidence/live/` (never commit credentials):

- the exact Binance Agentic account identifier (redacted if required);
- the market-data response timestamp and source;
- the user-confirmed intent and policy hash;
- Binance order ID and order status fetched after execution;
- actual quote notional and average fill price;
- the final AgentGuard receipt and evidence hash.

If the event does not require a live write, use the deterministic simulator in the video and label it clearly. If a live write is required, use only an isolated Agentic sub-account and the minimum amount you are willing to risk.
