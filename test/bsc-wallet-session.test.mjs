import test from 'node:test';
import assert from 'node:assert/strict';
import { chainIdNumber, walletSession } from '../site/bsc/wallet-session.js';
import { submissionGuard } from '../site/bsc/submission.js';

const account = `0x${'22'.repeat(20)}`, other = `0x${'33'.repeat(20)}`, hash = `0x${'44'.repeat(32)}`;
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function harness() {
  let now = 1000, count = 0, sends = 0;
  const listeners = new Map(), timers = new Map(), changes = [], revoked = [], calls = [];
  const hooks = {};
  const provider = {
    on(event, listener) { const set = listeners.get(event) || new Set(); set.add(listener); listeners.set(event, set); },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
    emit(event, ...args) { for (const listener of [...listeners.get(event) || []]) listener(...args); },
    async request({ method }) {
      calls.push(method);
      if (hooks[method]) return hooks[method]();
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
      if (method === 'eth_chainId') return '0x61';
      if (method === 'personal_sign') return '0xabcd';
      if (method === 'eth_sendTransaction') { sends++; return hash; }
      throw new Error(`Unexpected method ${method}`);
    }
  };
  const wallet = walletSession({ clock: () => now, setTimer: (fn, delay) => { const id = ++count; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimer: id => timers.delete(id), onChange: reason => changes.push(reason),
    request: async (path, _data, token) => {
      if (path === '/auth/logout') { revoked.push(token); return hooks.logout?.(); }
      if (path === '/auth/challenge') return { nonce: 'nonce', message: 'Test fixture' };
      if (path === '/auth/session') return hooks.exchange ? hooks.exchange() : { token: `session-${++count}`, expires: now + 900000 };
      throw new Error(`Unexpected path ${path}`);
    }
  });
  return { wallet, provider, hooks, changes, revoked, calls, timers,
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    advance(ms, fire = true) { now += ms; if (fire) for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } },
    sends: () => sends };
}
const tx = { from: account, to: other, data: '0x1234', value: '0x0' };

test('login validates wallet before and after signing, exposes only an active session and detaches on disconnect', async () => {
  const h = harness();
  assert.equal(h.wallet.token(), undefined);
  assert.throws(() => h.wallet.capture(), /Reconnect/);
  const context = await h.wallet.connect(h.provider);
  assert.equal(h.wallet.account(), account);
  assert.equal(h.wallet.token(), context.token);
  assert.equal(h.listenerCount(), 3);
  assert.equal(h.calls.filter(x => x === 'eth_accounts').length, 3);
  assert.equal(h.calls.filter(x => x === 'personal_sign').length, 1);
  h.wallet.disconnect();
  assert.equal(h.wallet.token(), undefined); assert.equal(h.listenerCount(), 0); assert.equal(h.timers.size, 0);
  await Promise.resolve(); assert.deepEqual(h.revoked, [context.token]);
});

test('account, network and disconnect events invalidate a login while the signature dialog is open', async () => {
  for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) {
    const h = harness(), gate = deferred(), entered = deferred(); let exchanges = 0;
    h.hooks.personal_sign = () => { entered.resolve(); return gate.promise; };
    h.hooks.exchange = () => { exchanges++; };
    const pending = h.wallet.connect(h.provider); await entered.promise;
    h.provider.emit(event); gate.resolve('0xabcd');
    await assert.rejects(pending, /session changed/);
    assert.equal(exchanges, 0); assert.equal(h.wallet.token(), undefined); assert.equal(h.listenerCount(), 0);
  }
});

test('events during the initial account prompt also cancel the attempt', async () => {
  const h = harness(), gate = deferred();
  h.hooks.eth_requestAccounts = () => gate.promise;
  const pending = h.wallet.connect(h.provider);
  h.provider.emit('accountsChanged'); gate.resolve([account]);
  await assert.rejects(pending, /session changed/);
  assert.equal(h.calls.includes('personal_sign'), false); assert.equal(h.listenerCount(), 0);
});

test('wallet sessions ignore duplicate current-account and current-chain events', async () => {
  const h = harness(), context = await h.wallet.connect(h.provider);
  h.provider.emit('accountsChanged', [account]);
  h.provider.emit('chainChanged', '0x61');
  assert.equal(await h.wallet.check(context), context);
  assert.equal(h.wallet.account(), account);
  assert.equal(h.listenerCount(), 3);
});

test('silent account and chain changes are rejected without relying on provider events', async () => {
  for (const [method, response] of [['eth_accounts', [other]], ['eth_chainId', '0x38'], ['eth_chainId', 98], ['eth_chainId', '98']]) {
    const h = harness();
    h.hooks.personal_sign = () => { h.hooks[method] = () => response; return '0xabcd'; };
    await assert.rejects(() => h.wallet.connect(h.provider), /Reconnect|reconnect/);
    assert.equal(h.wallet.token(), undefined); assert.equal(h.listenerCount(), 0);
  }
});

test('wallet sessions accept decimal and numeric BSC testnet chain ids', async () => {
  for (const value of ['97', 97, 97n]) {
    const h = harness();
    h.hooks.eth_chainId = () => value;
    const context = await h.wallet.connect(h.provider);
    assert.equal(await h.wallet.check(context), context);
    assert.equal(h.wallet.account(), account);
  }
});

