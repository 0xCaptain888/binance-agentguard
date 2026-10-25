import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingWalletNonce, rpcQuantityNumber, testnetWalletConnection } from '../site/bsc/wallet-session.js';

const owner = `0x${'11'.repeat(20)}`;
const accepted = [
  ['hex', '0x7', 7], ['uppercase hex', '0X0A', 10], ['decimal', '7', 7],
  ['number', 7, 7], ['bigint', 7n, 7],
  ['zero hex', '0x0', 0], ['zero decimal', '0', 0], ['zero number', 0, 0], ['zero bigint', 0n, 0],
  ['safe boundary', '0x1fffffffffffff', Number.MAX_SAFE_INTEGER]
];
for (const [label, value, expected] of accepted) {
  test(`pending nonce accepts ${label} and reads the bound account with the pending tag`, async () => {
    const calls = [];
    const provider = { async request(input) { calls.push(input); return value; } };
    assert.equal(await pendingWalletNonce(provider, owner), expected);
    assert.deepEqual(calls, [{ method: 'eth_getTransactionCount', params: [owner, 'pending'] }]);
  });
}

test('missing, malformed and unsafe nonce values never become a usable nonce or a zero fallback', async () => {
  const invalid = [undefined, null, '', ' ', ' 7', '7 ', '0x', '0xgg', '7.0', '7e0', '-1', '+7',
    -1, -1n, 1.5, NaN, Infinity, true, false, [], ['0x7'], { result: '0x7' },
    Number.MAX_SAFE_INTEGER + 1, 2n ** 53n, '9007199254740992', '0x20000000000000', '0'.repeat(81),
    { toString() { throw new Error('Must not coerce objects'); } }];
  for (const value of invalid) {
    let reads = 0;
    assert.equal(rpcQuantityNumber(value), undefined);
    await assert.rejects(() => pendingWalletNonce({ async request() { reads++; return value; } }, owner),
      /valid pending nonce \(received .+\)\. No transaction was requested/);
    assert.equal(reads, 1);
  }
});

test('nonce diagnostics do not expose arbitrary provider data', async () => {
  for (const value of ['sensitive-provider-payload', { secret: 'sensitive-provider-payload' }]) {
    await assert.rejects(() => pendingWalletNonce({ async request() { return value; } }, owner), error => {
      assert.doesNotMatch(error.message, /sensitive-provider-payload/);
      assert.ok(error.message.length < 220);
      return true;
    });
  }
});

test('a failed pending read is propagated once without retries or alternate wallet requests', async () => {
  const expected = Object.assign(new Error('Wallet unavailable'), { code: 4900 });
  let reads = 0;
  await assert.rejects(() => pendingWalletNonce({ async request() { reads++; throw expected; } }, owner),
    error => error === expected);
  assert.equal(reads, 1);
});

test('a nonce returned after disconnect cannot pass the bound pre-send wallet check', async () => {
  let release;
  const listeners = new Map();
  const provider = {
    on(event, listener) { listeners.set(event, listener); },
    removeListener(event) { listeners.delete(event); },
    async request({ method }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [owner];
      if (method === 'eth_chainId') return '0x61';
      if (method === 'eth_getTransactionCount') return new Promise(resolve => { release = resolve; });
      assert.fail(`Unexpected wallet request ${method}`);
    }
  };
  const connection = testnetWalletConnection(), wallet = await connection.connect(provider);
  const reading = pendingWalletNonce(wallet.provider, wallet.account);
  listeners.get('disconnect')(); release(7);
  assert.equal(await reading, 7);
  await assert.rejects(() => connection.check(wallet), /connection changed/);
});
