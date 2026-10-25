import { selectOKXProvider, testnetWalletConnection } from '../wallet-session.js';
const $ = id => document.getElementById(id), wallets = new Map();
let state, account, prepared, proof, busy = false, attempted = false, recoveryStorageBlocked = false;
const connection = testnetWalletConnection({ onChange(reason) {
  account = connection.account(); prepared = undefined; update();
  if (reason) notice(reason);
} });
window.addEventListener('eip6963:announceProvider', event => {
  if (event.detail?.info?.uuid && event.detail.provider) wallets.set(event.detail.info.uuid, event.detail);
});
const notice = text => { $('notice').textContent = text; };
const key = () => `agentguard:controlled:97:${state.owner.toLowerCase()}`;
const hashOK = hash => /^0x[0-9a-fA-F]{64}$/.test(hash);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
function marker(storage, value) {
  try {
    localStorage.setItem(storage, value);
    if (localStorage.getItem(storage) !== value) throw new Error('Recovery readback mismatch');
  } catch {
    recoveryStorageBlocked = true;
    throw new Error('Recovery storage could not be verified. No new wallet request is allowed. Existing proof and recovery controls remain available.');
  }
}
function deploymentRecord() {
  const value = localStorage.getItem(key());
  if (!value) return undefined;
  if (hashOK(value)) return { state: 'LEGACY_SUBMITTED', hash: value };
  if (value === 'WALLET_REQUESTED') return { state: 'LEGACY_REQUESTED' };
  try {
    const record = JSON.parse(value);
    if (record && typeof record === 'object' &&
      ['WALLET_REQUESTED', 'SUBMITTED', 'VERIFIED'].includes(record.state) &&
      (record.nonce === undefined || (Number.isSafeInteger(record.nonce) && record.nonce >= 0)) &&
      (record.hash === undefined || hashOK(record.hash))) return record;
  } catch { /* Invalid saved data remains a lock. */ }
  return { state: 'UNREADABLE' };
}
async function walletLock(action) {
  if (!navigator.locks?.request) throw new Error('This browser cannot safely coordinate wallet requests across tabs. Use a current browser on localhost.');
  return navigator.locks.request(`${key()}:wallet`, { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('Another tab has a wallet request in progress. Finish or recover it there first.');
    return action();
  });
}
const refreshKey = address => `${key()}:refresh:${address.toLowerCase()}`;
function refreshRecord(address) {
  const storage = refreshKey(address), current = localStorage.getItem(storage);
  if (current) {
    const record = JSON.parse(current);
    if (!record || typeof record !== 'object' || !['WALLET_REQUESTED', 'SUBMITTED'].includes(record.state) ||
      !Number.isSafeInteger(record.nonce) || record.nonce < 0 || !same(record.to, address) ||
      (record.hash && !hashOK(record.hash))) throw new Error('Invalid saved refresh request. Do not resend; inspect local recovery data.');
    return record;
  }
  // Older builds included the preparation block in the key. Keep those locks
  // visible rather than treating a new block/preparation as permission to send.
  const legacyKeys = Object.keys(localStorage).filter(item => item.startsWith(`${storage}:`)).sort();
  if (legacyKeys.length) return { legacyKeys, state: 'LEGACY', to: address, hash: localStorage.getItem(legacyKeys[0]) };
}
function invalidateProof() { proof = undefined; $('proof').textContent = ''; $('refresh-actions').replaceChildren(); }
function update() {
  const owner = same(account, state?.owner), verified = proof?.state === 'VERIFIED';
  $('connect').disabled = busy || !state;
  $('connect').textContent = account ? `OKX · ${account.slice(0, 8)}… · Disconnect` : 'Connect OKX Wallet';
  $('wallet-status').textContent = account ? owner ? 'Configured owner connected. Chain and account are rechecked before each request.' : 'Wrong owner. Connect the configured owner address.' : 'Connect the owner with OKX Wallet on BNB Smart Chain Testnet (97).';
  $('prepare').disabled = busy || !state || !$('ack').checked;
  let deploymentLocked = true;
  try { deploymentLocked = !!deploymentRecord(); } catch { /* Fail closed. */ }
  $('deploy').disabled = busy || recoveryStorageBlocked || !owner || !prepared || Date.now() - prepared.preparedAt > 60000 || attempted || deploymentLocked || !$('ack').checked;
  $('deploy').textContent = attempted ? 'Request started — recover & verify below' : 'Review deployment in OKX Wallet';
  $('verify').disabled = busy || !state || !hashOK($('hash').value.trim());
  $('download').disabled = busy || !verified;
  $('export').disabled = busy || !verified || !['OWNER_MANUAL', 'DELEGATED'].includes($('mode').value) || !/^0x[0-9a-fA-F]{40}$/.test($('operator').value.trim());
  $('refresh').disabled = busy || !verified;
  for (const id of ['hash', 'ack', 'mode', 'operator']) $(id).disabled = busy;
  document.querySelectorAll('#refresh-actions input, #refresh-actions button:not([data-feed])').forEach(control => { control.disabled = busy; });
  document.querySelectorAll('[data-feed]').forEach(button => {
    let used = true; try { used = !!refreshRecord(button.dataset.feed); } catch { /* Disable without durable recovery. */ }
    button.disabled = busy || recoveryStorageBlocked || !owner || used;
  });
}
async function api(action = '', input) {
  const response = await fetch(`/api/v1/controlled${action}`, input === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
  });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Setup unavailable'); return data;
}
async function work(action) {
  if (busy) return; busy = true; update();
  try { await action(); } catch (error) { notice(error.message || 'Setup unavailable'); } finally { busy = false; update(); }
}
async function assertWallet(context) {
  if (!same(connection.account(), state.owner)) throw new Error('Connect the configured owner.');
  return connection.check(context);
}
$('connect').addEventListener('click', () => work(async () => {
  if (account) { connection.disconnect(); return; }
  window.dispatchEvent(new Event('eip6963:requestProvider')); await new Promise(resolve => setTimeout(resolve, 100));
  const provider = selectOKXProvider(wallets.values(), window.okxwallet, window.ethereum);
  await connection.connect(provider);
}));
async function prepare() {
  prepared = undefined; update();
  const value = await api('/prepare', {});
  if (value.status !== 'UNSIGNED_CONTROLLED_TESTNET_DEPLOYMENT' || !same(value.owner, state.owner) ||
    value.chainId !== 97 || value.independentChecked !== true || value.dependencyMode !== 'CONTROLLED_TEST_ASSETS') throw new Error('Unexpected setup response.');
  if (!Number.isFinite(value.preparedAt) || Date.now() - value.preparedAt > 60000 || value.preparedAt > Date.now() + 5000)
    throw new Error('Deployment preparation is stale or mismatched. Prepare again.');
  prepared = value;
  $('transaction').textContent = JSON.stringify(value, null, 2);
  $('gas').textContent = `Estimated gas: ${value.gas.estimate} units. Cost + 20%: ${(Number(value.gas.bufferedCost) / 1e18).toFixed(6)} test BNB. Rechecked before signing.`;
}
$('prepare').addEventListener('click', () => work(prepare));
$('deploy').addEventListener('click', () => work(() => walletLock(async () => {
  if (recoveryStorageBlocked || attempted || deploymentRecord() || !$('ack').checked) return;
  const wallet = await assertWallet(); await prepare(); await assertWallet(wallet);
  if (!$('ack').checked || deploymentRecord()) throw new Error('Review acknowledgement and saved wallet requests before continuing.');
  const tx = prepared.transaction;
  if (tx.to || tx.value !== '0x0' || tx.chainId !== '0x61' || !same(tx.from, account) || !/^0x[0-9a-fA-F]+$/.test(tx.data)) throw new Error('Unexpected deployment transaction.');
  const rawNonce = await wallet.provider.request({ method: 'eth_getTransactionCount', params: [wallet.account, 'pending'] });
  if (typeof rawNonce !== 'string' || !/^0x[0-9a-fA-F]+$/.test(rawNonce)) throw new Error('Wallet did not return a valid pending nonce.');
  const nonce = Number(BigInt(rawNonce)); if (!Number.isSafeInteger(nonce)) throw new Error('Invalid wallet nonce.');
  await assertWallet(wallet);
  if (!$('ack').checked || deploymentRecord()) throw new Error('Review acknowledgement and saved wallet requests before continuing.');
  const requested = { state: 'WALLET_REQUESTED', nonce, requestedAt: Date.now() };
  marker(key(), JSON.stringify(requested)); attempted = true;
  try {
    const hash = await wallet.provider.request({ method: 'eth_sendTransaction', params: [{ ...tx, nonce: `0x${nonce.toString(16)}` }] });
    if (!hashOK(hash)) throw new Error('Wallet returned no valid transaction hash.');
    $('hash').value = hash; marker(key(), JSON.stringify({ ...requested, state: 'SUBMITTED', hash }));
    $('result').textContent = 'Sent. Wait for two confirmations, then verify through both RPCs.';
  } catch (error) {
    if (Number(error.code) === 4001) { localStorage.removeItem(key()); attempted = false; throw new Error('Wallet rejected the request. No automatic retry.'); }
    $('result').textContent = 'Submission uncertain. Check wallet Activity and recover the hash. Resending stays disabled.'; throw error;
  }
})));
$('hash').addEventListener('input', () => { invalidateProof(); $('result').textContent = 'Verify the entered deployment hash.'; update(); });
$('verify').addEventListener('click', () => work(async () => {
  invalidateProof();
  const hash = $('hash').value.trim(), saved = deploymentRecord();
  if (saved?.hash && !same(saved.hash, hash)) throw new Error('Use the saved deployment hash. A different transaction cannot release this recovery lock.');
  const inspected = await api('/verify', { hash, ...(Number.isSafeInteger(saved?.nonce) ? { nonce: saved.nonce } : {}) });
  if (!same(inspected.transactionHash, hash) || !same(hash, $('hash').value.trim()) || !same(inspected.owner, state.owner) ||
    inspected.chainId !== 97 || inspected.dependencyMode !== 'CONTROLLED_TEST_ASSETS' ||
    (Number.isSafeInteger(saved?.nonce) && inspected.expectedNonce !== saved.nonce))
    throw new Error('Deployment proof does not match the saved transaction hash, nonce and owner.');
  $('proof').textContent = JSON.stringify(inspected, null, 2);
  $('result').textContent = inspected.state === 'VERIFIED' ? `VERIFIED · ${inspected.primary.contractAddress} · Synthetic test environment only.` :
    inspected.state === 'PENDING' ? 'PENDING · Wait for inclusion and two confirmations; retry verification only.' : 'MISMATCH · Stop and inspect the evidence. No config can be saved.';
  if (inspected.state === 'VERIFIED') {
    proof = inspected; attempted = true;
    // A persistence failure must not hide a verified proof or its recovery UI.
    // New sends stay blocked, while inspection/download remain available.
    try {
      marker(key(), JSON.stringify({ state: 'VERIFIED', hash: inspected.transactionHash,
        ...(Number.isSafeInteger(saved?.nonce) ? { nonce: saved.nonce } : {}) }));
    } finally { renderRefresh(); }
  }
}));
for (const id of ['ack', 'mode', 'operator']) $(id).addEventListener('input', () => {
  if (id === 'mode' && $('mode').value === 'OWNER_MANUAL') $('operator').value = state?.owner || '';
  if (id === 'mode' && $('mode').value === 'DELEGATED' && same($('operator').value, state?.owner)) $('operator').value = '';
  update();
});
$('export').addEventListener('click', () => work(async () => {
  const value = await api('/config', { operator: $('operator').value.trim(), mode: $('mode').value, environmentHash: proof.transactionHash });
  $('next').textContent = `Saved ${value.path}. Next run: npm run bsc:deploy-console -- config/bsc-controlled.json. The vault is NOT deployed yet; review policy and confirm separately in your wallet.`;
}));
$('download').addEventListener('click', () => {
  if (proof?.state !== 'VERIFIED') return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(proof, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'agentguard-controlled-environment-proof.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
function renderRefresh() {
  $('refresh-actions').replaceChildren();
  if (proof?.state !== 'VERIFIED') return;
  const environmentHash = proof.transactionHash;
  const assertEnvironment = () => {
    if (proof?.state !== 'VERIFIED' || !same(proof.transactionHash, environmentHash) || !same($('hash').value.trim(), environmentHash))
      throw new Error('Environment changed. Reverify the deployment before continuing.');
  };
  for (const index of [0, 1]) {
    const address = proof.primary.dependencies[`feed${index}`], storage = refreshKey(address);
    const section = document.createElement('section'); section.className = 'decision';
    const title = document.createElement('h3'); title.textContent = `Synthetic feed ${index + 1}`;
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    let record; try { record = refreshRecord(address); } catch (error) { status.textContent = error.message; }
    if (record) status.textContent = `Previous request: ${record.state}. Recover its hash and verify; preparing again never clears this lock.`;
    const button = document.createElement('button'); button.className = 'secondary'; button.textContent = 'Review fresh refresh call in OKX'; button.dataset.feed = address;
    const label = document.createElement('label'); label.textContent = 'Refresh transaction hash';
    const input = document.createElement('input'); input.id = `refresh-hash-${index}`; input.autocomplete = 'off'; input.spellcheck = false;
    if (hashOK(record?.hash)) input.value = record.hash;
    label.append(input);
    const nonceLabel = document.createElement('label'); nonceLabel.textContent = 'Saved request nonce (legacy requests: copy from wallet Activity)';
    const nonceInput = document.createElement('input'); nonceInput.id = `refresh-nonce-${index}`; nonceInput.type = 'number'; nonceInput.min = '0'; nonceInput.step = '1';
    nonceInput.readOnly = record?.state !== 'LEGACY'; if (Number.isSafeInteger(record?.nonce)) nonceInput.value = String(record.nonce); nonceLabel.append(nonceInput);
    const verify = document.createElement('button'); verify.id = `verify-refresh-${index}`; verify.className = 'secondary'; verify.textContent = 'Verify saved request through both RPCs';
    verify.addEventListener('click', () => work(() => walletLock(async () => {
      assertEnvironment();
      const saved = refreshRecord(address), hash = input.value.trim();
      if (!saved || !hashOK(hash)) throw new Error('Recover the saved request hash from wallet Activity first.');
      const nonce = saved.state === 'LEGACY' && /^\d+$/.test(nonceInput.value) ? Number(nonceInput.value) : saved.nonce;
      if (!Number.isSafeInteger(nonce) || nonce < 0 || (hashOK(saved.hash) && !same(saved.hash, hash))) throw new Error('Use the saved transaction hash and nonce. A different request cannot release this lock.');
      const inspected = await api('/verify-refresh', { hash, feed: index, nonce, environmentHash });
      assertEnvironment();
      status.textContent = `${inspected.state} · ${hash}`;
      if (!same(inspected.transactionHash, hash) || inspected.feed !== index || inspected.nonce !== nonce ||
        !['VERIFIED', 'REVERTED'].includes(inspected.state) || !inspected.matchingReads || !inspected.canonical) {
        throw new Error('Request is pending or does not match. Submission remains locked.');
      }
      if (JSON.stringify(refreshRecord(address)) !== JSON.stringify(saved)) throw new Error('Saved request changed during verification. Lock retained.');
      // Resolve only the inspected legacy request, never unrelated uncertain calls.
      if (saved.state === 'LEGACY') localStorage.removeItem(saved.legacyKeys[0]);
      else localStorage.removeItem(storage);
      nonceInput.value = ''; nonceInput.readOnly = true;
      status.textContent += inspected.state === 'VERIFIED' ? ' · Synthetic timestamp refreshed.' : ' · Transaction reverted; no refresh succeeded.';
      if (refreshRecord(address)) { renderRefresh(); notice('Another saved request still needs verification. Submission remains locked.'); }
      else status.textContent += ' A new deliberate request is now allowed.';
    })));
    button.addEventListener('click', () => work(() => walletLock(async () => {
      if (recoveryStorageBlocked) throw new Error('Recovery storage is unavailable. No new wallet request is allowed.');
      if (refreshRecord(address)) throw new Error('Existing refresh request must be verified before sending another.');
      assertEnvironment();
      const wallet = await assertWallet(); const value = await api('/refresh', { environmentHash }); await assertWallet(wallet);
      assertEnvironment();
      if (value.status !== 'UNSIGNED_CONTROLLED_FEED_REFRESH' || value.transactions?.length !== 2 ||
        !Number.isFinite(value.preparedAt) || Date.now() - value.preparedAt > 60000 || value.preparedAt > Date.now() + 5000) throw new Error('Refresh preparation is stale or mismatched. Prepare again.');
      const tx = value.transactions[index];
      if (!same(tx.from, account) || tx.value !== '0x0' || tx.chainId !== '0x61' || !same(tx.to, address) || tx.data?.toLowerCase() !== '0xf8ac93e8') throw new Error('Unexpected refresh transaction.');
      const rawNonce = await wallet.provider.request({ method: 'eth_getTransactionCount', params: [wallet.account, 'pending'] });
      if (typeof rawNonce !== 'string' || !/^0x[0-9a-fA-F]+$/.test(rawNonce)) throw new Error('Wallet did not return a valid pending nonce.');
      const nonce = Number(BigInt(rawNonce)); if (!Number.isSafeInteger(nonce)) throw new Error('Invalid wallet nonce.');
      await assertWallet(wallet); assertEnvironment();
      if (refreshRecord(address)) throw new Error('Existing request found. Do not resend.');
      const saved = { state: 'WALLET_REQUESTED', to: address, nonce, requestedAt: Date.now() };
      marker(storage, JSON.stringify(saved)); nonceInput.value = String(nonce); nonceInput.readOnly = true;
      status.textContent = 'Wallet request started. If interrupted, recover its hash below. Do not resend.';
      try {
        const submitted = await wallet.provider.request({ method: 'eth_sendTransaction', params: [{ ...tx, nonce: `0x${nonce.toString(16)}` }] });
        if (!hashOK(submitted)) throw new Error('Wallet response uncertain. Check Activity.');
        // Preserve the wallet's hash on screen even if the second write fails.
        input.value = submitted;
        marker(storage, JSON.stringify({ ...saved, state: 'SUBMITTED', hash: submitted }));
        status.textContent = 'Submitted. Wait for two confirmations, then verify this saved request.';
      } catch (error) {
        if (Number(error.code) === 4001) { localStorage.removeItem(storage); nonceInput.value = ''; status.textContent = 'Explicitly rejected by wallet. No automatic retry.'; }
        else status.textContent = 'Submission uncertain. Keep the displayed hash, check wallet Activity, and verify this saved request. Do not resend.';
        throw error;
      }
    })));
    section.append(title, status, button, label, nonceLabel, verify); $('refresh-actions').append(section);
  }
}
$('refresh').addEventListener('click', () => work(async () => { await api('/refresh', { environmentHash: proof.transactionHash }); renderRefresh(); }));
window.addEventListener('storage', () => { if (!busy) renderRefresh(); update(); });
api().then(value => {
  if (value.chainId !== 97 || value.dependencyMode !== 'CONTROLLED_TEST_ASSETS') throw new Error('Start the controlled-testnet setup server.');
  state = value; $('owner').textContent = `Owner: ${value.owner}`; $('disclosure').textContent = value.note;
  try {
    const stored = deploymentRecord(); attempted = !!stored;
    if (hashOK(stored?.hash)) $('hash').value = stored.hash;
    if (stored) $('result').textContent = 'Previous wallet request found. Verify its hash or recover it from wallet Activity. No automatic resend.';
  } catch { attempted = true; notice('Storage unavailable. Wallet deployment is disabled to prevent duplicate submissions.'); }
  update();
}).catch(error => notice(error.message));
setInterval(update, 1000);
