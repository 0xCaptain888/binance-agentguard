const $ = id => document.getElementById(id);
let prepared, provider, account, attempted = false, busy = false, proof, timer, preflight, preflightExpires = 0;
let registration, registrationAttempted = false, registrationProof;
const wallets = new Map();
window.addEventListener('eip6963:announceProvider', event => {
  if (event.detail?.provider && typeof event.detail.info?.name === 'string') wallets.set(event.detail.info.uuid, event.detail);
});
window.dispatchEvent(new Event('eip6963:requestProvider'));
function element(tag, content, className) { const el = document.createElement(tag); if (content !== undefined) el.textContent = content; if (className) el.className = className; return el; }
function notice(message) { clearTimeout(timer); $('notice').textContent = message; $('notice').hidden = false; timer = setTimeout(() => { $('notice').hidden = true; }, 5000); }
function result(badge, title, detail) { $('result').replaceChildren(element('span', badge, `badge ${badge === 'VERIFIED' ? 'good' : badge === 'MISMATCH' ? 'bad' : 'neutral'}`), element('h3', title), element('p', detail)); }
function rows(id, pairs) { $(id).replaceChildren(...pairs.map(([key, value]) => { const row = element('div'); row.append(element('dt', key), element('dd', String(value))); return row; })); }
function storageKey() { return `agentguard-deployment:${prepared.initCodeHash}:${prepared.config.owner.toLowerCase()}`; }
function registrationStorageKey() { return `agentguard-registration:${prepared?.config.owner?.toLowerCase() || 'unknown'}`; }
function saveAttempt(hash) {
  try { localStorage.setItem(storageKey(), hash || 'WALLET_REQUESTED'); }
  catch { throw new Error('Browser storage is unavailable. Restore storage before requesting a deployment.'); }
  attempted = true;
}
function saveRegistrationAttempt(hash) {
  try { localStorage.setItem(registrationStorageKey(), hash || 'WALLET_REQUESTED'); }
  catch { throw new Error('Browser storage is unavailable. Restore storage before requesting registration.'); }
  registrationAttempted = true;
}
function update() {
  const owner = prepared && account?.toLowerCase() === prepared.config.owner.toLowerCase();
  $('connect').disabled = busy || !prepared; $('connect').textContent = account ? `${account.slice(0, 8)}… · Disconnect` : 'Connect Wallet';
  $('wallet-status').textContent = account ? owner ? 'Configured owner connected. Chain is checked again before sending.' : 'This wallet is not the configured owner.' : 'Connect the configured owner wallet on chain 97.';
  const fresh = preflight?.state === 'READY' && Date.now() < preflightExpires;
  $('deploy').disabled = busy || !owner || attempted || !fresh || !$('review-addresses').checked || !$('review-policy').checked;
  $('refresh-preflight').disabled = busy || !prepared;
  if (preflight?.state === 'READY' && !fresh) { $('preflight-state').textContent = 'EXPIRED'; $('preflight-state').className = 'badge warn'; }
  $('deploy').textContent = attempted ? 'Wallet request already started' : 'Review & deploy in wallet';
  $('verify').disabled = busy || !prepared || !/^0x[0-9a-fA-F]{64}$/.test($('hash').value.trim());
  $('export-proof').disabled = !proof;
  const registrationOwner = prepared && account?.toLowerCase() === prepared.config.owner.toLowerCase();
  const registrationReady = registration?.status === 'UNSIGNED_ERC8004_REGISTRATION';
  $('register').disabled = busy || !registrationReady || !registrationOwner || registrationAttempted || !$('registration-owner-review').checked;
  $('register').textContent = registrationAttempted ? 'Wallet request already started' : 'Register identity in wallet';
  $('verify-registration').disabled = busy || !registrationReady || !/^0x[0-9a-fA-F]{64}$/.test($('registration-hash').value.trim());
  $('export-registration').disabled = !registrationProof;
}
async function api(path, data) {
  const response = await fetch(`/api/v1/deployment${path}`, data === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
  });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Start npm run bsc:deploy-console with your local config.');
  const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Operation unavailable'); return value;
}
async function registrationApi(path = '', data) {
  const response = await fetch(`/api/v1/registration${path}`, data === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
  });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Registration service unavailable.');
  const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Registration operation unavailable'); return value;
}
async function work(action) { if (busy) return; busy = true; update(); try { await action(); } catch (error) { notice(error.message || 'Operation failed'); } finally { busy = false; update(); } }
function native(raw) {
  if (raw === null || raw === undefined) return 'Unavailable';
  const value = BigInt(raw); return `${value / 10n ** 18n}.${(value % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '') || '0'} test BNB`;
}
async function checkReadiness() {
  preflight = undefined; preflightExpires = 0;
  $('preflight-state').textContent = 'CHECKING'; $('preflight-state').className = 'badge neutral';
  $('preflight-summary').textContent = 'Reading the same recent block through both RPC providers…';
  $('preflight-gas').replaceChildren(); $('preflight-checks').replaceChildren(); update();
  try {
    preflight = await api('/preflight', {});
    const ready = preflight.state === 'READY';
    preflightExpires = ready ? Date.now() + 60000 : 0;
    $('preflight-state').textContent = ready ? 'READY' : 'BLOCKED'; $('preflight-state').className = `badge ${ready ? 'good' : 'bad'}`;
    $('preflight-summary').textContent = ready ? `Both providers agree at block ${preflight.primary.blockNumber}. Review the configuration before signing.` : 'Readiness checks failed. Inspect the failed checks below and correct the configuration before deploying.';
    const gas = preflight.primary.gas;
    rows('preflight-gas', [['Owner test gas', native(gas.ownerBalance)], ['Constructor gas units', gas.estimate ?? 'Unavailable'],
      ['Estimated cost + 20%', gas.estimate && gas.gasPrice ? native((BigInt(gas.estimate) * BigInt(gas.gasPrice) * 120n + 99n) / 100n) : 'Unavailable']]);
    for (const [label, report] of [['Primary RPC', preflight.primary], ['Independent RPC', preflight.independent]]) {
      $('preflight-checks').append(element('h3', label));
      for (const check of report.checks) {
        const row = element('p', undefined, 'body-copy');
        row.append(element('span', check.passed ? 'PASS' : 'FAIL', `badge ${check.passed ? 'good' : 'bad'}`), document.createTextNode(` ${check.name.replaceAll('_', ' ')} — ${check.detail}`));
        $('preflight-checks').append(row);
      }
    }
    for (const key of ['sameBlock', 'matchingReads', 'stillCanonical']) $('preflight-checks').append(element('p', `${preflight[key] ? 'PASS' : 'FAIL'} · ${key}`, 'body-copy'));
    return ready;
  } catch (error) {
    preflight = undefined; $('preflight-state').textContent = 'UNAVAILABLE'; $('preflight-state').className = 'badge bad';
    $('preflight-summary').textContent = 'RPC inspection unavailable. Deployment stays disabled until both providers can be checked.'; throw error;
  } finally { update(); }
}
$('refresh-preflight').addEventListener('click', () => work(checkReadiness));
setInterval(update, 1000);
async function assertWallet() {
  if (!provider || !account || account.toLowerCase() !== prepared.config.owner.toLowerCase()) throw new Error('Connect the configured owner wallet.');
  if (Number(BigInt(await provider.request({ method: 'eth_chainId' }))) !== 97) throw new Error('Switch your wallet to BNB Smart Chain Testnet (97), then reconnect.');
  const accounts = await provider.request({ method: 'eth_accounts' });
  if (accounts[0]?.toLowerCase() !== account.toLowerCase()) throw new Error('Wallet account changed. Reconnect.');
}
function changed() { account = undefined; update(); notice('Wallet changed. Reconnect before signing.'); }
async function chooseProvider() {
  window.dispatchEvent(new Event('eip6963:requestProvider')); await new Promise(resolve => setTimeout(resolve, 100));
  const entries = [...wallets.values()]; if (entries.length < 2) return entries[0]?.provider || window.ethereum;
  const dialog = element('dialog', undefined, 'wallet-dialog'); dialog.append(element('h2', 'Choose your wallet'));
  return new Promise(resolve => {
    for (const entry of entries) { const button = element('button', entry.info.name, 'secondary'); button.addEventListener('click', () => { resolve(entry.provider); dialog.close(); }); dialog.append(button); }
    const cancel = element('button', 'Cancel', 'text-button'); cancel.addEventListener('click', () => dialog.close()); dialog.append(cancel);
    dialog.addEventListener('close', () => { dialog.remove(); resolve(undefined); }); document.body.append(dialog); dialog.showModal();
  });
}
$('connect').addEventListener('click', () => work(async () => {
  if (account) { account = undefined; return; }
  provider = await chooseProvider(); if (!provider) throw new Error('Use a browser with an EVM wallet extension.');
  account = (await provider.request({ method: 'eth_requestAccounts' }))[0];
  try { await assertWallet(); } catch (error) { account = undefined; throw error; }
  provider.removeListener?.('accountsChanged', changed); provider.removeListener?.('chainChanged', changed);
  provider.on?.('accountsChanged', changed); provider.on?.('chainChanged', changed);
}));
for (const id of ['review-addresses', 'review-policy', 'hash']) $(id).addEventListener('input', update);
for (const id of ['registration-owner-review', 'registration-hash']) $(id).addEventListener('input', update);
$('hash').addEventListener('input', () => {
  if (proof && proof.transactionHash?.toLowerCase() !== $('hash').value.trim().toLowerCase()) {
    proof = undefined; $('proof-details').hidden = true;
    result('UNVERIFIED HASH', 'Verify the new transaction hash.', 'The earlier attestation applies only to its original transaction.'); update();
  }
});
$('deploy').addEventListener('click', () => work(async () => {
  if (attempted || !$('review-addresses').checked || !$('review-policy').checked) return;
  await assertWallet();
  if (!await checkReadiness()) throw new Error('Deployment blocked by readiness checks. Inspect the failed checks.');
  await assertWallet();
  const tx = prepared.transaction;
  if (tx.to || tx.chainId !== '0x61' || tx.value !== '0x0' || tx.from.toLowerCase() !== account.toLowerCase()) throw new Error('Unexpected deployment transaction.');
  saveAttempt();
  try {
    const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: account, data: tx.data, value: '0x0', chainId: '0x61' }] });
    $('hash').value = hash; saveAttempt(hash);
    result('SENT', 'Deployment sent. Verify next.', 'Wait for two confirmations, then verify with the independent RPC.');
  } catch (error) {
    if (Number(error.code) === 4001) { try { localStorage.removeItem(storageKey()); attempted = false; } catch {} throw new Error('Wallet request cancelled. No automatic retry.'); }
    result('CHECK WALLET', 'Submission status is uncertain.', 'Check wallet activity and paste the deployment hash. Sending again is disabled to avoid duplicate deployment.'); throw error;
  }
}));
$('verify').addEventListener('click', () => work(async () => {
  proof = undefined; $('proof-details').hidden = true;
  const hash = $('hash').value.trim(), verified = await api('/verify', { hash }); proof = verified;
  $('proof').textContent = JSON.stringify(verified, null, 2); $('proof-details').hidden = false;
  if (verified.state === 'VERIFIED') { saveAttempt(hash); result('VERIFIED', 'Deployment independently verified.', `Vault ${verified.contractAddress}. Set BSC_VAULT_ADDRESS to this address, then start npm run bsc:testnet.`); }
  else if (verified.state === 'PENDING') result('PENDING', 'Waiting for inclusion or confirmation.', verified.reason);
  else result('MISMATCH', 'Deployment did not match.', `Failed checks: ${verified.reasons.join(', ')}. Inspect the evidence before continuing.`);
}));
$('export-proof').addEventListener('click', () => {
  if (!proof) return; const url = URL.createObjectURL(new Blob([JSON.stringify(proof, null, 2)], { type: 'application/json' }));
  const link = element('a'); link.href = url; link.download = `agentguard-deployment-${proof.state.toLowerCase()}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
function registrationResult(badge, title, detail) {
  $('registration-result').replaceChildren(element('span', badge, `badge ${badge === 'VERIFIED' ? 'good' : badge === 'MISMATCH' ? 'bad' : 'neutral'}`), element('h3', title), element('p', detail));
}
$('registration-hash').addEventListener('input', () => {
  if (registrationProof && registrationProof.transactionHash?.toLowerCase() !== $('registration-hash').value.trim().toLowerCase()) {
    registrationProof = undefined; $('registration-proof-details').hidden = true;
    registrationResult('UNVERIFIED HASH', 'Verify the new registration hash.', 'The earlier identity attestation applies only to its original transaction.'); update();
  }
});
$('register').addEventListener('click', () => work(async () => {
  if (!registration || registration.status !== 'UNSIGNED_ERC8004_REGISTRATION' || registrationAttempted || !$('registration-owner-review').checked) return;
  await assertWallet();
  const tx = registration.transaction;
  if (tx.to?.toLowerCase() !== registration.registry.toLowerCase() || tx.chainId !== '0x61' || tx.value !== '0x0' || tx.from.toLowerCase() !== account.toLowerCase()) throw new Error('Unexpected registration transaction.');
  saveRegistrationAttempt();
  try {
    const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: account, to: tx.to, data: tx.data, value: tx.value, chainId: tx.chainId }] });
    $('registration-hash').value = hash;
    saveRegistrationAttempt(hash);
    registrationResult('SENT', 'Registration sent. Verify next.', 'Wait for two confirmations, then verify through both RPC providers.');
  } catch (error) {
    if (Number(error.code) === 4001) {
      // Retain the guard if storage cannot be cleared; a reload must not resend.
      try { localStorage.removeItem(registrationStorageKey()); registrationAttempted = false; } catch {}
      throw new Error('Wallet request cancelled. No automatic retry.');
    }
    registrationResult('CHECK WALLET', 'Submission status is uncertain.', 'Check wallet activity and paste the registration hash. Sending again is disabled to avoid duplicate registration.'); throw error;
  }
}));
$('verify-registration').addEventListener('click', () => work(async () => {
  registrationProof = undefined; $('registration-proof-details').hidden = true;
  const hash = $('registration-hash').value.trim(); const verified = await registrationApi('/verify', { hash }); registrationProof = verified;
  $('registration-proof').textContent = JSON.stringify(verified, null, 2); $('registration-proof-details').hidden = false;
  if (verified.state === 'VERIFIED') { registrationAttempted = true; try { localStorage.setItem(registrationStorageKey(), hash); } catch {} registrationResult('VERIFIED', `Identity #${verified.agentId} independently verified.`, `Registry ${verified.registry}. Evidence ${verified.evidenceHash}`); }
  else if (verified.state === 'PENDING') registrationResult('PENDING', 'Waiting for inclusion or confirmation.', verified.reason);
  else registrationResult('MISMATCH', 'Registration did not match.', `Failed checks: ${verified.reasons.join(', ')}. Inspect the evidence before continuing.`);
}));
$('export-registration').addEventListener('click', () => {
  if (!registrationProof) return; const url = URL.createObjectURL(new Blob([JSON.stringify(registrationProof, null, 2)], { type: 'application/json' }));
  const link = element('a'); link.href = url; link.download = `agentguard-registration-${registrationProof.state.toLowerCase()}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
api('').then(value => {
  if (value.chainId !== 97 || value.status !== 'UNSIGNED_TESTNET_DEPLOYMENT') throw new Error('Expected unsigned BSC testnet configuration.');
  prepared = value;
  const c = value.config;
  rows('addresses', ['owner', 'operator', 'token0', 'token1', 'router', 'feed0', 'feed1'].map(key => [key, c[key]]));
  const dollars = raw => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(raw) / 1e18);
  rows('policy', [['Action limit', dollars(c.policy.maxActionUsd)], ['Daily limit', dollars(c.policy.maxDailyUsd)],
    ['Token 0 target', `${c.policy.targetToken0Bps / 100}%`], ['Maximum slippage', `${c.policy.maxSlippageBps / 100}%`],
    ['Cooldown', `${c.policy.cooldownSeconds}s`], ['Maximum oracle age', `${c.policy.maxOracleAge}s`]]);
  $('transaction').textContent = JSON.stringify(value, null, 2); $('service-note').textContent = value.note;
  let stored; try { stored = localStorage.getItem(storageKey()); } catch {}
  if (stored) { attempted = true; if (/^0x[0-9a-fA-F]{64}$/.test(stored)) $('hash').value = stored; }
  result(attempted ? 'RESUME VERIFICATION' : 'NOT DEPLOYED', attempted ? 'Check the existing wallet request.' : 'Configuration ready for review.', 'Review both panels. No transaction is sent until you explicitly confirm in your wallet.'); update();
  return registrationApi().then(value => {
    registration = value;
    if (registration.status === 'UNSIGNED_ERC8004_REGISTRATION') {
      rows('registration-details', [['Registry', registration.registry], ['Owner', registration.owner], ['Registration URI', registration.agentURI], ['Prepared at block', registration.simulatedAtBlock]]);
      $('registration-state').textContent = 'READY'; $('registration-state').className = 'badge good';
      $('registration-summary').textContent = 'Review the exact registry call, then confirm once in the configured owner wallet. Verification requires two confirmations and two RPC providers.';
      let stored; try { stored = localStorage.getItem(registrationStorageKey()); } catch {}
      if (stored) { registrationAttempted = true; if (/^0x[0-9a-fA-F]{64}$/.test(stored)) $('registration-hash').value = stored; }
      registrationResult(registrationAttempted ? 'RESUME VERIFICATION' : 'READY', registrationAttempted ? 'Check the existing registration request.' : 'Identity registration ready for review.', 'No transaction is sent until you explicitly confirm in your wallet.');
    } else {
      $('registration-state').textContent = 'NOT PREPARED'; $('registration-state').className = 'badge warn';
      $('registration-summary').textContent = value.reason || 'Configure a public HTTPS origin before preparing registration.';
      registrationResult('NOT REGISTERED', 'Waiting for a public origin.', value.reason || 'Use an HTTPS deployment URL before requesting a wallet signature.');
    }
    update(); return work(checkReadiness);
  });
}).catch(error => { $('service-note').textContent = 'Deployment service offline or configuration unavailable.'; result('SERVICE REQUIRED', 'Start your deployment service.', error.message); });
