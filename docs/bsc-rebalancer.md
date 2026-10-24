# AgentGuard BSC rebalancer

## What this release proves

The BSC release turns the original AgentGuard policy-and-proof model into an
owner-custodied portfolio rebalancer. A user deposits two standard ERC-20
assets into a dedicated vault. The owner selects an operator, but the contract
gives that operator one narrow capability: move the portfolio toward the
configured target within explicit budget, price, slippage, cooldown and expiry
limits.

This repository currently proves the design on an isolated EVM and provides a
keyless BSC testnet service. It does not claim a public deployment, audit,
marketplace listing, ERC-8004 registration, real users or campaign eligibility.

## Trust boundaries

```text
Browser wallet
  | personal_sign session (BSC testnet only)
  v
Origin-bound reference service ---- primary RPC
  | stored unsigned plan               |
  |                                    v
  +---- wallet-signed transaction -> AgentGuardVault
                                         |
Independent verifier RPC <---------------+
  |
  +-> canonical tx + receipt + block + logs + historical snapshot
      -> VERIFIED or FROZEN receipt
```

The planner cannot authorize its own proposal or certify its own execution.
The server stores the exact unsigned plan. The verifier independently checks
the transaction sender, target, calldata, zero native value, snapshot hash,
nonce, deadline, confirmation depth, `Rebalanced` event, input/output transfers,
USD notional and drift improvement.

## Contract guarantees

`contracts/AgentGuardVault.sol` provides:

- owner-only withdrawal, policy changes and pause control;
- owner-or-operator rebalancing, with no arbitrary call surface;
- one immutable router, two immutable assets and two immutable price feeds;
- 18-decimal USD per-action and daily budgets in either trade direction;
- positive, non-future, fresh oracle answers;
- an oracle-derived output floor plus a maximum 500 bps configured slippage;
- direction checks and a strict reduction in target-allocation drift;
- nonce, 120-second maximum deadline, cooldown and reentrancy protection;
- exact temporary router approval, cleared after the swap.

Only conventional ERC-20 tokens are supported. Fee-on-transfer, rebasing,
callback-bearing and otherwise non-standard assets are out of scope.

## Local proof path

Requirements: Node.js 20.18 or newer. No wallet, key, RPC account or public
funds are needed.

```bash
npm install
npm run bsc:check
npm run bsc:serve
```

Open `http://127.0.0.1:43188/bsc/` and select **Run full safety test**. The UI:

1. resets an isolated Anvil chain;
2. deploys the vault, mock tokens, mock feeds and router;
3. executes a real bytecode-level rebalance and verifies it;
4. proves that owner pause blocks planning and execution;
5. submits an unrelated transaction as a false proof;
6. freezes the runner while preserving owner pause/withdraw controls;
7. records an exportable proof journal.

The mock assets, oracle and router exist only inside that process. Receipts use
`environment: LOCAL_EVM` and `campaignProof: false`.

Select **Test oracle outage** to make the local feed stale on-chain. The console
hides USD valuation and allocation percentages, blocks new execution, and keeps
anchored token balances and owner controls available, including after reload.
**Reset lab** restores the local baseline and updates both mock feeds on-chain
to the current local-chain time. Repeated drills still work after the console
has been idle beyond the oracle freshness window. This failure drill is local-only.

Local execution and fault drills save the returned transaction hash and
`VERIFYING` state before confirmation/proof RPC reads. If those reads fail,
the journal retains the original hash without issuing a receipt or freezing
the runner. After reload, select **Resume verification** and **Retry verification
· no new trade**; retries through either local endpoint verify that same hash.
Current oracle availability does not block checking a historical execution.
The server serializes concurrent requests, so they reuse the saved result.
Broadcast and the subsequent journal write are separate operations: process
termination or a disk failure before the hash is committed is outside this
recovery guarantee. Resetting the lab deliberately discards its mock-chain history.
Local trade/fault transactions use an explicit gas estimate plus 20% headroom.
This avoids intermittent out-of-gas failures when a timestamp-dependent storage
write costs more in the mined block than it did during estimation.

## BSC testnet path

1. Copy `config/bsc-testnet.example.json` to an ignored local file.
2. Configure the owner, operator, two assets, reviewed router, compatible price
   feeds and policy.
3. Set two independent HTTPS endpoints in `.env` using `.env.example`.
   Run `npm run bsc:doctor` for a redacted offline configuration report, then
   `npm run bsc:doctor -- --online` for read-only chain checks. A blocked report
   exits 2 and lists the missing fields; reports are saved in the ignored
   `.runtime/bsc-doctor.json`. The offline command works before `.env` exists.
4. Run `npm run bsc:deploy-console -- config/bsc-testnet.json`.
5. Open the printed `/bsc/deploy/` URL (default port 43191), connect the
   configured owner on chain 97, and inspect every address and policy value.
