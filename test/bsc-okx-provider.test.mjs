import test from 'node:test';
import assert from 'node:assert/strict';
import { selectOKXProvider } from '../site/bsc/wallet-session.js';

const provider = flags => ({ request() {}, ...flags });
const announce = (rdns, provider) => ({ info: { rdns }, provider });

test('OKX discovery wins over a MetaMask default regardless of announcement order', () => {
  const okx = provider({ isMetaMask: true, isOkxWallet: true }), metamask = provider({ isMetaMask: true });
  const entries = [announce('com.okex.wallet', okx), announce('io.metamask', metamask)];
  for (const announcements of [entries, [...entries].reverse(), [...entries, entries[1]]]) {
    assert.equal(selectOKXProvider(announcements, undefined, metamask), okx);
  }
});

test('missing OKX never falls back to MetaMask or an unidentified EVM provider', () => {
  for (const wallet of [provider({ isMetaMask: true }), provider({}), undefined]) {
    assert.throws(() => selectOKXProvider([], undefined, wallet), /OKX Wallet not detected/);
  }
  const other = provider({ isOkxWallet: true });
  assert.throws(() => selectOKXProvider([announce('other.wallet', other)], other, other), /OKX Wallet not detected/);
});

test('OKX namespace and legacy providers work when another extension is the default', () => {
  const metamask = provider({ isMetaMask: true }), okx = provider({ isOkxWallet: true, isMetaMask: true });
  assert.equal(selectOKXProvider([], okx, metamask), okx);
  assert.equal(selectOKXProvider([], undefined, { ...metamask, providers: [metamask, okx] }), okx);
  assert.equal(selectOKXProvider([], okx, okx), okx);
  const oldOKX = provider({ isOKExWallet: true });
  assert.equal(selectOKXProvider([], oldOKX), oldOKX);
});

test('ambiguous OKX discovery cannot choose a provider silently', () => {
  const first = provider({ isOkxWallet: true }), second = provider({ isOkxWallet: true });
  assert.throws(() => selectOKXProvider([announce('com.okex.wallet', first), announce('com.okex.wallet', second)], first), /Multiple OKX/);
  assert.throws(() => selectOKXProvider([], first, { providers: [first, second] }), /Multiple OKX/);
});
