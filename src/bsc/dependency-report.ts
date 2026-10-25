import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { json } from "./rebalancer.js";

export const failedDependencyReport = () => ({ schemaVersion: 2, state: "RPC_UNAVAILABLE", checkedAt: new Date().toISOString(),
  campaignProof: false, financialTransactionCreated: false, deploymentReady: false });

// Both terminal and web scans replace complete reports, including failures.
// Fresh private files also repair permissive modes on older report files.
export async function saveDependencyReport(path: string, report: unknown) {
  const contents = json(report) + "\n";
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}