test('wallet sessions request an OKX switch before signing when the active chain is wrong', async () => {
  const h = harness(); let switched = false;
  h.hooks.eth_chainId = () => switched ? '0x61' : '0x38';
  h.hooks.wallet_switchEthereumChain = () => { switched = true; };
  const context = await h.wallet.connect(h.provider);
  assert.equal(await h.wallet.check(context), context);
  assert.equal(switched, true);
  assert.equal(h.wallet.account(), account);
});

test('session returned after wallet invalidation is revoked and cannot resurrect the old account', async () => {
  const h = harness(), gate = deferred(), entered = deferred();
  h.hooks.exchange = () => { entered.resolve(); return gate.promise; };
  const pending = h.wallet.connect(h.provider); await entered.promise;
  h.provider.emit('chainChanged'); gate.resolve({ token: 'orphan', expires: 901000 });
  await assert.rejects(pending, /session changed/);
  await Promise.resolve();
  assert.deepEqual(h.revoked, ['orphan']); assert.equal(h.wallet.token(), undefined);
});

test('late failure and logout from an old login do not disconnect a newer session', async () => {
  const h = harness(), gate = deferred(), entered = deferred();
  h.hooks.personal_sign = () => { entered.resolve(); return gate.promise; };
  const old = h.wallet.connect(h.provider); await entered.promise;
  delete h.hooks.personal_sign;
  const fresh = await h.wallet.connect(h.provider);
  gate.resolve('0xabcd'); await assert.rejects(old, /session changed/);
  h.wallet.unauthorized('old-token');
  h.wallet.assertToken(fresh.token); assert.equal(h.listenerCount(), 3);
  const logout = deferred(); h.hooks.logout = () => logout.promise;
  h.wallet.disconnect();
  const next = await h.wallet.connect(h.provider);
  logout.resolve(); await Promise.resolve();
  h.wallet.assertToken(next.token); assert.equal(h.listenerCount(), 3);
});

test('expiry clears the UI session immediately; delayed background timers still cannot authorize a send', async () => {
  for (const fire of [true, false]) {
    const h = harness(); await h.wallet.connect(h.provider);
    h.advance(900000, fire);
    assert.equal(h.wallet.token(), undefined); assert.equal(h.wallet.account(), undefined);
    await assert.rejects(() => h.wallet.send(tx), /Reconnect/);
    assert.equal(h.sends(), 0); assert.equal(h.listenerCount(), 0);
    assert.match(h.changes.at(-1), /expired/);
  }
});

test('401 invalidates only the session used by that request; stale successful responses are rejected', async () => {
  const h = harness(), old = await h.wallet.connect(h.provider);
  h.wallet.disconnect(); const fresh = await h.wallet.connect(h.provider);
  h.wallet.unauthorized(old.token); h.wallet.assertToken(fresh.token);
  assert.throws(() => h.wallet.assertToken(old.token), /session changed/);
  h.wallet.unauthorized(fresh.token);
  assert.equal(h.wallet.token(), undefined); assert.equal(h.listenerCount(), 0);
  assert.match(h.changes.at(-1), /revoked/);
});

test('wallet or expiry changes during final pre-send RPC checks prevent any transaction request', async () => {
  for (const effect of ['event', 'expiry', 'silentAccount']) {
    const h = harness(), context = await h.wallet.connect(h.provider);
    if (effect === 'silentAccount') h.hooks.eth_accounts = () => [other];
    else h.hooks.eth_chainId = () => { if (effect === 'event') h.provider.emit('accountsChanged'); else h.advance(900000, false); return '0x61'; };
    await assert.rejects(() => h.wallet.send(tx, context), /changed|expired/);
    assert.equal(h.sends(), 0); assert.equal(h.wallet.token(), undefined);
  }
});

test('switching accounts while transaction dialog is open preserves the returned hash and blocks duplicate sends', async () => {
  const h = harness(), context = await h.wallet.connect(h.provider), gate = deferred(), entered = deferred(), values = new Map();
  const guard = submissionGuard({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    97, other, async (_key, action) => action());
  const job = { id: 'test-job', plan: { id: hash, vault: other, chainId: 97, nonce: '0', deadline: '1000' } };
  h.hooks.eth_sendTransaction = () => { entered.resolve(); return gate.promise; };
  const pending = guard.submit(job, account, () => h.wallet.send(tx, context)); await entered.promise;
  h.provider.emit('accountsChanged'); gate.resolve(hash);
  assert.equal(await pending, hash); assert.equal(guard.read().hash, hash);
  assert.throws(() => h.wallet.assertToken(context.token), /session changed/);
  await assert.rejects(() => guard.submit(job, account, async () => { throw new Error('Must not send'); }), /unresolved/);
});

test('rejected signatures and malformed/expired sessions leave no actionable session or listeners', async () => {
  for (const response of [{ token: 'expired', expires: 1000 }, { token: 'missing-expiry' }, { expires: 901000 }]) {
    const h = harness(); h.hooks.exchange = () => response;
    await assert.rejects(() => h.wallet.connect(h.provider), /Invalid or expired/);
    assert.equal(h.wallet.token(), undefined); assert.equal(h.listenerCount(), 0);
  }
  const h = harness(); h.hooks.personal_sign = () => { throw Object.assign(new Error('Rejected'), { code: 4001 }); };
  await assert.rejects(() => h.wallet.connect(h.provider), { code: 4001 });
  assert.equal(h.wallet.token(), undefined); assert.equal(h.listenerCount(), 0);
});
