# Controlled deployment envelope and same-nonce recovery

## Report and scope

On October 26, 2026, OKX Wallet displayed an `eth_sendRawTransaction` failure:
RPC error `-32000`, `tx size is too large`, for a BSC Testnet deployment with
nonce 16. The screenshot shows only a shortened transaction hash. It does not
establish whether any provider accepted the transaction.

The compiled environment initcode is 7,390 bytes and its runtime is 625 bytes.
The visible serialized transaction uses a type-2 envelope with zero-valued fee
fields. These observations do not establish the cause of the RPC size error.
This patch removes reliance on wallet-inferred gas and fee fields; successful
real-wallet broadcasting still needs to be checked.

## Explicit unsigned envelope

- Both RPC providers inspect the same canonical block, balance, deployment data
  and estimate. The service checks the block again after inspection.
- The actual transaction has `type: "0x0"`, a positive `gasPrice`, the estimated
  gas limit rounded up with a 20% buffer, chain ID `0x61`, and zero native value.
- The higher observed gas price is used in both the outbound envelope and the
  displayed maximum fee. Insufficient balance, zero fees or an above-block gas
  limit stop preparation.
- The browser validates the envelope, gas report, buffer and funding before any
  wallet request. The server never signs or broadcasts.

## Recovery without a returned hash

Check wallet Activity first. If a full transaction hash exists, enter it in
Recover & Verify. A missing hash is not evidence that no transaction was sent.

For a hashless `WALLET_REQUESTED` record with a valid saved nonce, a separate
recovery control can open a new wallet review using that same nonce and the
same deployment data. It requires:

1. The synthetic-assets acknowledgement and a separate recovery acknowledgement.
2. Agreement on chain 97 and on the saved nonce in all four reads: `latest` and
   `pending` through each RPC. These checks run before and after preparation.
3. The original owner connection, unchanged local recovery record, and a wallet
   pending nonce matching the saved nonce immediately before requesting review.
4. Durable recovery storage and the existing cross-tab wallet-request lock.

The ordinary deployment button remains locked. Hash-bearing, verified, legacy,
malformed or nonce-less records do not enable this recovery action. User
rejection restores the original lock exactly; an ambiguous response preserves
the original nonce. A successful response saves its hash for independent
verification. Reloading does not send a transaction.

RPC checks cannot rule out a transaction known only to another node, nor prevent
state changing after the checks. Keeping the same nonce and deployment avoids
intentionally authorizing a second deployment at a new nonce. Do not edit the
nonce in the wallet.

## Validation

Local checks on October 26, 2026:

- All 154 Node tests pass, including isolated Anvil chain-97 execution of the
  exact prepared legacy envelope and independent deployment attestation.
- Retry checks cover strict input, independent nonce disagreement, advanced
  nonces, unavailable reads, preparation races, origin protection and no broadcast.
- TypeScript, JavaScript syntax checks, the local EVM demo and site verification
  (29 required signals) pass.
- Playwright collects 112 browser cases, including 88 controlled-setup cases.
  Collection is not execution. Local Chromium fails before the first browser
  assertion because the macOS sandbox denies Mach bootstrap registration.
  Ubuntu GitHub Actions must execute the browser suite after push.

The controlled-setup backend must be restarted for the new unsigned envelope and
recovery endpoint. Then refresh the same local setup URL and reconnect OKX.
Public BSC Testnet deployment is not marked complete by these fixture tests.
