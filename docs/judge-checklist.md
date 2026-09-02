# Judge checklist

## 60-second browser review

1. Open the public Judge Console.
2. Click `VERIFIED`, `BLOCKED`, and `FROZEN`.
3. Inspect the **Three layers of evidence** section.
4. Confirm the page distinguishes real execution, live read-only evidence, and
   deterministic simulation.

## Five-minute repository review

The fastest local path is:

```bash
npm install
npm run demo:agent
npm run judge:check
```

Expected states, in order: `VERIFIED`, `BLOCKED`, `FROZEN`.

The Agent demo begins with a natural-language goal and exposes the full trace:

```text
GOAL → QUOTE → INTENT → POLICY → EXECUTION → VERIFICATION → RECEIPT
```

For each receipt, verify:

1. `intentHash` changes with the request;
2. `policyHash` is stable for the policy version;
3. `evidenceHash` is a hash of the complete receipt inputs;
4. `BLOCKED` contains no order;
5. `FROZEN` contains an order but at least one failed verification check;
6. `VERIFIED` has all four checks set to `true`.

The deterministic demo is intentionally labelled simulator evidence. The
repository also contains a real Binance Spot evidence bundle with a Binance
order ID, independently queried fill/trade data, and a reproducible evidence
hash:

```bash
npm run verify:live-evidence
```

The second public bundle proves the actual model-planning and live Binance MCP
read path while also proving the confirmation boundary prevented an order:

```bash
npm run verify:ai-live-evidence
```

Judges who already have an authorized Binance MCP session can additionally run
the read-only live path. It reads account state and a fresh quote and cannot
place an order:

```bash
npm run live:run -- --read-only
```

To additionally test model-generated planning, use the optional local Codex
planner. It still performs only Binance reads and must finish `BLOCKED` with
`user_confirmation_required`:

```bash
npm run agent:live
```

No new live trade is required to verify the submission. Binance Spot order IDs
are exchange records, not public blockchain transaction hashes.
