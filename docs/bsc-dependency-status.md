# BSC testnet dependency investigation

## Status on October 25, 2026

The OKX extension selector is implemented in both the console and deployment
page. It never falls back to MetaMask when OKX is missing. A running local lab
does not request wallet access; public-chain wallet operations require a
separately deployed and verified chain-97 vault.

No public-chain transaction was created during this investigation. The testnet
vault is **not deployed**. The operator is still unconfigured; no delegated
agent identity has been invented or inferred from the owner's address.

The two providers independently returned identical dependency reads at BSC
testnet block **138751338** on October 25, 2026 UTC. This is a historical
snapshot; rerun the probe before making any deployment decision.

## Sources and chain reads

- PancakeSwap's [official v2 address table](https://github.com/pancakeswap/pancake-developer/blob/e4778927f6e69ae6c1d90de08265c1d405f93703/docs/pages/contracts/v2/addresses.md)
  lists router `0xD99D1c33F9fC3444f8101754aBC46c52416550D1` and factory
  `0x6725F303b657a9451d8BA641348b6761A6CC7a17`.
- The router's `factory()` and `WETH()` matched the published factory and WBNB
  `0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd`.
  Both router and WBNB had contract code.
- Token candidates come from `@pancakeswap/tokens` **0.10.0**, the package
  identified by the [official token SDK guide](https://github.com/pancakeswap/pancake-developer/blob/e4778927f6e69ae6c1d90de08265c1d405f93703/docs/pages/sdks/tokens.md).
  These are test tokens; their symbols do not establish economic equivalence to
  mainnet assets or sufficient pool liquidity.
- Feed candidates come from the **BNB Chain Testnet** section of
  [Chainlink's official address directory](https://docs.chain.link/data-feeds/price-feeds/addresses?network=bnb-chain).
  Positive answers and matching descriptions are compatibility observations,
  not independent attestations of token-to-feed mappings.

## Candidate results

All four candidates were quoted directly against WBNB in both directions at
the configured $10 action limit and 1% oracle floor:

| Candidate | Feed freshness | Direct-route observation | Ready |
| --- | --- | --- | --- |
| CAKE | Within 1 hour | CAKE → WBNB output about 0.00735 WBNB, below the approximately 0.01340 WBNB floor | No |
| BUSD | Older than 1 hour | Reverse output far below floor; pool pricing diverged sharply from the feed | No |
| USDT | Older than 1 hour | Direct quotes unavailable in both directions | No |
| USDC | Older than 1 hour | Both directions below the oracle floor | No |

The broader feed scan found BNB, LINK and CAKE fresh at inspection time.
A fresh LINK feed alone does not establish a reviewed test token and direct
pair. This investigation does not claim that every possible testnet pair was
searched or that no compatible pair can exist.

## Repeat the read-only investigation

Set `BSC_TESTNET_RPC_URL` and `BSC_VERIFIER_RPC_URL` in ignored `.env`, using two
different HTTPS chain-97 providers:

```bash
npm run bsc:dependencies
npm run bsc:doctor
```

The first command does not require an operator, second token or deployed
vault. It saves both provider responses, feed rounds/timestamps, quote inputs,
outputs and floors to ignored `.runtime/bsc-dependencies.json`. Candidate
inspection success means the reads agreed; **it never means deployment-ready**.
RPC failures and disagreements produce a nonzero exit status.

Preflight now also retains raw oracle rounds and reports observed age versus
the policy maximum. Two providers returning the same price from different
rounds cannot produce READY.

## Remaining deployment requirements

1. A reviewed second test token, mapped feed and direct router pair that pass
   freshness and both quote directions without relaxing protection.
2. An explicitly chosen operator. Owner-operated manual tests must be labelled
   as such; they do not demonstrate autonomous delegation.
3. Full `bsc:doctor -- --online` readiness, owner-reviewed OKX deployment, and
   independent deployment verification.
4. A public HTTPS origin and verified identity registration before publishing
   an active registration card. Campaign eligibility has additional requirements
   outside this testnet deployment.

No new funding is requested for these dependency blockers. Funding the owner
does not fix stale oracle rounds or mispriced testnet pools.
