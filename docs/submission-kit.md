# Binance AgentGuard submission kit

## Project name

Binance AgentGuard

## One-line pitch

The accountable action layer that lets AI Agents act on Binance without giving them unchecked authority.

## Short description

Binance AgentGuard converts a natural-language trading goal into a bounded Binance Spot intent, authorizes only actions inside symbol, market, budget, slippage, and user-confirmation policy, then independently queries Binance to verify the resulting order. Every task ends as VERIFIED, BLOCKED, or FROZEN with intent, policy, and evidence hashes. The submission includes one real Binance Spot order, one actual AI-planned live MCP read that safely paused without confirmation, a credential-free interactive Judge Console, and one-command evidence verification.

## Problem

Agent tool calls only prove that software returned a response. They do not prove
that an action was authorized, that the returned order matches the original
intent, or that an unsafe result cannot continue through a workflow.

## Positioning guardrail

Do not describe the project as “a tool that prevents Agents from placing
orders.” Describe it as the accountable action layer that grants bounded
authority, verifies how that authority was exercised, and produces evidence
that users, teams, or downstream systems can audit.

## Innovation

- Separates probabilistic AI planning from deterministic authorization.
- Gives Agents a bounded, auditable way to act before the Binance tool call.
- Independently queries Binance after execution instead of trusting Agent output.
- Distinguishes pre-execution `BLOCKED` from post-execution `FROZEN`.
- Hash-binds intent, policy, result, and verification into a portable receipt.

## Why Binance

Binance Agentic MCP supplies the authenticated execution boundary, isolated
Agentic account context, live market data, Spot execution, and authoritative
order/trade records. AgentGuard adds the missing organization-level control and
verification layer around those capabilities.

## Commercial value

Agent developers, trading teams, DAOs, and treasury operators can define
per-Agent budgets and approved actions, require human confirmation for selected
risk tiers, isolate mismatched executions, and retain audit-ready receipts. The
same control pattern can later support policy templates, team administration,
and usage-based infrastructure pricing.

## Evidence claims

- Real Binance Spot order: `12512896470`, `FILLED`, 0.007 BNB / 4.81047 USDT.
- Real AI planner + Binance MCP quote: `BLOCKED` with
  `user_confirmation_required`; no order submitted.
- Reproducible judge path: `VERIFIED`, `BLOCKED`, and `FROZEN`.
- Automated verification: 9 tests, CI, CodeQL, and credential-free evidence
  hash recomputation.

## Links

- Repository: `https://github.com/0xCaptain888/binance-agentguard`
- Public demo: `https://0xcaptain888.github.io/binance-agentguard/`
- Latest release: `https://github.com/0xCaptain888/binance-agentguard/releases/latest`
- Demo script: `docs/demo-script.md`
