import test from 'node:test';
import assert from 'node:assert/strict';
import { chainIdNumber, testnetWalletConnection } from '../site/bsc/wallet-session.js';

const owner = `0x${'11'.repeat(20)}`, other = `0x${'22'.repeat(20)}`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function harness() {
  const listeners = new Map(), hooks = {}, changes = [];
  const provider = {
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
    },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
    emit(event, ...args) { for (const listener of [...listeners.get(event) || []]) listener(...args); },
    async request({ method }) {
      if (hooks[method]) return hooks[method]();
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [owner];
      if (method === 'eth_chainId') return '0x61';
      throw new Error(`Unexpected method ${method}`);
    }
  };
  const wallet = testnetWalletConnection({ onChange: reason => changes.push(reason) });
  return { wallet, provider, hooks, changes, count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0) };
}

test('setup connection validates chain/account and removes all listeners on deliberate disconnect', async () => {
  const h = harness(), context = await h.wallet.connect(h.provider);
  assert.equal(h.wallet.account(), owner);
  assert.equal(await h.wallet.check(context), context); assert.equal(h.count(), 3);
  h.wallet.disconnect();
  assert.equal(h.wallet.account(), undefined); assert.equal(h.count(), 0);
  await assert.rejects(() => h.wallet.check(context), /connection changed/);
});

test('chain id normalization accepts BSC testnet formats returned by wallet bridges', () => {
  assert.equal(chainIdNumber('0x61'), 97);
  assert.equal(chainIdNumber('97'), 97);
  assert.equal(chainIdNumber(97), 97);
  assert.equal(chainIdNumber(97n), 97);
  assert.equal(chainIdNumber('0X61'), 97);
});

test('chain id normalization rejects malformed or unsafe values', () => {
  for (const value of ['', ' 0x61', '0x', 'invalid', '-1', '-0x61', '97.0',
    Number.MAX_SAFE_INTEGER + 1, 2n ** 54n, {}, null, undefined]) {
    assert.equal(chainIdNumber(value), undefined);
  }
});

test('setup events during the initial prompt cannot restore a stale wallet', async () => {
  for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) {
    const h = harness(), gate = deferred();
    h.hooks.eth_requestAccounts = () => gate.promise;
    const attempt = h.wallet.connect(h.provider);
    h.provider.emit(event); gate.resolve([owner]);
    await assert.rejects(attempt, /connection changed/);
    assert.equal(h.wallet.account(), undefined); assert.equal(h.count(), 0);
  }
});

test('setup ignores duplicate current-account and current-chain events', async () => {
  const h = harness(), context = await h.wallet.connect(h.provider);
  h.provider.emit('accountsChanged', [owner]);
  h.provider.emit('chainChanged', '0x61');
  assert.equal(await h.wallet.check(context), context);
  assert.equal(h.wallet.account(), owner);
  assert.equal(h.count(), 3);
});

test('setup events during either asynchronous pre-send check invalidate the captured connection', async () => {
  for (const method of ['eth_chainId', 'eth_accounts']) {
    const h = harness(), context = await h.wallet.connect(h.provider), gate = deferred();
    h.hooks[method] = () => gate.promise;
    const checking = h.wallet.check(context);
    // Allow the chain check to finish when pausing at eth_accounts.
    await Promise.resolve();
    h.provider.emit('disconnect'); gate.resolve(method === 'eth_chainId' ? '0x61' : [owner]);
    await assert.rejects(checking, /connection changed/);
    assert.equal(h.wallet.account(), undefined); assert.equal(h.count(), 0);
  }
});

test('silent setup account/network changes and malformed provider responses invalidate connection', async () => {
  for (const [method, value] of [
    ['eth_accounts', [other]], ['eth_accounts', []], ['eth_accounts', [42]],
    ['eth_chainId', '0x38'], ['eth_chainId', 'invalid'], ['eth_chainId', '98'],
    ['eth_chainId', 98], ['eth_chainId', 2n ** 54n]
  ]) {
    const h = harness(), context = await h.wallet.connect(h.provider);
    h.hooks[method] = () => value;
    await assert.rejects(() => h.wallet.check(context), /changed|reconnect/);
    assert.equal(h.wallet.account(), undefined); assert.equal(h.count(), 0);
  }
});

test('setup accepts decimal and numeric BSC testnet chain ids', async () => {
  for (const value of ['97', 97, 97n]) {
    const h = harness(), context = await h.wallet.connect(h.provider);
    h.hooks.eth_chainId = () => value;
    assert.equal(await h.wallet.check(context), context);
    assert.equal(h.wallet.account(), owner);
  }
});

test('setup requests an OKX switch when the active provider chain is wrong', async () => {
  const h = harness(); let switched = false;
  h.hooks.eth_chainId = () => switched ? '0x61' : '0x38';
  h.hooks.wallet_switchEthereumChain = () => { switched = true; };
  const context = await h.wallet.connect(h.provider);
  assert.equal(await h.wallet.check(context), context);
  assert.equal(switched, true);
  assert.equal(h.wallet.account(), owner);
});

test('an old prompt failure cannot clear a newer setup connection', async () => {
  const h = harness(), gate = deferred();
  h.hooks.eth_requestAccounts = () => gate.promise;
  const old = h.wallet.connect(h.provider);
  delete h.hooks.eth_requestAccounts;
  const fresh = await h.wallet.connect(h.provider);
  gate.resolve([other]); await assert.rejects(old, /connection changed/);
  assert.equal(await h.wallet.check(fresh), fresh); assert.equal(h.wallet.account(), owner);
  assert.equal(h.count(), 3);
});

test('empty or rejected setup account prompts leave no connected account or event listeners', async () => {
  for (const value of [[], null, [1], ['0x1234']]) {
    const h = harness(); h.hooks.eth_requestAccounts = () => value;
    await assert.rejects(() => h.wallet.connect(h.provider), /No usable/);
    assert.equal(h.wallet.account(), undefined); assert.equal(h.count(), 0);
  }
  const h = harness();
  h.hooks.eth_requestAccounts = () => { throw Object.assign(new Error('Rejected'), { code: 4001 }); };
  await assert.rejects(() => h.wallet.connect(h.provider), { code: 4001 });
  assert.equal(h.wallet.account(), undefined); assert.equal(h.count(), 0);
});
