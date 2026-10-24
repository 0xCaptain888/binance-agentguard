# Security policy

Binance AgentGuard is a hackathon reference implementation, not audited
production trading software. Never place exchange credentials, OAuth tokens,
private keys, passphrases, or unredacted account exports in an issue.

For a suspected vulnerability, contact the maintainer privately through the
GitHub profile rather than opening a public issue. Include the affected commit,
the smallest reproducible case, and whether the report could lead to an
unauthorized Binance write operation.

The deterministic judge demo and public evidence verifier do not require any
Binance credential. Live writes are disabled unless both the runner and bridge
receive separate explicit opt-ins.

## BSC rebalancer scope

The v0.4 BSC vault and service are unaudited reference software. BSC mainnet is
disabled. Local fixtures use mock assets, price feeds and liquidity; they are
not public-chain evidence. The BSC testnet server never accepts a private key
and emits unsigned wallet transactions only.

Before any public deployment, independently review the vault, router and oracle
assumptions, deploy per-user vaults, restrict assets to standard ERC-20 tokens,
use two independent RPC providers, and place a reviewed authenticated HTTPS
gateway with durable storage in front of the service. The server defaults to
loopback; public testnet mode requires an explicit HTTPS origin and listen
address. Host and Origin checks do not trust forwarded headers. A process lock
permits one journal writer; this is not a horizontally scalable queue or a
power-loss-durable database.

The pending-work monitor verifies saved transaction hashes only. It cannot sign
or broadcast transactions. RPC outages retain pending work; evidence mismatches
freeze the off-chain runner. Readiness reports RPC agreement and pending-work
health, not permission to trade or proof of a public deployment.

Known v0.4 limitations include no ERC-1271 smart-wallet authentication, no
fee-on-transfer or rebasing token support, no production marketplace adapter,
and no audit. A verifier failure freezes only the off-chain runner. The owner
must pause the vault on-chain; the UI never claims that an off-chain freeze is
an on-chain kill switch. Owner pause and withdrawal construction remain
available during runner freeze and do not depend on oracle freshness.

See [`docs/bsc-rebalancer.md`](docs/bsc-rebalancer.md) for the complete trust
model, recovery behavior and production blockers.
See [`docs/bsc-operations.md`](docs/bsc-operations.md) for HTTPS deployment,
journal recovery and operational limits.
