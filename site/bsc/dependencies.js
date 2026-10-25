const $ = id => document.getElementById(id);
const messages = {
  NOT_CHECKED: 'No saved testnet scan yet. Run the command below; no wallet or operator is required.',
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
export function renderDependencies(report) {
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
}
async function reload() {
  $('reload-dependencies').disabled = true;
  try {
    const response = await fetch('/api/v1/dependencies', { cache: 'no-store' });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error();
    renderDependencies(await response.json());
  } catch {
    renderDependencies({ state: 'UNAVAILABLE' });
    $('dependency-summary').textContent = 'Open the running local service to read its saved scan. This static preview cannot inspect your local RPC configuration.';
  } finally { $('reload-dependencies').disabled = false; }
}
$('reload-dependencies').addEventListener('click', reload);
void reload();
