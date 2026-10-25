/* No private keys, auto-signing, external scripts or credentials in this console. */
import { submissionGuard } from './submission.js';
import { walletSession, selectOKXProvider } from './wallet-session.js';
const $ = id => document.getElementById(id);
let state, selectedJob, busy = false, noticeTimer;
let guard, guardScope, submission, submissionError;
const wallet = walletSession({ request: api, onChange: reason => {
  if (!wallet.token()) {
    selectedJob = undefined; $('transaction-hash').value = '';
    if (state) decision('AWAITING PLAN', 'Connect to continue.', 'Wallet sessions are not persisted in this browser. Saved transaction recovery records are retained.');
  }
  if (state) render();
  if (reason) notify(reason, true);
} });
const wallets = new Map();
window.addEventListener('eip6963:announceProvider', event => {
  if (event.detail?.provider && typeof event.detail.info?.name === 'string') wallets.set(event.detail.info.uuid, event.detail);
});
window.dispatchEvent(new Event('eip6963:requestProvider'));
const text = (id, value) => { $(id).textContent = value; };
const short = value => value ? `${value.slice(0, 8)}…${value.slice(-6)}` : '—';
const usd = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(value) / 1e18);
const percentage = value => `${(Number(value) / 100).toFixed(1)}%`;
function units(value, decimals) {
  const s = String(value).padStart(decimals + 1, '0');
  return decimals ? `${s.slice(0, -decimals)}.${s.slice(-decimals).slice(0, 6)}`.replace(/\.?0+$/, '') : s;
}
function node(tag, className, content) {
  const el = document.createElement(tag); if (className) el.className = className;
  if (content !== undefined) el.textContent = content; return el;
}
function notify(message, error = false) {
  clearTimeout(noticeTimer); text('notice', message); $('notice').className = error ? 'error' : '';
  $('notice').hidden = false; noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 5000);
}
async function api(path, data, credential = wallet.token()) {
  const response = await fetch(`/api/v1${path}`, data === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body: JSON.stringify(data)
  });
  if (response.status === 401) wallet.unauthorized(credential);
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Service unavailable. Start npm run bsc:serve and open the local console.');
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Operation failed');
  if (credential && path !== '/auth/logout') wallet.assertToken(credential);
  return result;
}
async function refresh() {
  state = await api('/status');
  const scope = `${state.snapshot.chainId}:${state.snapshot.vault.toLowerCase()}`;
  if (state.mode !== 'local' && scope !== guardScope) {
    // Web Locks prevent two tabs from both opening a wallet request before either
    // has stored its marker. Missing storage or locking disables submission.
    guard = submissionGuard({ getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: key => localStorage.removeItem(key) },
      state.snapshot.chainId, state.snapshot.vault, navigator.locks ? (key, action) => navigator.locks.request(key, { mode: 'exclusive', ifAvailable: true }, lock => {
        if (!lock) throw new Error('A wallet request is already open in another tab. Check that tab before retrying.');
        return action();
      }) : undefined);
    guardScope = scope;
  } else if (state.mode === 'local') { guard = undefined; guardScope = undefined; }
  render();
}
function render() {
  if (!state) return;
  const s = state.snapshot, p = state.portfolio, local = state.mode === 'local', frozen = state.journal.frozen;
  const priced = state.pricing.available;
  const session = wallet.token(), account = wallet.account();
  submission = undefined; submissionError = undefined;
  try {
    if (guard) {
      const marker = guard.read(), completed = marker && state.journal.jobs.find(job => job.id === marker.jobId);
      if (completed) guard.acceptProof(completed);
      submission = guard.read();
    }
  } catch (error) { submissionError = error.message; }
  text('network', local ? 'LOCAL EVM · MOCK ASSETS' : 'BSC TESTNET · CHAIN 97');
  text('connect', local ? 'Local lab · No wallet needed' : account ? `OKX · ${short(account)} · Disconnect` : 'Connect OKX Wallet');
  $('connect').disabled = local || busy;
  text('mode-note', state.note);
  text('runner-state', frozen ? 'Runner frozen' : s.paused ? 'Vault paused' : !priced ? 'Price source unavailable' : 'Ready to plan');
  text('runner-detail', !priced ? 'Rebalancing is blocked. Balances and owner pause/withdraw controls remain available.' : frozen ? 'Proof mismatch. Review the journal. Owner controls remain available.' : s.paused ? 'Owner withdrawals remain available.' : 'Contract policy is active. No trade runs without approval.');
  text('value', priced ? usd(p.totalUsd) : 'Unavailable'); text('drift', priced ? percentage(p.driftBps) : '—');
  text('budget', usd(BigInt(s.maxDailyUsd) > BigInt(s.spentTodayUsd) ? BigInt(s.maxDailyUsd) - BigInt(s.spentTodayUsd) : 0n));
  text('budget-cap', `${usd(s.spentTodayUsd)} used of ${usd(s.maxDailyUsd)} today (UTC)`);
  text('asset0', `${s.symbol0} · ${units(s.balance0, s.decimals0)}`); text('asset1', `${s.symbol1} · ${units(s.balance1, s.decimals1)}`);
  text('share0', priced ? percentage(p.shareBps) : '—'); text('share1', priced ? percentage(10000 - Number(p.shareBps)) : '—');
  $('allocation-bar').hidden = !priced;
  $('allocation-bar').value = priced ? Number(p.shareBps) / 100 : 0;
  text('target', `${s.targetBps / 100}% ${s.symbol0} / ${100 - s.targetBps / 100}% ${s.symbol1}`);
  text('snapshot', `Block ${s.blockNumber}`); text('action-cap', usd(s.maxActionUsd)); text('slippage', `${s.slippageBps / 100}%`);
  text('cooldown', `${s.cooldownSeconds}s`); text('oracle-age', `${s.maxOracleAge}s`); text('nonce', s.nonce);
  text('vault', s.vault); $('vault').title = s.vault;
  $('fund-asset').options[0].textContent = s.symbol0; $('fund-asset').options[1].textContent = s.symbol1;
  $('funding').hidden = local; $('local-tools').hidden = !local;
  $('recover').hidden = local || !frozen;
  $('recover').disabled = busy || !s.paused || !session || account?.toLowerCase() !== s.owner.toLowerCase();
  $('plan').disabled = busy || frozen || !priced || !!submission || !!submissionError || (!local && !session);
  $('pause').disabled = busy || (!local && (!session || account?.toLowerCase() !== s.owner.toLowerCase()));
  text('pause', s.paused ? 'Resume vault' : 'Pause vault');
  for (const id of ['judge-run', 'oracle-outage', 'reset', 'refresh']) $(id).disabled = busy;
  for (const button of document.querySelectorAll('.funding-action')) button.disabled = busy || (!local && (!session || account?.toLowerCase() !== s.owner.toLowerCase()));
  text('local-ready', local ? 'LOCAL ONLY' : 'TESTNET');
  $('export').disabled = !state.journal.jobs.length;
  if (selectedJob) selectedJob = state.journal.jobs.find(j => j.id === selectedJob.id);
  renderPlan(); renderJournal(); renderSubmission();
}
function renderSubmission() {
  $('submission-recovery').hidden = !submission && !submissionError;
  if (submissionError) {
    text('submission-detail', submissionError);
    $('resume-submission').disabled = true; $('release-submission').hidden = true; return;
  }
  if (!submission) return;
  const job = state.journal.jobs.find(value => value.id === submission.jobId);
  text('submission-detail', submission.hash ? `Transaction ${submission.hash}. Reconnect your wallet and verify this hash. A saved hash is not a verified result.` :
    'The wallet request started, but no transaction hash was saved. Check wallet activity, then paste the hash for this plan. Sending again is blocked.');
  $('resume-submission').disabled = busy || !job;
  const expired = BigInt(state.snapshot.nonce) > BigInt(submission.nonce) || BigInt(state.snapshot.blockTimestamp) > BigInt(submission.deadline);
  $('release-submission').hidden = !expired;
  $('release-submission').disabled = busy;
  if (!job) $('submission-detail').append(document.createTextNode(' The original plan is absent from this journal; restore the matching journal before verifying.'));
}
function decision(badge, title, description, kind = 'neutral') {
  const root = $('decision'); root.replaceChildren(node('span', `badge ${kind}`, badge), node('h3', '', title), node('p', '', description));
}
function renderPlan() {
  const job = selectedJob, local = state.mode === 'local';
  const retryLocal = local && job?.state === 'VERIFYING' && !!job.transactionHash;
  $('plan-details').hidden = !job; $('execute').hidden = !job || (job.state !== 'AWAITING_SIGNATURE' && !retryLocal);
  $('verify-controls').hidden = local || !job || !!job.receipt;
  $('execute').disabled = busy || state.journal.frozen || (!retryLocal && !state.pricing.available) || !!submission || !!submissionError || (!local && !wallet.token());
  $('verify').disabled = busy || (!local && !wallet.token());
  text('execute', retryLocal ? 'Retry verification · no new trade' : local ? 'Execute local trade' : 'Review & sign in wallet');
  if (!job) return;
  const p = job.plan, s = state.snapshot;
  const inDecimals = p.sellToken0 ? s.decimals0 : s.decimals1, outDecimals = p.sellToken0 ? s.decimals1 : s.decimals0;
  const symbolIn = p.sellToken0 ? s.symbol0 : s.symbol1, symbolOut = p.sellToken0 ? s.symbol1 : s.symbol0;
  decision(job.state, job.state === 'VERIFIED' ? 'Execution independently verified.' : job.state === 'FROZEN' ? 'Proof mismatch. Runner frozen.' :
    job.state === 'VERIFYING' ? 'Transaction sent. Awaiting proof.' : `Move ${usd(p.notionalUsd)} toward balance.`,
    job.receipt ? `${job.receipt.reasons.length ? job.receipt.reasons.join(', ') : 'All receipt checks passed.'} ${local ? 'Local test only.' : 'BSC testnet.'}` : 'Exact amounts and calldata are shown below. The vault enforces the final limits.',
    job.state === 'VERIFIED' ? 'good' : job.state === 'FROZEN' ? 'bad' : 'neutral');
  const facts = [['Sell', `${units(p.amountIn, inDecimals)} ${symbolIn}`], ['Minimum received', `${units(p.minAmountOut, outDecimals)} ${symbolOut}`],
    ['Drift', `${percentage(p.driftBeforeBps)} → ≤${percentage(p.expectedDriftAfterBps)}`], ['Plan expires', new Date(Number(p.deadline) * 1000).toLocaleTimeString()],
    ['Nonce', String(p.nonce)], ['Plan ID', short(p.id)]];
  $('plan-facts').replaceChildren(...facts.map(([name, value]) => { const row = node('div'); row.append(node('dt', '', name), node('dd', '', value)); return row; }));
  text('calldata', p.data);
  if (job.transactionHash) $('transaction-hash').value = job.transactionHash;
}
function renderJournal() {
  const root = $('receipts'), jobs = state.journal.jobs.slice().reverse();
  root.className = jobs.length ? '' : 'empty'; root.replaceChildren();
  if (!jobs.length) { root.textContent = 'No executions yet. Your next result will appear here.'; return; }
  for (const job of jobs) {
    const card = node('article', 'receipt'), top = node('div', 'receipt-head'), title = node('div', 'receipt-title');
    title.append(node('span', `badge ${job.state === 'VERIFIED' ? 'good' : job.state === 'FROZEN' ? 'bad' : 'neutral'}`, job.state), node('span', '', `${usd(job.plan.notionalUsd)} rebalance`));
    top.append(title, node('span', 'receipt-time', new Date(job.createdAt).toLocaleTimeString())); card.append(top);
    card.append(node('div', 'receipt-proof mono', `Plan ${short(job.id)} · nonce ${job.plan.nonce} · ${state.mode === 'local' ? 'LOCAL EVM · NOT CAMPAIGN EVIDENCE' : 'BSC TESTNET · ELIGIBILITY UNVERIFIED'}`));
    if (job.receipt) {
      card.append(node('div', 'receipt-proof mono', `Tx ${job.receipt.transactionHash}`));
      const details = node('details'), summary = node('summary', '', `Inspect ${Object.keys(job.receipt.checks).length} checks & receipt`), checks = node('div', 'checks');
      for (const [name, ok] of Object.entries(job.receipt.checks)) { const check = node('div', 'check');
        check.append(node('span', '', name.replace(/[A-Z]/g, x => ` ${x.toLowerCase()}`)), node('span', ok ? 'pass' : 'fail', ok ? 'PASS' : 'FAIL')); checks.append(check); }
      details.append(summary, checks, node('pre', '', JSON.stringify(job.receipt, null, 2))); card.append(details);
    } else {
      const button = node('button', 'text-button', job.transactionHash ? 'Resume verification →' : 'Inspect plan →');
      button.disabled = busy; button.addEventListener('click', () => { selectedJob = job; renderPlan(); $('workspace').scrollIntoView({ behavior: 'smooth' }); }); card.append(button);
    }
    root.append(card);
  }
}
async function work(action) {
  if (busy) return; busy = true; if (state) render();
  try { await action(); } catch (error) { notify(error.code === 4001 ? 'Wallet request cancelled. No automatic retry.' : error.message || 'Operation failed', true); }
  finally { busy = false; if (state) { try { await refresh(); } catch { render(); } } }
}
async function preview() {
  const result = await api('/plans', {});
  if (result.state === 'BLOCKED') { selectedJob = undefined; renderPlan(); decision('BLOCKED', 'No trade proposed.', result.reasons.join(' · '), 'warn'); return false; }
  selectedJob = result.job; renderPlan(); return true;
}
async function verifyCurrent(hashValue, job = selectedJob, submittedGuard = guard) {
  if (!job) throw new Error('Select the original plan before verification.');
  submittedGuard?.rememberHash(job, hashValue);
  wallet.capture();
  const result = await api('/verify', { jobId: job.id, hash: hashValue });
  if (result.state === 'PENDING') { decision('PENDING', 'Waiting for chain confirmation.', result.reason, 'warn'); notify(result.reason); return false; }
  selectedJob = result.job; submittedGuard?.acceptProof(selectedJob); renderPlan(); notify(`Proof ${result.job.state}. Saved to the journal.`); return true;
}
async function chooseProvider() {
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  await new Promise(resolve => setTimeout(resolve, 100));
  return selectOKXProvider(wallets.values(), window.okxwallet, window.ethereum);
}
$('connect').addEventListener('click', () => work(async () => {
  if (wallet.token()) { wallet.disconnect(); return; }
  const provider = await chooseProvider();
  await wallet.connect(provider);
  notify('Wallet session connected. Signing in does not approve tokens.');
}));
$('refresh').addEventListener('click', () => work(refresh));
$('plan').addEventListener('click', () => work(preview));
$('execute').addEventListener('click', () => work(async () => {
  if (!selectedJob) return;
  if (state.mode === 'local') { selectedJob = (await api('/local/execute', { jobId: selectedJob.id })).job; notify(`Local trade ${selectedJob.state}. No real funds used.`); return; }
  if (Date.now() / 1000 > Number(selectedJob.plan.deadline)) throw new Error('This plan expired. Preview a fresh rebalance.');
  const job = selectedJob, context = wallet.capture(), submittedGuard = guard;
  await wallet.check(context);
  const tx = await submittedGuard.submit(job, context.account, () => wallet.send({ from: context.account, to: job.plan.vault, data: job.plan.data, value: '0x0', chainId: '0x61' }, context));
  wallet.assertToken(context.token);
  $('transaction-hash').value = tx;
  selectedJob = job;
  await verifyCurrent(tx, job, submittedGuard);
}));
$('verify').addEventListener('click', () => work(() => verifyCurrent($('transaction-hash').value.trim())));
$('resume-submission').addEventListener('click', () => work(async () => {
  const marker = guard.read();
  selectedJob = state.journal.jobs.find(job => job.id === marker?.jobId);
  if (!selectedJob) throw new Error('Restore the journal containing the original plan before verification.');
  $('transaction-hash').value = marker.hash || '';
  renderPlan(); $('workspace').scrollIntoView({ behavior: 'smooth' });
  notify(marker.hash ? 'Original plan and hash restored. Connect the wallet, then verify.' : 'Original plan restored. Copy its transaction hash from wallet activity, then verify.');
}));
$('release-submission').addEventListener('click', () => work(async () => {
  await refresh(); await guard.releaseExpired(state.snapshot);
  selectedJob = undefined;
  decision('REVIEW WALLET ACTIVITY', 'Old plan can no longer execute.', 'The on-chain deadline passed or the nonce was consumed. Releasing this request does not verify an earlier trade. Review wallet history before creating a fresh plan.', 'warn');
}));
window.addEventListener('storage', event => { if (guard && event.key === guard.key && state) render(); });
$('pause').addEventListener('click', () => work(async () => {
  const context = state.mode === 'local' ? undefined : wallet.capture();
  const action = state.snapshot.paused ? 'resume' : 'pause'; const result = await api('/action', { action });
  if (result.transaction) { const tx = await wallet.send(result.transaction, context); notify(`Owner transaction sent: ${short(tx)}. Refresh after confirmation.`); }
  else notify(action === 'pause' ? 'Vault paused on the local chain.' : 'Vault resumed on the local chain.');
  selectedJob = undefined;
}));
$('recover').addEventListener('click', () => work(async () => {
  await api('/recover', {}); selectedJob = undefined;
  decision('VAULT PAUSED', 'Incident acknowledged.', 'The failed proof is preserved. Review it before resuming the vault.');
  notify('Runner recovered. Vault is still paused; resume it separately after review.');
}));
for (const button of document.querySelectorAll('.funding-action')) button.addEventListener('click', () => work(async () => {
  const context = wallet.capture();
  const result = await api('/action', { action: button.dataset.action, asset: Number($('fund-asset').value), amount: $('fund-amount').value.trim() });
  const tx = await wallet.send(result.transaction, context); notify(`Owner transaction sent: ${short(tx)}. Refresh after confirmation.`); selectedJob = undefined;
}));
$('reset').addEventListener('click', () => work(async () => { await api('/local/reset', {}); selectedJob = undefined;
  decision('AWAITING PLAN', 'A fresh local baseline.', '80 TEST-A / 20 TEST-B. No real assets.'); notify('Local lab reset.'); }));
