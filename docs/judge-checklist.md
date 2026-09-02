# Judge checklist

The fastest review path is:

```bash
npm install
npm run demo
npm run judge:check
```

Expected states, in order: `VERIFIED`, `BLOCKED`, `FROZEN`.

For each receipt, verify:

1. `intentHash` changes with the request;
2. `policyHash` is stable for the policy version;
3. `evidenceHash` is a hash of the complete receipt inputs;
4. `BLOCKED` contains no order;
5. `FROZEN` contains an order but at least one failed verification check;
6. `VERIFIED` has all four checks set to `true`.

The deterministic demo is intentionally labelled simulator evidence. It is the
credential-free path for every judge. The repository also contains a redacted
real Binance Spot evidence bundle with a Binance order ID, independently queried
fill/trade data, and a reproducible evidence hash:

```bash
npm run verify:live-evidence
```

Judges who already have an authorized Binance MCP session can additionally run
the read-only live path. It reads account state and a fresh quote and cannot
place an order:

```bash
npm run live:run -- --read-only
```

No new live trade is required to verify the submission. Binance Spot order IDs
are exchange records, not public blockchain transaction hashes.
