import { open, mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

// Fail closed on stale locks after a crash: an operator must check the old
// process/container is stopped before removing its lock. Never steal by PID.
export async function claimJournal(path: string) {
  const lockPath = `${resolve(path)}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  const token = randomUUID(), handle = await open(lockPath, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify({ token, pid: process.pid, startedAt: new Date().toISOString() })); }
  catch (error) { await handle.close(); await unlink(lockPath); throw error; }
  await handle.close();
  return async () => {
    // Do not remove a lock that an operator replaced while this process ran.
    if (JSON.parse(await readFile(lockPath, "utf8")).token !== token) throw new Error("Journal lock ownership changed");
    await unlink(lockPath);
  };
}
