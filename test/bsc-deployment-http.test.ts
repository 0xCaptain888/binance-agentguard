import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { type PublicClient } from "viem";
import { startDeploymentServer } from "../src/bsc/deployment-server.js";
import { parseDeploymentConfig } from "../src/bsc/deployment.js";

// Transport-only tests: mocked read-only chain clients, no signing or BSC activity.
const config = parseDeploymentConfig({ owner: "0x0000000000000000000000000000000000000001", operator: "0x0000000000000000000000000000000000000002",
  token0: "0x0000000000000000000000000000000000000003", token1: "0x0000000000000000000000000000000000000004",
  router: "0x0000000000000000000000000000000000000005", feed0: "0x0000000000000000000000000000000000000006", feed1: "0x0000000000000000000000000000000000000007",
  policy: { maxActionUsd: "10", maxDailyUsd: "25", targetToken0Bps: 5000, maxSlippageBps: 100, cooldownSeconds: 300, maxOracleAge: 3600 }, publicBaseUrl: "https://agent.example" });
const client = { getChainId: async () => 97, getBlockNumber: async () => 1n, getCode: async () => "0x01", call: async () => ({ data: "0x01" }),
  getTransactionReceipt: async () => { throw new Error("https://secret-rpc.invalid/private-api-key"); } } as unknown as PublicClient;
let app: Awaited<ReturnType<typeof startDeploymentServer>>;
before(async () => { app = await startDeploymentServer(client, client, config, 0); });
after(async () => { await app?.close(); });
const post = (body: string, origin = app.origin) => fetch(`${app.origin}/api/v1/deployment/verify`, {
  method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body
});
test("deployment console serves unsigned data and blocks hostile origins, bad bodies and arbitrary paths", async () => {
  const response = await fetch(`${app.origin}/bsc/deploy/`);
  assert.equal(response.status, 200); assert.match(response.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.match(await response.text(), /Review & deploy in wallet/);
  const prepared = await (await fetch(`${app.origin}/api/v1/deployment`)).json() as any;
  assert.equal(prepared.transaction.from, config.owner); assert.equal(prepared.transaction.to, undefined);
  assert.equal(prepared.transaction.chainId, "0x61"); assert.equal(prepared.transaction.value, "0x0");
  const registration = await (await fetch(`${app.origin}/api/v1/registration`)).json() as any;
  assert.equal(registration.status, "UNSIGNED_ERC8004_REGISTRATION");
  assert.equal(registration.agentURI, "https://agent.example/.well-known/agent-registration.json");
  assert.equal(registration.transaction.value, "0x0");
  assert.equal((await post("{}", "https://attacker.invalid")).status, 403);
  const check = (body: string, origin = app.origin) => fetch(`${app.origin}/api/v1/deployment/preflight`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body });
  assert.equal((await check("{}", "https://attacker.invalid")).status, 403);
  assert.equal((await check('{"owner":"override"}')).status, 400);
  const unavailable = await check("{}");
  assert.equal(unavailable.status, 503); assert.doesNotMatch(await unavailable.text(), /private-api-key|secret-rpc|READY/);
  assert.equal((await post("[")).status, 400);
  const registrationVerify = await fetch(`${app.origin}/api/v1/registration/verify`, {
    method: "POST", headers: { Origin: app.origin, "Content-Type": "application/json" }, body: JSON.stringify({ hash: `0x${"ab".repeat(32)}` })
  });
  assert.equal(registrationVerify.status, 503);
  assert.equal((await post(JSON.stringify({ hash: "bad" }))).status, 400);
  assert.equal((await post(JSON.stringify({ hash: "x".repeat(1100) }))).status, 413);
  assert.equal((await fetch(`${app.origin}/.env`)).status, 404);
});
test("deployment verifier transport errors never leak RPC keys or return successful evidence", async () => {
  const response = await post(JSON.stringify({ hash: `0x${"ab".repeat(32)}` }));
  assert.equal(response.status, 503);
  const body = await response.text(); assert.doesNotMatch(body, /secret-rpc|private-api-key|VERIFIED/);
  assert.equal((await fetch(`${app.origin}/api/v1/send`, { method: "POST" })).status, 405);
});
