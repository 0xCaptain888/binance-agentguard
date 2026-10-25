# OKX pending nonce compatibility

Controlled setup previously accepted only a hexadecimal string from
`eth_getTransactionCount(account, "pending")`. Both environment deployment and
synthetic-feed refresh now share the same safe RPC quantity normalizer used for
chain IDs. Hexadecimal strings (including an uppercase prefix), decimal strings,
safe integer numbers and bigints are accepted without changing the integer value.
Zero is valid.

Missing values, objects, empty strings, fractions, negative numbers and integers
outside JavaScript's safe range remain blocked. No invalid result falls back to
zero, and error messages include only a bounded type/format description. A failed
read is never retried automatically.

The bound connection is still checked after the asynchronous nonce read. Recovery
records are still written before a signing request, the outbound nonce is canonical
hex, and uncertain submissions keep their recovery locks. Existing recovery records
are not cleared by this update.

The local setup server serves these JavaScript files with `Cache-Control: no-store`.
Refresh the setup page to load the change; this static-asset fix does not require
restarting that server.

## Validation

Local checks on October 26, 2026 passed: all 151 Node tests, TypeScript checking,
JavaScript syntax checks, site verification (29 signals) and `git diff --check`.
The tests cover accepted nonce formats, invalid responses, legitimate zero,
single-read behavior and connection changes during a nonce read.

The controlled-setup browser suite now contains 57 cases. Local Chromium could
not launch because the macOS sandbox denied its Mach bootstrap registration;
these cases have not passed locally. The existing Ubuntu GitHub Actions job
runs the browser regression suite after push.

The actual value returned by the user's OKX extension has not been captured.
This patch fixes the strict format check and adds safe diagnostics; real wallet
signing and BSC Testnet deployment still require confirmation in the browser.
