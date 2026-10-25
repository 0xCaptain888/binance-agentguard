# Public testnet service operations

This deployment serves one reviewed chain-97 vault. It is a single-process
reference, not an audited production or multi-tenant trading service. No private
key belongs in its environment. The local Anvil fixture cannot be exposed using
the public-service settings.

## Deploy with HTTPS and persistent storage

Prerequisites: a host with Docker Compose, a domain pointing to that host,
ports 80/443 open for the gateway, a separately verified testnet vault, and two
independent HTTPS RPC providers. Hosting charges and DNS/account setup are
external prerequisites; the repository does not provision a paid resource.

1. Copy `deploy/bsc/runtime.env.example` to the ignored
   `deploy/bsc/runtime.env` and fill the public HTTPS origin, vault and both RPCs.
2. Start from the repository root:

   ```bash
   docker compose -f deploy/bsc/compose.yml up -d --build
   docker compose -f deploy/bsc/compose.yml ps
   ```

3. Check `/healthz` (process liveness), `/readyz` (RPC agreement and pending-work
   health), `/api/v1/operations`, `/bsc/`, and
   `/.well-known/agent-registration.json` through the public HTTPS origin.
4. Connect the configured owner or operator in a browser wallet on chain 97.
   Its challenge must show that exact public origin, chain and vault. Review a
   proposal, explicitly sign, and inspect its independent proof.

If the deployment config includes a public HTTPS `publicBaseUrl`, the deployment
console also exposes an ERC-8004 identity panel. Review the generated URI and
registry, confirm the unsigned `register(string agentURI)` call once in the owner
wallet, wait for two confirmations, then verify the hash. The verifier uses both
RPCs and keeps the registration card inactive until the proof is `VERIFIED`.

The app runs as the unprivileged `node` user, with a read-only root filesystem
and a named `/data` journal volume. Its port has no host mapping. The Caddy
gateway handles HTTPS and preserves Host; forwarding headers cannot select an
origin or bypass the application's Host/Origin checks. The gateway must remain
the only public entry point. The service enforces a process-wide RPC request
ceiling and a POST ceiling; add upstream per-client rate limiting and resource
limits before any wider public launch. It intentionally does not trust supplied
IP headers or accept cross-origin browser calls.

For an existing HTTPS gateway on the same machine, set `BSC_PUBLIC_ORIGIN` and
leave `BSC_LISTEN_HOST=127.0.0.1`. Pass the configured public Host unchanged.
All external bind settings are rejected without a testnet HTTPS origin. A
configured URL is not proof that the deployment is reachable or registered.

## Saved-transaction recovery

The testnet worker scans saved `VERIFYING` jobs every 30 seconds. It only
examines hashes already in the journal. It never creates a trade, requests a
signature, broadcasts, replaces or cancels a transaction. It uses the same
serialized independent proof checker as manual verification. RPC errors retain
the saved state for retry; a completed mismatch freezes the runner. Previously
finished receipts remain unchanged.

`/api/v1/operations` exposes the latest scan time, error count, pending count,
runner freeze, and hashes that have remained pending for ten monitored minutes.
The timer begins when this process first observes the job and restarts after
process restart. Monitor `/readyz` with an external uptime/alert service: HTTP
503 means RPC disagreement/unavailability, a frozen runner, a reconciliation
error, or stale pending work. Liveness remains 200 during these incidents so
restarting does not erase an incident or pretend to resolve it. No webhook or
email is sent by this implementation.

A stuck or replaced hash remains pending. Inspect wallet activity and chain
nonce; do not resend automatically. An original job cannot silently change to a
replacement hash. There is no continuous reorg monitor for completed receipts.

## Controlled synthetic setup

`npm run bsc:controlled-setup -- 0xOWNER` starts a loopback-only chain-97 setup
service for rehearsing wallet review and recovery without a server-side signer.
It is intentionally separate from the public rebalancer: the environment uses
synthetic test tokens, fixed-$1 owner-refreshed feeds and a fixed-rate router.
The service labels every response `CONTROLLED_TEST_ASSETS`,
`marketEvidence: false`, and `campaignProof: false`; those markers do not prove
market readiness or campaign eligibility.

The browser must use OKX Wallet on BNB Smart Chain Testnet. Deployment and each
feed refresh are unsigned until the owner reviews them. The service independently
anchors both configured RPCs to one recent block and compares the block hash,
owner balance, deployment gas estimate and init-code hash. It applies the higher
observed gas price to the 20% buffer and fails closed on any disagreement. It
writes proof files with private permissions, binds
deployment recovery to the pending wallet nonce, and binds refresh recovery to
the original feed, sender, calldata, nonce and canonical receipt. Both are
checked against the independent RPCs. An uncertain wallet response remains locked after reload;
only a wallet rejection (`4001`) clears that exact attempt. Never delete a
recovery marker to force another send.

The setup connection listens for account changes, chain changes and disconnect
before opening the account prompt, and detaches these listeners on invalidation.
Every asynchronous pre-send check is bound to the original connection. A late
account response cannot restore it; a hash returned from an already-open
transaction dialog is still persisted. Deployment attestation binds the returned
transaction hash as well as the receipt hash. Both deployment and refresh
verification recheck canonical block identity and two-confirmation depth on
both RPCs after the historical reads; a regressed head cannot unlock recovery.

This mode requires two distinct HTTPS archive-capable chain-97 RPC endpoints and
test BNB for gas. It does not create a vault deposit, trade, approval or
campaign event.

## Journal ownership, restart and backup

One process owns one journal. Startup acquires `<journal>.lock` exclusively and
fails if another writer or a stale lock exists. Graceful SIGTERM drains requests
and releases it. A crash may leave the lock intentionally: stop and inspect the
old process/container before removing **only** its exact lock. Never clear it
just to force a second instance to start. Do not scale replicas over the volume.

For a consistent backup, stop the app gracefully, copy the journal volume to
your backup destination, then restart. Restore only to the same chain/vault;
startup rejects mismatched jobs. Atomic replacement prevents partial application
writes, but is not a distributed transaction or power-loss durability guarantee.
The journal stops accepting new jobs at 500 entries; establish an audited
archive process before reaching that limit. Never delete failed receipts to
make an incident disappear.

## Remaining launch boundaries

A successful container build and passing tests do not deploy a chain vault,
mint an ERC-8004 identity, list an agent, produce independent hires or satisfy
campaign rules. Registration cards stay inactive until an actual identity is
verified. Do not route testnet activity through a marketplace documented only
for mainnet or treat local mock trades as public-chain evidence.
