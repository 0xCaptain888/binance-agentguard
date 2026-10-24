/* Session credentials stay in memory. An invalidated wallet cannot resume an old login. */
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
    if (Number(BigInt(chain)) !== 97) {
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
    const context = { provider, listeners: [], account: undefined, token: undefined, expires: 0 };
    current = context;
    try {
      for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) {
        const listener = () => clear(context, changed);
        context.listeners.push([event, listener]); provider.on?.(event, listener);
      }
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      assert(context, false);
      if (!/^0x[0-9a-f]{40}$/i.test(accounts[0])) throw new Error('No usable wallet account returned.');
      context.account = accounts[0];
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