6. Check the two review confirmations, request deployment, then explicitly
   confirm in the wallet. This spends testnet gas only; it bundles no deposits
   or token approvals. Deployment stays disabled until the readiness checks
   pass, and those checks run again immediately before the wallet request.
7. Wait for two confirmations and select **Verify deployment**. The independent
   RPC must return `VERIFIED` before using the address.
8. Set `BSC_VAULT_ADDRESS` to that verified address in `.env`, then run
   `npm run bsc:testnet`.

The preparation command checks chain ID 97, contract code at each dependency,
constructor invariants and deployment simulation. It creates unsigned calldata;
it cannot broadcast and never asks for a private key. The deployment console
uses the same preparation checks and has no server-side send endpoint.

The console's readiness panel and online doctor inspect a recent mined block
through both RPC providers. They check the EOA owner, native test balance,
dependency bytecode, token/feed interfaces, positive completed oracle rounds
within the policy age, both direct-route quotes at the action limit, and exact
constructor gas estimation. The owner must cover the current gas estimate with
a 20% buffer. The providers must agree on block hash, bytecode hashes, token
metadata/prices, owner balance and anchored gas estimate; both recheck the block
hash after inspection. Current gas prices may differ between providers, and
each balance check must pass. Cached prices are never substituted.

The UI readiness result expires after 60 seconds. Rejection, RPC outage,
provider disagreement, stale chain head or a failed dependency check keeps
deployment disabled. A direct quote is a compatibility probe, not a swap or
liquidity/fill guarantee. Feed-to-asset mapping, router trust and nonstandard
token behavior still require review. `bsc:prepare` alone checks constructor
compatibility; run the online doctor before a manual wallet deployment too.

The deployment service exposes `GET /api/v1/deployment`, plus same-origin,
JSON-only, rate-limited `POST /api/v1/deployment/preflight` with `{}` and
`POST /api/v1/deployment/verify` with a transaction hash. Preflight never accepts
replacement addresses from the browser or sends a transaction.

For a manual wallet workflow:

```bash
npm run bsc:prepare -- config/bsc-testnet.json
# inspect .runtime/bsc-deployment-transaction.json; sign creation in owner wallet
npm run bsc:verify-deployment -- config/bsc-testnet.json 0xYOUR_TRANSACTION_HASH
```

Deployment verification binds the canonical transaction and receipt, sender,
creation calldata, zero native value, predicted CREATE address, exact runtime
(including immutable values), and initial policy at the deployment block.
It requires historical state from the independent RPC and rechecks the block
hash after those reads. An unavailable archive RPC is an error, never a pass.
The CLI writes a local proof and exits 0 for `VERIFIED`, 2 for `PENDING`, and 1
for a mismatch or error. This is an initial deployment attestation, not an
audit, a guarantee of unchanged future policy or campaign qualification.

The console stores only the public submission marker/hash in browser storage.
It disables repeat submission across reloads after an uncertain wallet result;
inspect wallet activity and paste the existing hash rather than resending.
An explicit wallet rejection permits a deliberate retry. The verification
API is same-origin and rate-limited; no private key is requested or stored.

The browser discovers EIP-6963 wallets, requests a short-lived `personal_sign`
session bound to origin, chain, vault, wallet and nonce, then requests wallet
confirmation for each transaction. Smart-contract wallets using ERC-1271 are
not supported in v0.4.

Wallet listeners attach before the account prompt. Account/network/disconnect
events invalidate the in-progress login and detach its listeners; checks after
signing and session exchange also reject silently changed wallets. An exchange
that returns after cancellation has its orphan token revoked. The browser keeps
the session expiry only in memory and disables wallet actions on timeout or an
authenticated HTTP 401. Late responses from an older session cannot restore it
or clear a newer session. Reconnect and preview again after a wallet change.

Each send binds to the wallet/session captured before preparation and checks
account, network and expiry again before requesting the transaction. Switching
wallets while an already-open transaction dialog is pending cannot cancel that
wallet request. Any returned rebalance hash is still saved in the recovery
marker; automatic verification stops until the user reconnects. Owner funding
and pause/withdraw transactions do not have that marker: inspect wallet history
before repeating an interrupted owner action.

### Rebalance submission recovery

Before opening the wallet for a rebalance, the execution console writes the
chain, vault, account, job/plan IDs, nonce, deadline and start time to browser
storage. It adds the transaction hash when returned. It never stores session
tokens, signatures or keys. Unavailable/corrupt storage or missing Web Locks
support blocks the request before a wallet call.

An exclusive Web Lock and the saved marker prevent two tabs from submitting
simultaneously. A transport failure keeps the marker even when no hash returned.
After reconnecting, select **Resume verification**, recover the hash from wallet
history if necessary, and verify it against the saved server journal. Only a
matching `VERIFIED` receipt clears the request automatically. An explicit wallet
rejection (code 4001) permits a deliberate retry; no automatic retry is made.

