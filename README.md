# Binance AgentGuard

Policy-gated execution for a Binance AI Agent: the agent can plan and request a Spot action, but AgentGuard only permits actions inside an explicit budget, symbol, market and slippage policy. Every permitted action is independently checked after execution and produces a tamper-evident receipt.

## The judge path

```text
Binance Agent OS / Agentic MCP
        ↓
Binance AgentGuard policy gate
        ↓
user confirmation
        ↓
Binance Spot execution
        ↓
independent order verification
        ↓
VERIFIED / BLOCKED / FROZEN + evidence hash
```

The demo uses one bounded scenario: a BNBUSDT Spot action with a 5 USDT per-action limit and 50 bps maximum slippage. It intentionally shows all three outcomes:

- `VERIFIED`: the order is filled and every post-execution check passes.
- `BLOCKED`: the request exceeds policy, so no order is submitted.
- `FROZEN`: execution returns an unsafe result, so the AgentGuard circuit breaker freezes the task.

## Run in under five minutes

Requirements: Node.js >= 20.18.

```bash
npm install
npm run demo
npm test
npm run typecheck
```

The simulator is deterministic and does not move funds. It is the reproducible judge path. The live adapter in `src/binance-agentic.ts` is a credential-free protocol boundary: connect it to an authenticated Binance Agent OS/Agentic session only after explicitly authorizing the account and scopes.

## Binance integration boundary

Binance's public Agent Native documentation describes the Agentic MCP endpoint and an isolated Agentic sub-account with no withdrawal scope. The live transport is intentionally injected rather than storing API keys in this repository. See [`docs/binance-agent-os.md`](docs/binance-agent-os.md).

## Evidence model

Each run hashes the intent, policy, quote, order and verification result into `evidenceHash`. A receipt records the state, policy hash and all verification checks. `FROZEN` is an AgentGuard safety state: it disables further actions for the task; it does not claim that Binance itself freezes an account.

## Relationship to the original project

This is the focused Binance A-track application. The broader control-plane research remains in [`0xCaptain888/agent-control-plane`](https://github.com/0xCaptain888/agent-control-plane); it is not required to run this judge path.

## Security notes

- No credentials, private keys or API keys are committed.
- The first live trial should use an isolated Agentic sub-account and the smallest amount required by the event.
- Spot-only and no-withdrawal permissions are intentional defense in depth.
- Never present simulator receipts as real Binance trades; live receipts must include a Binance order ID and independently queried order status.
