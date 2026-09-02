# Demo evidence

`npm run demo` produces three receipts at runtime. They are deterministic in
their quote/order values but have a current `createdAt`, so they are not
committed as fake historical trades.

For a real Binance run, place redacted receipts under `evidence/live/` locally
and do not commit credentials. The live receipt must include a Binance order
ID, the post-execution order response, and the evidence hash.
