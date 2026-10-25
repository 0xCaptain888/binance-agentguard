# Wallet chain ID compatibility fix

The BSC setup, deployment and authenticated wallet-session guards now normalize
safe chain ID responses from EIP-1193 providers. They accept the canonical
hexadecimal `0x61` value and the equivalent numeric or decimal-string `97`
forms that can be returned by wallet bridges, while rejecting other networks,
malformed values and integers outside the safe range.

The account check and provider event invalidation remain unchanged. The server
and unsigned transaction checks still require BSC Testnet chain 97 and
transactions continue to use `0x61` on the wire.

Validation:

- `npm run typecheck`
- focused setup/session wallet tests: 21 passing
- `npm run bsc:check` syntax and full-suite execution attempted; network-listening
  tests are blocked in the macOS sandbox with `listen EPERM`, while the wallet
  regression tests pass.