$('oracle-outage').addEventListener('click', () => work(async () => {
  await api('/local/oracle-outage', {});
  decision('ORACLE UNAVAILABLE', 'Rebalancing is blocked.', 'USD valuation is hidden. Balances and owner pause/withdraw controls remain available. Reset lab to restore the price source.', 'warn');
  notify('Local oracle made stale on-chain. No public chain or real funds involved.');
}));
$('judge-run').addEventListener('click', () => work(async () => {
  await api('/local/reset', {}); selectedJob = undefined;
  if (!await preview()) throw new Error('Local baseline did not produce a plan');
  const passed = await api('/local/execute', { jobId: selectedJob.id }); if (passed.job.state !== 'VERIFIED') throw new Error('Local execution did not verify');
  await api('/action', { action: 'pause' });
  const blocked = await api('/plans', {}); if (blocked.state !== 'BLOCKED' || !blocked.reasons.includes('vault_paused')) throw new Error('Pause test failed');
  await api('/action', { action: 'resume' });
  if (!await preview()) throw new Error('Resume test failed');
  const failed = await api('/local/fault', { jobId: selectedJob.id }); selectedJob = failed.job;
  if (failed.job.state !== 'FROZEN') throw new Error('Mismatched proof was not rejected');
  notify('Safety test passed: real local swap VERIFIED → owner pause BLOCKED → wrong proof FROZEN. Reset lab to run again.');
}));
$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ environment: state.environment, campaignProof: false, journal: state.journal }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = node('a'); link.href = url; link.download = 'agentguard-proof-journal.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
refresh().catch(error => { text('network', 'SERVICE OFFLINE'); text('runner-state', 'Start the service');
  text('runner-detail', 'npm run bsc:serve'); decision('SERVICE REQUIRED', 'Start your local console.', 'Run npm ci, then npm run bsc:serve. Open the URL printed in your terminal.'); notify(error.message, true); });
