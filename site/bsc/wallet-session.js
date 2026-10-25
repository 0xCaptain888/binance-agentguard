/* Session credentials stay in memory. An invalidated wallet cannot resume an old login. */
// Provider metadata is self-reported, not proof of extension authenticity.
export function selectOKXProvider(announced, okxwallet, ethereum) {
  const entries = [...announced];
  const isOKX = provider => provider?.isOkxWallet === true || provider?.isOKExWallet === true;
  const matches = [...new Set(entries.filter(entry => entry.info?.rdns === 'com.okex.wallet'
    && typeof entry.provider?.request === 'function').map(entry => entry.provider))];
  if (matches.length > 1) throw new Error('Multiple OKX Wallet providers detected. Enable only the OKX extension you intend to use, then reload.');
  if (matches.length === 1) return matches[0];
  // Legacy fallback only when discovery did not identify this provider as another wallet.
  const candidates = [okxwallet, ...(Array.isArray(ethereum?.providers) ? ethereum.providers : [ethereum])];
  const legacy = [...new Set(candidates.filter(provider => isOKX(provider)
    && typeof provider.request === 'function'
    && !entries.some(entry => entry.provider === provider && entry.info?.rdns !== 'com.okex.wallet')))];
  if (legacy.length > 1) throw new Error('Multiple OKX Wallet providers detected. Enable only the OKX extension you intend to use, then reload.');
  if (legacy.length === 1) return legacy[0];
  throw new Error('OKX Wallet not detected. Enable the OKX Wallet extension for this site and reload. If this browser has no extension, open this same URL in Chrome with OKX Wallet installed.');
}

// EIP-1193 specifies a hex chain-id string, but some wallet bridges expose the
// same value as a number or decimal string. Normalize only safe, non-negative
// integer representations so a formatting difference cannot reject BSC
// testnet while still refusing malformed or ambiguous values.
export function chainIdNumber(value) {
  if (typeof value === 'bigint') return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    if (/^0x[0-9a-f]+$/i.test(value)) {
      const parsed = BigInt(value);
      return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : undefined;
    }
    if (/^[0-9]+$/.test(value)) {
      const parsed = BigInt(value);
      return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : undefined;
    }
  } catch { /* Malformed provider values are rejected below. */ }
  return undefined;
}

// Deployment setup has no server login. Bind its asynchronous checks to one
// connection so a late response cannot revive an invalidated wallet.
export function testnetWalletConnection({ onChange = () => {} } = {}) {
  let current;
  const changed = 'Wallet changed. Reconnect before any wallet request.';
  function clear(context, reason) {
    if (!context || current !== context) return;
    current = undefined;
    for (const [event, listener] of context.listeners) context.provider.removeListener?.(event, listener);
    onChange(reason);
  }
  function capture(context = current) {
    if (!context || current !== context) throw new Error('Wallet connection changed. Reconnect before continuing.');
    return context;
  }
  async function check(context = capture()) {
    capture(context);
    const chain = await context.provider.request({ method: 'eth_chainId' });
    capture(context);
    if (chainIdNumber(chain) !== 97) {
      clear(context, changed);
      throw new Error('Switch to BNB Smart Chain Testnet (97), then reconnect.');
    }
    const accounts = await context.provider.request({ method: 'eth_accounts' });
    capture(context);
    if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== context.account.toLowerCase()) {
      clear(context, changed);
      throw new Error(changed);
    }
    return context;
  }
  return {
    capture, check,
    account: () => current?.account,
    disconnect: () => clear(current),
    async connect(provider) {
      clear(current);
      const context = { provider, listeners: [], account: undefined, pendingEvents: [] };
      current = context;
      try {
        const onEvent = (event, args) => {
          if (event === 'disconnect') {
            clear(context, changed);
            return;
          }
          // OKX can announce the already-active state while its request
          // prompt is resolving. Defer those events until the account is
          // known so identical state is not treated as a change.
          if (!context.account) {
            context.pendingEvents.push([event, args]);
            return;
          }
          if (event === 'accountsChanged') {
            const next = args[0];
            if (!Array.isArray(next) || typeof next[0] !== 'string'
              || next[0].toLowerCase() !== context.account.toLowerCase()) clear(context, changed);
          } else if (event === 'chainChanged' && chainIdNumber(args[0]) !== 97) {
            clear(context, changed);
          }
        };
        for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) {
          const listener = (...args) => onEvent(event, args);
          context.listeners.push([event, listener]); provider.on?.(event, listener);
        }
        const accounts = await provider.request({ method: 'eth_requestAccounts' });
        capture(context);
        if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || !/^0x[0-9a-f]{40}$/i.test(accounts[0]))
          throw new Error('No usable wallet account returned.');
        context.account = accounts[0];
        for (const [event, args] of context.pendingEvents.splice(0)) onEvent(event, args);
        capture(context);
        await check(context);
        onChange();
        return context;
      } catch (error) { clear(context); throw error; }
    }
  };
}

