import { testnetClients } from "./deployment.js";
import { probeDependencies } from "./dependency-probe.js";
import { failedDependencyReport, saveDependencyReport } from "./dependency-report.js";
import { dependencySummary, readDependencySummary } from "./dependency-status.js";
import { json } from "./rebalancer.js";

export async function runDependencyProbe(rpcUrl: string | undefined, verifierRpcUrl: string | undefined, signal: AbortSignal) {
  signal.throwIfAborted();
  const { client, verifier } = await testnetClients(rpcUrl, verifierRpcUrl, signal);
  const report = await probeDependencies(client, verifier);
  signal.throwIfAborted();
  return report;
}

export class DependencyScanner {
  private state: "IDLE" | "RUNNING" | "SUCCEEDED" | "FAILED" = "IDLE";
  private startedAt?: string;
  private finishedAt?: string;
  private nextStart = 0;
  private active?: Promise<void>;
  private controller?: AbortController;
  private failedReport?: ReturnType<typeof failedDependencyReport>;
  private closed = false;
  constructor(private readonly options: { enabled: boolean; path: string; run: (signal: AbortSignal) => Promise<unknown>;
    now?: () => number; cooldownMs?: number; timeoutMs?: number }) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  status() {
    return { enabled: this.options.enabled && !this.closed, state: this.state, startedAt: this.startedAt, finishedAt: this.finishedAt,
      retryAfterSeconds: Math.max(0, Math.ceil((this.nextStart - this.now()) / 1000)), financialTransactionCreated: false };
  }
  start(): { code: number; scan: ReturnType<DependencyScanner["status"]> } {
    if (!this.options.enabled || this.closed) return { code: 403, scan: this.status() };
    if (this.active) return { code: 202, scan: this.status() };
    if (this.now() < this.nextStart) return { code: 429, scan: this.status() };
    this.state = "RUNNING"; this.startedAt = new Date(this.now()).toISOString(); this.finishedAt = undefined;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const timer = setTimeout(() => this.controller?.abort(), this.options.timeoutMs ?? 120000);
    this.active = (async () => {
      try {
        const report = await this.options.run(signal);
        signal.throwIfAborted();
        await saveDependencyReport(this.options.path, report);
        this.failedReport = undefined;
        const summary = dependencySummary(JSON.parse(json(report)), this.now());
        this.state = ["UNAVAILABLE", "RPC_VERIFICATION_FAILED", "INCOMPLETE", "STALE_SNAPSHOT"].includes(summary.state) ? "FAILED" : "SUCCEEDED";
      } catch {
        this.failedReport = failedDependencyReport();
        // Keep a failed result in memory even if disk is unavailable: never serve
        // the old successful snapshot as the result of a failed refresh.
        await saveDependencyReport(this.options.path, this.failedReport).catch(() => {});
        this.state = "FAILED";
      } finally {
        clearTimeout(timer);
        this.finishedAt = new Date(this.now()).toISOString();
        this.nextStart = this.now() + (this.options.cooldownMs ?? 60000);
        this.active = undefined; this.controller = undefined;
      }
    })();
    return { code: 202, scan: this.status() };
  }
  async summary() {
    return { ...(this.failedReport ? dependencySummary(this.failedReport, this.now()) : await readDependencySummary(this.options.path)),
      scan: this.status() };
  }
  async idle() { await this.active; }
  async close() { this.closed = true; this.controller?.abort(); await this.idle(); }
}
