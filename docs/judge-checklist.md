# Judge checklist

The fastest review path is:

```bash
npm install
npm run demo
npm test
npm run typecheck
```

Expected states, in order: `VERIFIED`, `BLOCKED`, `FROZEN`.

For each receipt, verify:

1. `intentHash` changes with the request;
2. `policyHash` is stable for the policy version;
3. `evidenceHash` is a hash of the complete receipt inputs;
4. `BLOCKED` contains no order;
5. `FROZEN` contains an order but at least one failed verification check;
6. `VERIFIED` has all four checks set to `true`.

The deterministic demo is intentionally labelled simulator evidence. A live
submission must replace `binance-agentic-simulator` with an authenticated
Binance Agentic transport and include the Binance order ID and a fresh status
query in its evidence bundle.
