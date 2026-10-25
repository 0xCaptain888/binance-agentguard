const $ = id => document.getElementById(id);
const messages = {
  NOT_CHECKED: 'No saved testnet scan yet. Start a read-only scan here or run the command below; no wallet or operator is required.',
  UNAVAILABLE: 'The last scan could not be read or completed. Check both RPC providers and rerun the scan.',
  RPC_VERIFICATION_FAILED: 'The two RPC providers did not establish a matching, recent canonical snapshot. Deployment remains blocked.',
  INCOMPLETE: 'Some dependencies could not be read. Matching errors do not establish successful verification; rerun the scan.',
  STALE_SNAPSHOT: 'This is a historical snapshot. Rerun the scan before reviewing any deployment decision.',
  BLOCKED: 'No reviewed deployment is ready. Inspect the candidate blockers below; adding test gas does not fix stale feeds or pool prices.',
  REVIEW_REQUIRED: 'A compatible candidate was observed. Its asset/feed mapping still needs review, followed by operator selection and full deployment preflight.'
};
const labels = {
  staleOrInvalidFeeds: 'Stale or invalid price feeds',
  missingContracts: 'Missing dependency contracts',
  invalidTokenMetadata: 'Token metadata mismatches',
  missingPairs: 'Direct pairs not found',
  failedQuoteDirections: 'Quote directions reverted or below floor',
  skippedPairs: 'Pairs skipped: prerequisites unavailable',
  rpcErrors: 'RPC or interface reads unavailable'
};
function row(label, value) {
  const div = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
  dt.textContent = label; dd.textContent = value; div.append(dt, dd); return div;
}
let latest, expires = Infinity, cooldown = 0, pending, launching = false;
function scanControls(scan) {
  const enabled = scan?.enabled === true;
  const running = scan?.state === 'RUNNING';
  cooldown = performance.now() + (Number.isFinite(scan?.retryAfterSeconds) ? scan.retryAfterSeconds * 1000 : 0);
  $('run-dependencies').disabled = !enabled || running || cooldown > performance.now() || launching;
  $('run-dependencies').textContent = running ? 'Scanning testnet…' : 'Run read-only scan';
  $('dependency-scan-status').textContent = !enabled ? 'Scan controls are available only on the updated local service. The command remains available for testnet services.' :
    running ? 'Reading two independent testnet RPCs. This can take up to two minutes. No wallet request or transaction.' :
      scan.retryAfterSeconds > 0 ? `${scan.state === 'FAILED' ? 'Scan failed; the previous result is not a new verification.' : 'Scan finished.'} Retry available in ${scan.retryAfterSeconds}s. No transaction sent.` :
        'Reads public testnet dependencies only. No signature, token approval or transaction. A compatible candidate still needs review.';
}
export function renderDependencies(report, updateControls = true) {
  latest = report;
  const remaining = Date.parse(report.expiresAt) - Date.parse(report.serverTime);
  expires = report.snapshotFresh === true && Number.isFinite(remaining) ? performance.now() + Math.max(0, remaining) : Infinity;
  const state = Object.hasOwn(messages, report.state) ? report.state : 'UNAVAILABLE';
  $('dependency-state').textContent = state.replaceAll('_', ' ');
  $('dependency-state').className = `badge ${['UNAVAILABLE', 'RPC_VERIFICATION_FAILED', 'INCOMPLETE', 'BLOCKED'].includes(state) ? 'bad' : 'warn'}`;
  $('dependency-summary').textContent = messages[state];
  $('dependency-facts').replaceChildren();
  if (report.checkedAt) $('dependency-facts').append(row('Last attempt', new Date(report.checkedAt).toLocaleString()));
  if (report.blockNumber) $('dependency-facts').append(row('Snapshot block', report.blockNumber));
  if (report.counts) {
    $('dependency-facts').append(
      row('Scan coverage', `${report.counts.tokens} tokens · ${report.counts.pairs} direct pairs · ${report.counts.quoteDirections} quote directions`),
      row('Compatible, unreviewed candidates', String(report.counts.compatibleCandidates)),
      row('Independent reads', report.independentReadsAgree ? 'Agreed at inspection time' : 'Not verified'));
  }
  if (report.policy) {
    $('dependency-facts').append(row('Scan policy', `$${Number(report.policy.maxActionUsd) / 1e18} per action · ${report.policy.maxSlippageBps / 100}% slippage · ${report.policy.maxOracleAgeSeconds}s oracle age`));
  }
  if (report.blockers) {
    for (const [key, label] of Object.entries(labels)) if (report.blockers[key] > 0) $('dependency-facts').append(row(label, String(report.blockers[key])));
  }
  if (updateControls) scanControls(report.scan);
}
async function reload() {
  if (pending) return pending;
  $('reload-dependencies').disabled = true;
  pending = (async () => {
    try {
      const response = await fetch('/api/v1/dependencies', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error();
      renderDependencies(await response.json());
    } catch {
      renderDependencies({ state: 'UNAVAILABLE' });
      $('dependency-summary').textContent = 'Dependency status is unavailable. Check the running local service and retry. A static preview cannot inspect your local RPC configuration.';
    } finally { $('reload-dependencies').disabled = false; pending = undefined; }
  })();
  return pending;
}
async function startScan() {
  if ($('run-dependencies').disabled || launching) return;
  launching = true; $('run-dependencies').disabled = true;
  try {
    const response = await fetch('/api/v1/dependencies/scan', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) });
    if (![202, 429].includes(response.status)) throw new Error();
    const result = await response.json();
    // Discard an older GET before showing the newly accepted job status.
    await pending;
    launching = false;
    scanControls(result.scan);
    latest = { ...latest, scan: result.scan };
    void reload();
  } catch {
    launching = false;
    await reload();
    $('dependency-scan-status').textContent = 'Could not confirm scan startup. Reload status before retrying; no transaction was requested.';
  }
}
$('reload-dependencies').addEventListener('click', reload);
$('run-dependencies').addEventListener('click', startScan);
// Expire observations even while a refresh is stalled or the tab was suspended.
setInterval(() => {
  if (performance.now() >= expires && latest?.snapshotFresh) {
    renderDependencies({ ...latest, state: 'STALE_SNAPSHOT', snapshotFresh: false }, false);
  }
  if (latest?.scan?.enabled && latest.scan.state !== 'RUNNING' && !launching && performance.now() >= cooldown) {
    $('run-dependencies').disabled = false;
  }
}, 1000);
setInterval(() => { if (!document.hidden) void reload(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void reload(); });
void reload();
