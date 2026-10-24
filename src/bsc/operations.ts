import type { Hash } from "viem";
import type { JobStore } from "./store.js";

type Outcome = { state: "PENDING" } | { job: { state: string } | undefined };

// Only inspect hashes already saved by an authenticated request. This worker
// cannot create plans, discover replacement transactions, sign or broadcast.
export function pendingMonitor(store: JobStore, verify: (jobId: string, hash: Hash) => Promise<Outcome>, clock = Date.now) {
  let running: Promise<void> | undefined;
  let checkedAt: string | null = null, errorCount = 0;
  const firstSeen = new Map<string, number>();
  function summary() {
    const pending = store.view.jobs.filter(job => job.state === "VERIFYING" && !job.receipt && job.transactionHash);
    const now = clock();
    const since = (id: string) => firstSeen.get(id) ?? now;
    return { enabled: true, checkedAt, errorCount, pending: pending.length,
      stalePending: pending.filter(job => now - since(job.id) >= 10 * 60000).map(job => ({ jobId: job.id, transactionHash: job.transactionHash })),
      frozen: store.view.frozen, broadcastsTransactions: false };
  }
  async function inspect() {
    errorCount = 0;
    const jobs = store.view.jobs.filter(job => job.state === "VERIFYING" && !job.receipt && job.transactionHash);
    const ids = new Set(jobs.map(job => job.id));
    for (const id of firstSeen.keys()) if (!ids.has(id)) firstSeen.delete(id);
    for (const job of jobs) {
      if (!firstSeen.has(job.id)) firstSeen.set(job.id, clock());
      try { await verify(job.id, job.transactionHash!); }
      catch { errorCount++; } // RPC failures never become successful or failed proofs.
    }
    checkedAt = new Date(clock()).toISOString();
  }
  return { summary, idle: () => running, run() {
    if (!running) running = inspect().finally(() => { running = undefined; });
    return running;
  } };
}
