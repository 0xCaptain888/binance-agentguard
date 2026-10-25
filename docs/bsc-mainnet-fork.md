# Reproduce BSC mainnet compatibility without mainnet spending

This path copies a mined BSC mainnet snapshot into a disposable local Anvil
chain. It exercises the actual PancakeSwap v2 router, WBNB/USDT pool, tokens
and Chainlink feeds at that source block. It creates no mainnet transaction,
uses no user wallet and provides no campaign-qualifying public execution proof.

## Run

```bash
npm ci
npm run bsc:fork
```

No API key is required for the default public source. Optionally set
`BSC_MAINNET_FORK_RPC_URL` in ignored `.env` to an HTTPS provider that can serve
historical BSC state. `BSC_FORK_BLOCK` selects an explicit positive block number;
otherwise the source is 64 blocks behind the observed head. Unavailable historical
state, stale feeds, missing liquidity or failed safety checks fail verification.
The script does not relax safeguards or substitute oracle data.

The atomic, private report is `.runtime/bsc-mainnet-fork.json`. A failed run
replaces an earlier successful report with `FORK_VERIFICATION_FAILED`; successful
reports carry `FORK_SIMULATION_VERIFIED` and a SHA-256 `reportHash` over the JSON
body without that field, using the repository's `json()` serializer. This hash
detects changes; it is not an independent attestation. Reports are historical,
and a later block or different state can produce a different result.

The manual **BSC mainnet fork simulation** GitHub Actions workflow runs the same
command on Ubuntu and preserves its report as an artifact. The optional repository
secret `BSC_MAINNET_FORK_RPC_URL` selects a private read provider; leaving it unset
uses the public default. No signing secrets are needed. Normal Judge CI does not
depend on the availability of a public mainnet RPC.

## What is checked

1. The source reports chain 56 and supplies a confirmed block hash. Fork execution
   reports chain 31337. Code hashes for router, factory, both tokens, both feed
   proxies and pair match the source. Initial pair reserves match the same
   historical source block.
2. Router `factory()` and `WETH()` match the published configuration. Both
   tokens have 18 decimals; both feeds have the expected descriptions and
   positive, complete rounds no older than 3,600 seconds at the anchor.
3. A newly deployed AgentGuardVault uses a $10 action cap, $25 daily cap,
   50/50 target, 1% slippage floor and 300-second cooldown. Synthetic Anvil native
   funds wrap into WBNB; a real-router swap acquires USDT before deposit.
   There is no token minting, account impersonation, code replacement, storage
   replacement or oracle override.
4. The operator executes one bounded local rebalance. Canonical local
   transaction, calldata, receipt, logs and token transfers pass the existing
   verifier at two local confirmations. Drift improves, subsequent planning
   is blocked by cooldown, owner pause also blocks it, pair reserves change
   locally and the vault's router allowance is zero.
5. The source anchor is rechecked. Every upstream request passes an explicit
   read-only allowlist; upstream signing and broadcast methods are denied.
   Anvil receives only the loopback relay URL. RPC credentials are excluded
   from arguments, console errors and reports. Read transport failures have
   bounded retries. Deadline and termination handlers stop the disposable node.

The nested execution receipt retains the verifier's generic `LOCAL_EVM` /
`LOCAL_FIXTURES` classification for chain 31337. The enclosing report records
the mainnet source, copied protocol code and reserves. Neither is a BscScan
receipt or a live trade.

## Dependency provenance

| Dependency | BSC mainnet address |
| --- | --- |
| PancakeSwap v2 router | `0x10ED43C718714eb63d5aA57B78B54704E256024E` |
| PancakeSwap v2 factory | `0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73` |
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` |
| Binance-Peg USDT | `0x55d398326f99059fF775485246999027B3197955` |
| BNB / USD feed proxy | `0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE` |
| USDT / USD feed proxy | `0xB97Ad0E74fa7d920791E90258A6E2085088b4320` |

Sources: PancakeSwap's [pinned official v2 address table](https://github.com/pancakeswap/pancake-developer/blob/e4778927f6e69ae6c1d90de08265c1d405f93703/docs/pages/contracts/v2/addresses.md),
the official `@pancakeswap/tokens` package, and Chainlink's
[BSC mainnet feed directory](https://reference-data-directory.vercel.app/feeds-bsc-mainnet.json).
Published addresses plus matching code and descriptions do not constitute an
audit or a promise about future market execution.

## Verification observed October 26, 2026 (UTC+8)

A local run at source block **129769305**, hash
`0x30594adeb6da0d323fd48fc423faed58697dc3d0b24a4301244117ff768241a8`,
passed all 20 receipt checks, cooldown, pause and zero remaining router allowance.
Its source pair was `0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE`.
All 93 upstream read requests completed with zero denied requests, failed
requests or retries. This records one historical simulation, not public trading
activity or a guarantee that a future run will pass.