The marker can also be released after a fresh service snapshot shows that the
on-chain deadline has strictly passed or its nonce has been consumed. Release
uses the same cross-tab lock and cannot interrupt an open wallet request.
This is `RELEASED_NOT_VERIFIED`, not proof that a trade succeeded. Check wallet
history before planning again. The release snapshot comes from the primary RPC;
actual receipt verification still uses the independent verifier.

### Execution proof block anchors

The verifier binds the requested hash to both the transaction and receipt,
including sender, destination and transaction index. Every receipt log must
belong to that transaction and block and must not be marked removed. After
reading historical state, the verifier rechecks both the execution block hash
and the snapshot block hash, then reads an uncached chain head to check the
confirmation requirement. A metadata mismatch or changed anchor yields
`FROZEN`; two confirmations reduce reorg risk without guaranteeing finality.

A transport error during the final block/head checks returns no proof. The
service retains the transaction and `VERIFYING` job in its journal so the same
hash can be checked again after RPC recovery. Missing/pruned snapshot state
cannot pass `snapshotBound`. Completed receipts include both block hashes and
the confirmation count observed at verification time; these are point-in-time
observations, not continuous finality monitoring.

This recovery mechanism covers rebalance submissions, not funding or owner
controls. Browser storage is scoped to the browser and origin: clearing it,
changing ports or using another device bypasses this UI safeguard. On-chain
nonce, deadline and budget enforcement remain the contract boundary. There is
no background replacement/cancellation monitor. The testnet service does retry
independent verification of hashes already saved in the journal, as described
in the [operations guide](bsc-operations.md); unknown wallet submissions still
require the user to recover their hash.

## API surface

All mutations are same-origin, JSON-only and rate-limited. In testnet mode they
require a bearer session obtained from the connected owner or operator wallet.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/status` | Anchored balances, policy, journal and readiness; null portfolio when pricing is unavailable |
| `GET /healthz` | Process liveness, independent of runner incidents |
| `GET /readyz` | RPC and pending-work readiness; HTTP 503 during incidents |
| `GET /api/v1/operations` | Redacted reconciliation state and stale pending hashes |
| `POST /api/v1/auth/challenge` | Create a single-use wallet challenge |
| `POST /api/v1/auth/session` | Exchange a signature for a 15-minute session |
| `POST /api/v1/plans` | Store and return one deterministic unsigned proposal |
| `POST /api/v1/verify` | Verify a submitted hash with the independent RPC |
| `POST /api/v1/action` | Build exact approve/deposit/withdraw/pause transactions |
| `POST /api/v1/recover` | Clear runner freeze only after confirmed on-chain pause |

An unknown transaction hash is not bound to a job. A pending hash is persisted
only when the verifier RPC can see the transaction. A failed proof remains in
the journal; recovery never rewrites or deletes it.

The supplied server defaults to `127.0.0.1`. A testnet release can explicitly
configure a public HTTPS origin behind the supplied gateway and persistent
single-writer journal. Local mode rejects all public-origin/non-loopback
settings. See [Public service operations](bsc-operations.md) for deployment,
health checks, background verification, locks and backups. Hosting, upstream
client rate limits and incident alerts still need operator configuration.

Status and startup may tolerate an unavailable oracle, but never use a cached
price: `pricing.available` is false and `portfolio` is null. Planning and proof
verification remain strict. Owner pause/withdraw construction and incident
acknowledgement do not depend on fresh prices. This does not provide availability
when the entire RPC is down, the vault is unreadable, or the token contract fails.

## Set and Earn launch gate

Source: [BNB Chain Smart Money Era: Set and Earn](https://www.bnbchain.org/en/hackathons/smart-money-era-set-and-earn)

The code is not the campaign entry by itself. Before claiming readiness:

- register the campaign wallet before qualifying actions;
- publish the HTTPS service and public registration card;
- deploy an ERC-8004 identity on chain 56 or 97 owned by that wallet;
- create a new listing on a shortlisted agent marketplace;
- complete the required hires without self-funding or controlled users;
- produce at least five genuine category-consistent actions across three days;
- keep the source repository public and preserve public evidence.

TermiX currently documents BNB Chain mainnet (chain 56), while this unaudited
client permits BSC testnet (chain 97) only. No TermiX adapter is implemented.
Confirm a shortlisted market's testnet path or conduct a separate mainnet
security release; do not silently treat chain 97 as marketplace compatibility.

Run `npm run bsc:readiness` to write `.runtime/bsc-readiness.json`. The command
is read-only: it does not mint an identity, publish a listing, hire an agent,
sign a transaction or move funds.

## Production blockers

- independent security audit and deployment review;
- reviewed production router, feeds and supported-asset allowlist;
- provisioned public HTTPS host, backups, per-client gateway limits and alerts;
- ERC-1271 support if smart accounts are required;
- replacement-transaction resolution and continuous finality monitoring;
- public BSC deployment and independently reproducible evidence;
- marketplace-specific runtime adapter and successful external-user trials.
