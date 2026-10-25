import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import type { PublicClient } from "viem";
import { startControlledServer } from "../src/bsc/controlled-server.js";
import { controlledFixture, type ControlledFixture } from "./support/controlled-fixture.js";

// Actual isolated EVM + HTTP transport. No public chain or wallet signatures.
let f: ControlledFixture;
before(async () => { f = await controlledFixture(); });
after(async () => { await f?.close(); });
async function server(run: (app: Awaited<ReturnType<typeof startControlledServer>>, directory: string) => Promise<void>, verifier?: PublicClient) {
  const directory = await mkdtemp(join(tmpdir(), "agentguard-controlled-"));
  const app = await startControlledServer(f.client, verifier ?? f.client, f.owner, 0,
    { config: join(directory, "config.json"), evidence: directory });
  try { await run(app, directory); }
  finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
}
const post = (origin: string, action: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${origin}/api/v1/controlled/${action}`, {
  method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body)
});
test("controlled HTTP only serves allowlisted assets and rejects hostile origins, headers and oversized input", async () => {
  await server(async ({ origin }) => {
    const page = await fetch(`${origin}/bsc/setup/`);
    assert.equal(page.status, 200); assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.match(await page.text(), /synthetic|Synthetic/);
    const state = await (await fetch(`${origin}/api/v1/controlled`)).json() as any;
    assert.equal(state.owner, f.owner); assert.equal(state.marketEvidence, false); assert.equal(state.campaignProof, false);
    assert.equal((await fetch(`${origin}/.env`)).status, 404);
    // Fetch implementations may replace Host with the URL authority. Use the
    // native transport so this assertion actually sends the hostile header.
    const hostileHostStatus = await new Promise<number>((resolve, reject) => {
      const req = request(`${origin}/api/v1/controlled`, { headers: { Host: "attacker.invalid" } }, res => {
        res.resume(); res.once("end", () => resolve(res.statusCode!));
      });
      req.once("error", reject); req.end();
    });
    assert.equal(hostileHostStatus, 403);
    assert.equal((await post(origin, "prepare", {}, { Origin: "https://attacker.invalid" })).status, 403);
    assert.equal((await post(origin, "prepare", {}, { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await post(origin, "prepare", {}, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await post(origin, "prepare", { owner: f.stranger })).status, 400);
    assert.equal((await post(origin, "verify", { hash: "x".repeat(1100) })).status, 413);
    assert.equal((await post(origin, "verify", { hash: "bad" })).status, 400);
    assert.equal((await post(origin, "verify", { hash: `0x${"ab".repeat(32)}`, nonce: -1 })).status, 400);
    assert.equal((await post(origin, "config", { operator: f.owner, mode: "OWNER_MANUAL" })).status, 409);
    assert.equal((await fetch(`${origin}/api/v1/controlled/send`, { method: "POST" })).status, 405);
  });
});
test("controlled config and refresh are bound to the tab's verified environment and never overwrite config", async () => {
  const first = await f.deploy(), second = await f.deploy(); await f.rpc("evm_mine");
  await server(async ({ origin }, directory) => {
    const nonce = await f.client.getTransactionCount({ address: f.owner });
    const preparation = await post(origin, "prepare", {});
    assert.equal(preparation.status, 200);
    const unsigned = await preparation.json() as any;
    assert.equal(unsigned.independentChecked, true); assert.equal(unsigned.financialTransactionCreated, false);
    assert.equal((await post(origin, "verify", { hash: first.hash })).status, 200);
    const firstTx = await f.client.getTransaction({ hash: first.hash });
    const nonceBound = await post(origin, "verify", { hash: first.hash, nonce: firstTx.nonce + 1 });
    assert.equal(nonceBound.status, 200);
    assert.equal((await nonceBound.json() as any).primary.checks.requestNonce, false);
    assert.equal((await post(origin, "verify", { hash: second.hash })).status, 200);
    assert.equal((await post(origin, "refresh", { environmentHash: first.hash })).status, 409);
    assert.equal((await post(origin, "config", { environmentHash: first.hash, operator: f.owner, mode: "OWNER_MANUAL" })).status, 409);
    assert.equal((await post(origin, "refresh", {})).status, 409);
    const refresh = await post(origin, "refresh", { environmentHash: second.hash });
    assert.equal(refresh.status, 200); assert.equal((await refresh.json() as any).transactions.length, 2);
    const body = { environmentHash: second.hash, operator: f.owner, mode: "OWNER_MANUAL" };
    assert.equal((await post(origin, "config", { ...body, mode: "DELEGATED" })).status, 400);
    const saved = await post(origin, "config", body);
    assert.equal(saved.status, 201); assert.equal((await saved.json() as any).financialTransactionCreated, false);
    const filename = join(directory, "config.json"), config = await readFile(filename, "utf8");
    assert.equal(JSON.parse(config).controlledDeploymentHash, second.hash);
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    assert.equal((await post(origin, "config", body)).status, 409);
    assert.equal(await readFile(filename, "utf8"), config);
    assert.equal(await f.client.getTransactionCount({ address: f.owner }), nonce);
  });
});
test("controlled preparation fails closed when the independent RPC disagrees on the anchor, balance or gas", async () => {
  const cases: Array<[string, PublicClient]> = [
    ["anchor", new Proxy(f.client, { get(target, key) {
      if (key === "getBlock") return async (args?: any) => {
        const block = await f.client.getBlock(args);
        return { ...block, hash: `0x${"ab".repeat(32)}` };
      };
      return Reflect.get(target, key);
    } })],
    ["balance", new Proxy(f.client, { get(target, key) {
      if (key === "getBalance") return async (args: any) => (await f.client.getBalance(args)) + 1n;
      return Reflect.get(target, key);
    } })],
    ["gas", new Proxy(f.client, { get(target, key) {
      if (key === "estimateGas") return async (args: any) => (await f.client.estimateGas(args)) + 1n;
      return Reflect.get(target, key);
    } })]
  ];
  for (const [kind, verifier] of cases) {
    await server(async ({ origin }) => {
      const response = await post(origin, "prepare", {});
      assert.equal(response.status, 409, kind);
      assert.doesNotMatch(await response.text(), /VERIFIED|private-api-key/);
    }, verifier);
  }
});
test("controlled service fails closed without leaking private RPC details and applies a request limit", async () => {
  const unavailable = new Proxy(f.client, { get(target, key) {
    return key === "getBlock" ? async () => { throw new Error("https://private-rpc.invalid/private-api-key"); } : Reflect.get(target, key);
  } });
  await server(async ({ origin }) => {
    const response = await post(origin, "prepare", {});
    assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /private-api-key|private-rpc|VERIFIED/);
    for (let i = 0; i < 19; i++) assert.equal((await post(origin, "verify", { hash: "bad" })).status, 400);
    assert.equal((await post(origin, "verify", { hash: "bad" })).status, 429);
  }, unavailable);
});
