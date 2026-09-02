# One-command live runner

`live:run` runs the AgentGuard policy path against an authenticated Binance MCP
bridge. The repository never reads an API key or secret. This repository ships
`scripts/binance-codex-bridge.mjs`, which delegates each request to the local
`codex exec` process; Codex reuses the OAuth MCP session already configured on
the machine. This is a CLI bridge to the local Codex authentication context, not
an attempt to copy the Codex Desktop session or any OAuth token into the repo.
The bridge translates newline-delimited requests into calls and returns one JSON
response per line:

```json
{"id":"...","toolName":"spot.ticker24hr","arguments":{"symbol":"BNBUSDT"}}
```

The bridge must return either `{"result": ...}` or
`{"error":{"message":"..."}}`. Tool names default to the Binance MCP
catalog names `spot.getAccount`, `spot.ticker24hr`, `spot.newOrder`, and
`spot.allOrders`; override them with `BINANCE_MCP_*_TOOL` when your MCP catalog
uses different names.

## Prerequisites

1. Install and authenticate the Codex CLI on the machine that will run the
   command.
2. Add the Binance MCP server to that CLI and confirm it is enabled:

   ```bash
   codex mcp list
   ```

   The list should contain `binance-mcp-server` with status `enabled`. OAuth is
   handled by Codex; no Binance key, secret, passphrase, or token belongs in
   this repository or in shell history.

3. Run the command from the repository root. The first request can take up to
   90 seconds while Codex starts and the MCP server negotiates.

## Read-only (default)

```bash
npm run live:run -- --read-only
```

The runner automatically selects `node scripts/binance-codex-bridge.mjs` from
the repository. Set `BINANCE_MCP_BRIDGE` only when replacing it with another
authenticated bridge.

This reads the Spot account and BNBUSDT quote, then prints the Agent plan,
trace, intent and policy. Read-only mode intentionally omits confirmation, so
the final receipt is `BLOCKED` and no order tool is called. Override the goal
without changing the policy boundary:

```bash
BINANCE_AGENT_GOAL='Buy 25 USDT of BNB.' npm run live:run -- --read-only
```

Use an actual Codex model as the planning brain while retaining the same
deterministic authorization boundary:

```bash
npm run agent:live
```

The model can only produce a plan. Runtime validation binds the task identity
and asset fields, and the external policy engine makes the authorization
decision. The command remains read-only and ends `BLOCKED` because it does not
provide transaction confirmation.

For a direct bridge smoke test (also read-only):

```bash
printf '%s\n' '{"id":"smoke","toolName":"spot.ticker24hr","arguments":{"symbol":"BNBUSDT"}}' \
  | node scripts/binance-codex-bridge.mjs
```

The output is one JSON line with either `result` or `error`. CLI warnings on
stderr are intentionally kept separate from this protocol output.

## Write mode (explicit opt-in)

Write mode is deliberately hard to trigger. It requires both flags below:

```bash
BINANCE_LIVE_WRITE_CONFIRM=I_UNDERSTAND_REAL_BINANCE_WRITE \
BINANCE_BRIDGE_ALLOW_WRITE=1 \
npm run live:run -- --write --confirm
```

It submits one bounded `BNBUSDT` market BUY with a `5 USDT` quote amount,
queries the order independently, and prints the resulting AgentGuard receipt.
Do not use this command unless you have explicitly accepted a real Binance
trade and verified the account and balance in Binance first.

The write path uses the same natural-language planner. `BINANCE_AGENT_GOAL` is
still constrained by the hard-coded live policy (BNBUSDT Spot, 5 USDT per day,
50 bps slippage), and the policy gate runs before the order tool.

The deterministic judge path remains the safer reproducible demo:

```bash
npm run demo
npm run verify:live-evidence
```
