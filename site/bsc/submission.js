// Public transaction metadata only. Never persist sessions, signatures or keys.
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const integerPattern = /^(0|[1-9]\d*)$/;

export function submissionGuard(storage, chainId, vault, lock) {
  if (chainId !== 97 || typeof vault !== 'string' || !addressPattern.test(vault)) throw new Error('Invalid submission scope.');
  const key = `agentguard-rebalance:${chainId}:${vault.toLowerCase()}`;
  let memory;
  function read() {
    let raw;
    try { raw = storage.getItem(key); }
    catch { throw new Error('Browser storage unavailable. Enable storage before requesting a wallet transaction.'); }
    if (raw === null) return undefined;
    let value;
    try { value = JSON.parse(raw); } catch { throw new Error('Stored submission is unreadable. Inspect wallet activity before changing browser storage.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || value.chainId !== chainId ||
      typeof value.vault !== 'string' || value.vault.toLowerCase() !== vault.toLowerCase() ||
      typeof value.jobId !== 'string' || !value.jobId || typeof value.planId !== 'string' || !hashPattern.test(value.planId) ||
      typeof value.account !== 'string' || !addressPattern.test(value.account) ||
      typeof value.nonce !== 'string' || !integerPattern.test(value.nonce) || typeof value.deadline !== 'string' || !integerPattern.test(value.deadline) ||
      typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt)) ||
      (value.hash !== undefined && !hashPattern.test(value.hash))) throw new Error('Stored submission is invalid. Inspect wallet activity before changing browser storage.');
    return memory?.planId === value.planId && memory?.hash ? memory : value;
  }
  function write(value) {
    memory = value;
    try {
      storage.setItem(key, JSON.stringify(value));
      if (storage.getItem(key) !== JSON.stringify(value)) throw new Error();
    } catch { throw new Error('Could not persist submission status. Check wallet activity before retrying.'); }
  }
  function clear() { storage.removeItem(key); memory = undefined; }
  return {
    key, read,
    async submit(job, account, send) {
      if (typeof lock !== 'function') throw new Error('This browser cannot lock wallet submissions across tabs. Use a current browser with Web Locks support.');
      return lock(key, async () => {
        if (read()) throw new Error('A previous wallet request is unresolved. Resume verification instead of sending again.');
        if (!job || typeof job.id !== 'string' || !job.id || !hashPattern.test(job.plan?.id) || !integerPattern.test(String(job.plan.nonce)) ||
          !integerPattern.test(String(job.plan.deadline)) || !addressPattern.test(account) ||
          job.plan.chainId !== chainId || typeof job.plan.vault !== 'string' || job.plan.vault.toLowerCase() !== vault.toLowerCase()) throw new Error('Invalid submitted plan.');
        const marker = { version: 1, chainId, vault, account, jobId: job.id, planId: job.plan.id,
          nonce: String(job.plan.nonce), deadline: String(job.plan.deadline), startedAt: new Date().toISOString() };
        write(marker); // Must succeed before opening the wallet.
        let hash;
        try { hash = await send(); }
        catch (error) {
          if (Number(error?.code) === 4001) clear(); // Explicit rejection is the only immediate retry path.
          throw error;
        }
        if (!hashPattern.test(hash)) throw new Error('Wallet returned no usable hash. Inspect wallet activity; sending again is blocked.');
        write({ ...marker, hash });
        return hash;
      });
    },
    rememberHash(job, hash) {
      const marker = read();
      if (!marker) return;
      if (marker.jobId !== job.id || marker.planId !== job.plan.id || !hashPattern.test(hash) ||
        (marker.hash && marker.hash.toLowerCase() !== hash.toLowerCase())) throw new Error('Use the transaction hash for the original submitted plan.');
      write({ ...marker, hash });
    },
    acceptProof(job) {
      const marker = read();
      if (!marker) return;
      const receipt = job.receipt;
      if (job.id !== marker.jobId || job.plan.id !== marker.planId || job.state !== 'VERIFIED' ||
        receipt?.state !== 'VERIFIED' || receipt.planId !== marker.planId || receipt.chainId !== chainId ||
        !marker.hash || receipt.transactionHash?.toLowerCase() !== marker.hash.toLowerCase() ||
        !receipt.checks || !Object.keys(receipt.checks).length || !Object.values(receipt.checks).every(value => value === true)) return;
      clear();
    },
    async releaseExpired(snapshot) {
      if (typeof lock !== 'function') throw new Error('Cross-tab locking is unavailable. Close the wallet request before recovery.');
      return lock(key, async () => {
        const marker = read();
        if (!marker) return;
        if (snapshot.chainId !== chainId || snapshot.vault.toLowerCase() !== vault.toLowerCase() ||
          (BigInt(snapshot.nonce) <= BigInt(marker.nonce) && BigInt(snapshot.blockTimestamp) <= BigInt(marker.deadline)))
          throw new Error('The original transaction can still execute. Wait for the on-chain deadline or verify its hash.');
        clear();
        return { state: 'RELEASED_NOT_VERIFIED', campaignProof: false };
      });
    }
  };
}
