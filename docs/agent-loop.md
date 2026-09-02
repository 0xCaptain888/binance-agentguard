# Agent loop architecture

Binance AgentGuard separates probabilistic planning from deterministic
authorization. The AI may interpret a goal, but it cannot grant itself
permission or declare its own output safe.

```text
User goal
   │
   ▼
AI planner ──────── natural language → bounded TradeIntent
   │
   ▼
Binance quote ───── read-only market observation
   │
   ▼
Policy engine ───── symbol · market · budget · slippage · confirmation
   │                       │
   │ allowed               └── violation → BLOCKED receipt (no order)
   ▼
Binance MCP ─────── isolated Agentic Spot execution
   │
   ▼
Independent verifier ─ fill · identity · notional · slippage
   │                       │
   │ all pass              └── mismatch → FROZEN receipt
   ▼
VERIFIED receipt
```

## Trust boundaries

| Component | May propose | May execute | May authorize | May verify |
| --- | ---: | ---: | ---: | ---: |
| AI planner | Yes | No | No | No |
| Policy engine | No | No | Yes | No |
| Binance MCP gateway | No | Yes | No | No |
| Independent verifier | No | No | No | Yes |

The deterministic planner is the zero-setup judge path. `npm run agent:live`
optionally asks the local Codex model to produce the plan, then submits that
plan to the same deterministic policy engine. Runtime validation prevents the
model from changing the task identity or returning inconsistent asset fields.

## Evidence boundary

- Simulator evidence is visibly labelled and is reproducible without an
  account.
- Live read-only output uses the locally authenticated Binance MCP session and
  deliberately ends `BLOCKED` because no trade confirmation is supplied.
- The public live evidence bundle records the single previously authorized
  Binance Spot order. No new order is required for judging.
- A Binance Spot order ID is an authenticated exchange record, not a public
  blockchain transaction hash.