export function walletSession({ request, onChange = () => {}, clock = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let current, timer;
  const changed = 'Wallet changed. Reconnect and preview a fresh plan.';
  function revoke(token) {
    if (token) void Promise.resolve().then(() => request('/auth/logout', {}, token)).catch(() => {});
  }
  function clear(context, reason) {
    if (!context || current !== context) return;
    current = undefined;
    clearTimer(timer); timer = undefined;
    for (const [event, listener] of context.listeners) context.provider.removeListener?.(event, listener);
    revoke(context.token);
    onChange(reason);
  }
  function assert(context, authenticated = true) {
    if (!context || current !== context) throw new Error('Wallet session changed. Reconnect before continuing.');
    if (authenticated && (!context.token || context.expires <= clock())) {
      clear(context, 'Wallet session expired. Reconnect to continue.');
      throw new Error('Wallet session expired. Reconnect to continue.');
    }
    return context;
  }
  function token() {
    if (current?.token && current.expires <= clock()) clear(current, 'Wallet session expired. Reconnect to continue.');
    return current?.token;
  }
  function capture() {
    token();
    return assert(current);
  }
  async function check(context, authenticated = true) {
    assert(context, authenticated);
    const chain = await context.provider.request({ method: 'eth_chainId' });
    assert(context, authenticated);
    if (chainIdNumber(chain) !== 97) {
      clear(context, 'Switch your wallet to BNB Smart Chain Testnet (97), then reconnect.');
      throw new Error('Switch your wallet to BNB Smart Chain Testnet (97), then reconnect.');
    }
    const accounts = await context.provider.request({ method: 'eth_accounts' });
    assert(context, authenticated);
    if (accounts[0]?.toLowerCase() !== context.account.toLowerCase()) {
      clear(context, changed);
      throw new Error(changed);
    }
    return context;
  }
  async function connect(provider) {
    clear(current);
    const context = { provider, listeners: [], account: undefined, token: undefined, expires: 0, pendingEvents: [] };
    current = context;
    try {
      const onEvent = (event, args) => {
        if (event === 'disconnect') {
          clear(context, changed);
          return;
        }
        if (!context.account) {
          context.pendingEvents.push([event, args]);
          return;
        }
        if (event === 'accountsChanged') {
          const next = args[0];
          if (!Array.isArray(next) || typeof next[0] !== 'string'
            || next[0].toLowerCase() !== context.account.toLowerCase()) clear(context, changed);
        } else if (event === 'chainChanged' && chainIdNumber(args[0]) !== 97) {
          clear(context, changed);
        }
      };
      for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) {
        const listener = (...args) => onEvent(event, args);
        context.listeners.push([event, listener]); provider.on?.(event, listener);
      }
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      assert(context, false);
      if (!/^0x[0-9a-f]{40}$/i.test(accounts[0])) throw new Error('No usable wallet account returned.');
      context.account = accounts[0];
      for (const [event, args] of context.pendingEvents.splice(0)) onEvent(event, args);
      assert(context, false);
      await check(context, false);
      const challenge = await request('/auth/challenge', { address: context.account }, null);
      assert(context, false);
      const hex = `0x${[...new TextEncoder().encode(challenge.message)].map(b => b.toString(16).padStart(2, '0')).join('')}`;
      const signature = await provider.request({ method: 'personal_sign', params: [hex, context.account] });
      await check(context, false);
      const result = await request('/auth/session', { nonce: challenge.nonce, signature }, null);
      // An exchange can complete after a wallet event. Revoke its orphan token.
      if (current !== context) { revoke(result.token); assert(context, false); }
      context.token = result.token; context.expires = result.expires;
      if (typeof context.token !== 'string' || !context.token || !Number.isSafeInteger(context.expires) || context.expires <= clock())
        throw new Error('Invalid or expired wallet session. Reconnect to continue.');
      await check(context);
      timer = setTimer(() => clear(context, 'Wallet session expired. Reconnect to continue.'), context.expires - clock());
      onChange();
      return context;
    } catch (error) { clear(context); throw error; }
  }
  return {
    connect, token, capture, check,
    account: () => token() ? current.account : undefined,
    disconnect: () => clear(current),
    assertToken(value) { if (!value || token() !== value) throw new Error('Wallet session changed. Reconnect before continuing.'); },
    unauthorized(value) { if (value && current?.token === value) clear(current, 'Wallet session expired or revoked. Reconnect to continue.'); },
    async send(transaction, context = capture()) {
      await check(context);
      if (transaction.from?.toLowerCase() !== context.account.toLowerCase()) throw new Error('Use the wallet that owns this action.');
      assert(context);
      // Once submitted, preserve the returned hash even if the user switches wallets
      // while the wallet dialog is open. The submission guard owns recovery.
      return context.provider.request({ method: 'eth_sendTransaction', params: [{ ...transaction, from: context.account }] });
    }
  };
}
