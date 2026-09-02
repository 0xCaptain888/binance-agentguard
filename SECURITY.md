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
