# OKX connection state-event compatibility

The BSC setup and authenticated wallet-session guards now tolerate OKX
announcing the current account or BSC Testnet chain while an `eth_requestAccounts`
prompt is resolving or a signing flow is active. Events are compared with the
bound connection and ignored when they carry the same account or chain.

A real account switch, a chain other than BSC Testnet (97), an unrecognized
event payload, or an explicit disconnect still invalidates the connection and
requires a fresh reconnect. Silent RPC checks remain in place, so a provider
that changes state without emitting an event is still rejected.

Validation:

- `npm run typecheck`
- focused setup/session wallet tests: 23 passing
- `npm run verify:site` (`valid: true`)
