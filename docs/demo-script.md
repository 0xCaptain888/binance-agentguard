# Three-minute judge demo

## 0:00–0:25 — Problem

“An AI Agent needs a way to act—not just a way to be stopped. A successful tool call still does not prove that the action was authorized or that the result was safe. Binance AgentGuard is the accountable action layer: it gives the Agent bounded authority before the call and independently verifies reality after it.”

## 0:25–0:55 — Binance policy

Show the **Executable policy** card on the public page: SPOT only, BNBUSDT only, 5 USDT per action, 10 USDT daily limit, 50 bps slippage, and user confirmation required.

“This policy is executable data, not a paragraph in the README. The model proposes; the guard decides.”

## 0:55–1:25 — VERIFIED

Click **VERIFIED example** in the Judge Console. Point to `GOAL → QUOTE → INTENT → POLICY → EXECUTION → VERIFY → RECEIPT`, the FILLED simulated order, four checks, and the evidence hash.

“This is a deterministic simulator for the public judge path. It is explicitly labelled as simulation.”

## 1:25–1:55 — BLOCKED

Click **BLOCKED example**.

“This asks for 25 USDT against a 5 USDT per-action limit. AgentGuard declines to grant authority for this action before the Binance gateway is called. There is no order ID.”

## 1:55–2:25 — FROZEN

Click **FROZEN example**.

“The gateway returned a filled result, but the observed notional is 10 USDT. The independent verifier fails closed, marks `notionalWithinPolicy=false`, and isolates the task as FROZEN.”

## 2:25–3:00 — Real proof and close

Open the **REAL EXECUTION** evidence link and show order `12512896470`, then show the **LIVE READ-ONLY** evidence link. Explain:

“The real Binance order is separately recorded and independently verifiable. The live Agent run used an actual model and Binance MCP quote, but ended BLOCKED without user confirmation. No credentials are in the repo, and no new trade is needed for judging.”

Close with:

“Binance AgentGuard is the accountable control plane between an Agent’s intent and Binance execution: the Agent can act inside explicit boundaries, every result is verified, and bad output is frozen.”
