# One-command live runner

`live:run` runs the AgentGuard policy path against an authenticated Binance MCP
bridge. The repository never reads an API key or secret. The bridge is a small
process that translates newline-delimited requests into calls in the approved
Binance MCP session and returns one JSON response per line:

```json
{"id":"...","toolName":"spot.ticker24hr","arguments":{"symbol":"BNBUSDT"}}
```

The bridge must return either `{"result": ...}` or
`{"error":{"message":"..."}}`. Tool names default to the Binance MCP
catalog names `spot.getAccount`, `spot.ticker24hr`, `spot.newOrder`, and
`spot.allOrders`; override them with `BINANCE_MCP_*_TOOL` when your MCP catalog
uses different names.

## Read-only (default)

```bash
BINANCE_MCP_BRIDGE='path/to/your-mcp-bridge' npm run live:run -- --read-only
```

This reads the Spot account and BNBUSDT quote, then prints the intent and
policy. No order tool is called.

## Write mode (explicit opt-in)

Write mode is deliberately hard to trigger. It requires both flags below:

```bash
BINANCE_MCP_BRIDGE='path/to/your-mcp-bridge' \
BINANCE_LIVE_WRITE_CONFIRM=I_UNDERSTAND_REAL_BINANCE_WRITE \
npm run live:run -- --write --confirm
```

It submits one bounded `BNBUSDT` market BUY with a `5 USDT` quote amount,
queries the order independently, and prints the resulting AgentGuard receipt.
Do not use this command unless you have explicitly accepted a real Binance
trade and verified the account and balance in Binance first.

The deterministic judge path remains the safer reproducible demo:

```bash
npm run demo
npm run verify:live-evidence
```
