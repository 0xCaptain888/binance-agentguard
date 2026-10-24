import test from 'node:test';
import assert from 'node:assert/strict';
import { submissionGuard } from '../site/bsc/submission.js';

const vault = `0x${'11'.repeat(20)}`, account = `0x${'22'.repeat(20)}`;
const hash = `0x${'33'.repeat(32)}`, otherHash = `0x${'44'.repeat(32)}`;
const job = { id: 'journal-job', state: 'AWAITING_SIGNATURE', plan: { id: `0x${'55'.repeat(32)}`, vault, chainId: 97, nonce: '0', deadline: '1000' } };
function harness() {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  let held = false;
  const lock = async (_key, action) => {
    if (held) throw new Error('Another tab holds the lock');
    held = true; try { return await action(); } finally { held = false; }
  };
  const create = () => submissionGuard(storage, 97, vault, lock);
  return { values, storage, lock, create, guard: create() };
}
function verified() {
  return { ...job, state: 'VERIFIED', receipt: { state: 'VERIFIED', chainId: 97, planId: job.plan.id,
    transactionHash: hash, checks: { calldataBound: true, canonicalBlock: true } } };
}

test('ambiguous wallet failure preserves the pre-send marker across reload and blocks a second send', async () => {
  const h = harness(); let sends = 0;
  await assert.rejects(() => h.guard.submit(job, account, async () => {
    sends++; assert.equal(h.create().read().jobId, job.id); throw new Error('Wallet transport disconnected');
  }), /transport disconnected/);
  const reloaded = h.create();
  assert.equal(reloaded.read().hash, undefined);
  await assert.rejects(() => reloaded.submit(job, account, async () => { sends++; return hash; }), /unresolved/);
  assert.equal(sends, 1);
  assert.deepEqual(Object.keys(reloaded.read()).sort(), ['version', 'chainId', 'vault', 'account', 'jobId', 'planId', 'nonce', 'deadline', 'startedAt'].sort());
});
test('only explicit rejection clears a wallet attempt and allows a deliberate second request', async () => {
  const { guard } = harness();
  await assert.rejects(() => guard.submit(job, account, async () => { throw Object.assign(new Error('Rejected'), { code: 4001 }); }), /Rejected/);
  assert.equal(guard.read(), undefined);
  assert.equal(await guard.submit(job, account, async () => hash), hash);
  assert.equal(guard.read().hash, hash);
});
test('unavailable storage or cross-tab locking blocks before any wallet call', async () => {
  const h = harness(); let sends = 0;
  const fail = () => { throw new Error('Storage disabled'); };
  const unavailable = submissionGuard({ ...h.storage, getItem: fail }, 97, vault, h.lock);
  const unwritable = submissionGuard({ ...h.storage, setItem: fail }, 97, vault, h.lock);
  const unlocked = submissionGuard(h.storage, 97, vault, undefined);
  for (const guard of [unavailable, unwritable, unlocked]) await assert.rejects(() => guard.submit(job, account, async () => { sends++; return hash; }));
  for (const invalid of [{ ...job, id: '' }, { ...job, plan: { ...job.plan, vault: 7 } }])
    await assert.rejects(() => h.guard.submit(invalid, account, async () => { sends++; return hash; }), /Invalid submitted plan/);
  assert.equal(sends, 0);
});
test('saved and manually recovered hashes bind to the original plan and never silently switch transactions', async () => {
  const h = harness();
  await assert.rejects(() => h.guard.submit(job, account, async () => undefined), /no usable hash/);
  const reloaded = h.create(); reloaded.rememberHash(job, hash);
  assert.equal(h.create().read().hash, hash);
  assert.throws(() => reloaded.rememberHash(job, otherHash), /original submitted plan/);
  assert.throws(() => reloaded.rememberHash({ ...job, id: 'another-job' }, hash), /original submitted plan/);
  assert.throws(() => reloaded.rememberHash(job, 'not-a-hash'), /original submitted plan/);
});
test('only a verified matching receipt clears the marker; pending, frozen or mismatched proofs retain it', async () => {
  const { guard } = harness(); await guard.submit(job, account, async () => hash);
  const good = verified();
  for (const value of [{ ...good, state: 'VERIFYING' }, { ...good, state: 'FROZEN' },
    { ...good, id: 'another-job' }, { ...good, receipt: { ...good.receipt, transactionHash: otherHash } },
    { ...good, receipt: { ...good.receipt, chainId: 31337 } }, { ...good, receipt: { ...good.receipt, checks: {} } },
    { ...good, receipt: { ...good.receipt, checks: { canonicalBlock: false } } }]) {
    guard.acceptProof(value); assert.ok(guard.read());
  }
  guard.acceptProof(good); assert.equal(guard.read(), undefined);
});
test('release requires a matching chain scope and a consumed nonce or strictly elapsed on-chain deadline', async () => {
  const h = harness(); const snapshot = { chainId: 97, vault, nonce: '0', blockTimestamp: '1000' };
  await h.guard.submit(job, account, async () => hash);
  await assert.rejects(() => h.guard.releaseExpired(snapshot), /can still execute/);
  await assert.rejects(() => h.guard.releaseExpired({ ...snapshot, chainId: 56, blockTimestamp: '1001' }), /can still execute/);
  await assert.rejects(() => h.guard.releaseExpired({ ...snapshot, vault: account, nonce: '1' }), /can still execute/);
  assert.equal((await h.guard.releaseExpired({ ...snapshot, blockTimestamp: '1001' })).state, 'RELEASED_NOT_VERIFIED');
  assert.equal(h.guard.read(), undefined);
  await h.guard.submit(job, account, async () => hash);
  assert.equal((await h.guard.releaseExpired({ ...snapshot, nonce: '1' })).campaignProof, false);
});
test('two tabs sharing a vault cannot open simultaneous wallet requests', async () => {
  const h = harness(); let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const first = h.guard.submit(job, account, () => response);
  let duplicate = 0;
  await assert.rejects(() => h.create().submit(job, account, async () => { duplicate++; return hash; }), /holds the lock/);
  await assert.rejects(() => h.create().releaseExpired({ chainId: 97, vault, nonce: '1', blockTimestamp: '1001' }), /holds the lock/);
  finish(hash); await first;
  await assert.rejects(() => h.create().submit(job, account, async () => { duplicate++; return hash; }), /unresolved/);
  assert.equal(duplicate, 0);
});
test('corrupt metadata fails closed while separate vaults keep isolated recovery records', async () => {
  const h = harness();
  for (const raw of ['{', 'null', '[]', JSON.stringify({ version: 1, chainId: 97, vault: 7 })]) {
    h.storage.setItem(h.guard.key, raw);
    await assert.rejects(() => h.guard.submit(job, account, async () => { throw new Error('Wallet must not be called'); }), /Stored submission/);
  }
  h.storage.removeItem(h.guard.key);
  await h.guard.submit(job, account, async () => hash);
  assert.equal(submissionGuard(h.storage, 97, account, h.lock).read(), undefined);
});
