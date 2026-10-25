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
testnet block **138753544** at **2026-10-25 00:58:19 UTC**. This is a historical
snapshot; rerun the probe before making any deployment decision.

The new local scan endpoint was exercised at **2026-10-25 01:19:18 UTC**,
block **138756344**. Both providers agreed and all reads completed in about
23 seconds. It found seven tokens, 21 combinations, ten existing pairs, 20
quote directions and zero compatible candidates. Five feeds were stale or
invalid, eleven direct pairs were absent and eleven quote directions reverted
or fell below the floor. This follow-up is also a historical observation,
not a current deployment approval; no transaction was created.

An additional read-only investigation at **2026-10-25 01:27:16 UTC**,
block **138757400**, added the LINK test token from Chainlink's official
directory. Both providers agreed on all eight tokens and 28 combinations,
with zero compatible candidates. LINK had contract code and the documented
18 decimals. WBNB/LINK existed and both feeds were fresh, but a $10 LINK input
returned only **0.000108940433054964 WBNB**, below the
**0.013361274502553002 WBNB** protected floor. BUSD/LINK also failed; LINK's
other five direct pairs were absent. This historical snapshot does not approve
the mapping or any deployment.

The updated terminal command was then exercised at **2026-10-25 01:30:38 UTC**,
block **138757855**. Both providers agreed; all reads completed. The saved
report contained eight tokens, 28 combinations, 12 existing direct pairs and
zero compatible candidates.

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
- The additional LINK candidate
  `0x84b9B910527Ad5C03A9Ca831909E21e236EA7b06` and its 18 decimals come
  from [Chainlink's official LINK token directory](https://docs.chain.link/resources/link-token-contracts#bnb-chain-testnet).
  A published token address does not attest to pool pricing or liquidity.
- Feed candidates come from the **BNB Chain Testnet** section of
  [Chainlink's official address directory](https://docs.chain.link/data-feeds/price-feeds/addresses?network=bnb-chain).
  Positive answers and matching descriptions are compatibility observations,
  not independent attestations of token-to-feed mappings.

## Candidate results

The initial expanded scan inspected seven tokens (WBNB, CAKE, BUSD, USDT, USDC,
HBTC, WBTC), eight feed candidates and all 21 unordered token combinations at a
$10 action limit, 1% oracle floor and 3,600-second maximum oracle age.
Ten direct pairs existed and yielded 20 quote directions. Eleven pairs did
not exist. All reads completed; both providers agreed. No candidate passed
every condition.

| Candidate | Feed freshness | Direct-route observation | Ready |
| --- | --- | --- | --- |
| CAKE | Within 1 hour | CAKE → WBNB output about 0.00737 WBNB, below the approximately 0.01336 WBNB floor | No |
| BUSD | Older than 1 hour | Reverse output far below floor; pool pricing diverged sharply from the feed | No |
| USDT | Older than 1 hour | WBNB direct pair does not exist | No |
| USDC | Older than 1 hour | Both directions below the oracle floor | No |
| HBTC / WBTC | BTC feed 5,189 seconds old | Both directions above floor, but freshness fails; wrapper/feed mappings remain unreviewed | No |

The broader feed scan found BNB, LINK and CAKE fresh at inspection time.
A fresh LINK feed alone does not establish a reviewed test token and direct
pair. Other existing non-WBNB pairs failed at least one quote direction or
feed freshness. Eleven missing pairs are chain observations, not RPC failures.
The search covers only the documented inventory, not every possible testnet
asset or route. The current inventory adds LINK and checks all 28 combinations.

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
RPC failures, incomplete reads, outdated anchors and disagreements produce a
nonzero exit status. A failed attempt replaces the prior saved report rather
than leaving an old successful result in place.
The terminal command aborts RPC work after two minutes, with a 10-second
per-request timeout and no retries. SIGINT/SIGTERM request cancellation and
save a failed report before exiting. Terminal and web scans share atomic
replacement: readers receive a complete report, existing permissive file modes
are replaced with `0600`, and temporary files are removed on save failure.
Abrupt termination such as SIGKILL cannot run cleanup; saved snapshots still
expire after 120 seconds.

The local console includes **What is blocking deployment?**. Its
`GET /api/v1/dependencies` response contains only known states, timestamps,
policy and counts; raw token metadata, RPC URLs and arbitrary error messages
are not exposed. **Run read-only scan** starts a new background scan on the
loopback-only local service via same-origin `POST /api/v1/dependencies/scan`.
Only one scan runs at a time, with a two-minute RPC deadline and a 60-second
cooldown after completion. Scan progress and retry delay survive page reloads
within the running process. Restarting the service resets the job state;
the saved dependency report remains on disk. Scan success means the inspection
completed, not that any candidate passed. Reports are saved with atomic
replacement and private file permissions. Failed scans replace prior success;
the API also reports failure if saving is unavailable.

**Reload saved scan** reads the file without making RPC or wallet requests.
Public/testnet services disable the scan-start endpoint; use the terminal command
there. The page refreshes status every five seconds while visible, and expires
observations independently of a successful refresh. Summaries older than 120
seconds show `STALE_SNAPSHOT`; even a current compatible candidate shows
`REVIEW_REQUIRED`, never deployment readiness. Static GitHub Pages previews cannot
access this local API or start a scan.

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
