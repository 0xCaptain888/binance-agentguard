# Three-minute judge demo

This script is designed for a screen recording. Keep the browser on the
Binance AgentGuard page and the terminal visible only when running the single
command below.

## 0:00–0:25 — the problem

“An AI agent can call a trading tool, but a successful tool call is not proof
that the action was allowed or that the result was safe. Binance AgentGuard
adds a policy gate before the call and an independent verifier after it.”

## 0:25–0:55 — the policy

Show the policy card:

- Spot market only
- BNBUSDT only
- 5 USDT per action
- 10 USDT daily limit
- 50 bps maximum slippage
- user confirmation required

“The policy is executable data, not a paragraph in the README.”

## 0:55–1:35 — VERIFIED

Run:

```bash
npm run demo
```

Pause on the first receipt. Point to the quote, filled order, four verifier
checks and the 64-character evidence hash.

“The receipt binds the intent and policy hashes to the observed order and the
verification result.”

## 1:35–2:05 — BLOCKED

Pause on the second receipt.

“This request asks for 25 USDT against a 5 USDT limit. AgentGuard rejects it
before the Binance gateway is called. There is no order ID because no order
was submitted.”

## 2:05–2:35 — FROZEN

Pause on the third receipt.

“The gateway returned a filled order, but the observed notional is 10 USDT,
outside the policy. The independent verifier fails closed and the task enters
FROZEN. This is different from BLOCKED: execution happened, so the unsafe
task is now isolated and cannot continue.”

## 2:35–3:00 — Binance integration and close

Show `src/binance-agentic.ts` and the official Binance documentation links.

“For a live run, this same interface is backed by Binance Agent OS/Agentic
MCP through an authenticated transport. Credentials are injected at runtime,
never committed. We use an isolated Agentic sub-account and no withdrawal
scope. Binance executes; AgentGuard decides whether the request is allowed and
whether the result is trustworthy.”

Close with:

“Binance AgentGuard makes autonomous execution accountable: allowed before
payment, verified after execution, and frozen on bad output.”
