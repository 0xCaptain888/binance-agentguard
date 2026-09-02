# Public live evidence

This directory contains two deliberately separate live evidence bundles:

1. `2026-09-02-bnbusdt-buy-001.json` records one real Binance Spot test order
   submitted through Binance MCP and verified with independent order and trade
   queries.
2. `2026-09-02-ai-live-readonly-001.json` records an actual Codex-generated
   plan plus live Binance MCP quote observation. It ended `BLOCKED` because
   transaction confirmation was absent; no order was submitted.

Neither file contains an API key, secret, passphrase, OAuth token, or session
credential.

This is an exchange order identifier, not a public blockchain transaction
hash. Binance Spot orders are privately queryable through the authenticated
account API.

Verify both bundles without credentials:

```bash
npm run verify:live-evidence
npm run verify:ai-live-evidence
```

The deterministic `VERIFIED / BLOCKED / FROZEN` judge path remains available
via `npm run demo:agent`.
