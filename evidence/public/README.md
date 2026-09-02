# Public live evidence

`2026-09-02-bnbusdt-buy-001.json` records one real Binance Spot test order
submitted through the Binance MCP Server and verified with independent order
and trade queries. It contains no API key, secret, passphrase, or session
credential.

This is an exchange order identifier, not a public blockchain transaction
hash. Binance Spot orders are privately queryable through the authenticated
account API. The deterministic `VERIFIED / BLOCKED / FROZEN` judge path remains
available via `npm run demo`.
