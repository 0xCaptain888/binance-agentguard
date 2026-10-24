import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { json, type Plan, type Verification } from "./rebalancer.js";

export type Job = { id: string; createdAt: string; state: "AWAITING_SIGNATURE" | "VERIFYING" | "VERIFIED" | "FROZEN";
  plan: Plan; transactionHash?: import("viem").Hash; receipt?: Verification };
export type Journal = { version: 1; frozen: boolean; jobs: Job[] };
const bigintFields = new Set(["amountIn", "minAmountOut", "quotedAmountOut", "notionalUsd", "nonce", "deadline",
  "snapshotBlock", "driftBeforeBps", "expectedDriftAfterBps", "blockNumber", "confirmations"]);

// One process per journal. Atomic replacement protects against partial writes; this is not
// a distributed queue. A shared durable volume is required when deployed on a persistent host.
export class JobStore {
  private tail: Promise<unknown> = Promise.resolve();
  private data: Journal = { version: 1, frozen: false, jobs: [] };
  constructor(private readonly path: string) {}
  async load() {
    try {
      const data = JSON.parse(await readFile(this.path, "utf8"), (key, value) =>
        bigintFields.has(key) && typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : value);
      if (data.version !== 1 || typeof data.frozen !== "boolean" || !Array.isArray(data.jobs)) throw new Error("Invalid journal");
      this.data = data;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  get view(): Journal { return structuredClone(this.data); }
  async change(update: (data: Journal) => void) {
    const next = this.tail.then(async () => {
      const data = structuredClone(this.data);
      update(data);
      if (data.jobs.length > 500) throw new Error("Journal capacity reached; archive verified jobs before continuing");
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, json(data), { flag: "wx", mode: 0o600 });
      await rename(temporary, this.path);
      this.data = data;
    });
    this.tail = next.catch(() => {});
    await next;
  }
}
