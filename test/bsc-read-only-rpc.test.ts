import test from "node:test";
import assert from "node:assert/strict";
import { readOnlyBatch, startReadOnlyRpc } from "../src/bsc/read-only-rpc.js";

test("fork upstream rejects writes, mixed batches and malformed calls before forwarding", async () => {
  const read = { jsonrpc: "2.0", id: 1, method: "eth_getStorageAt", params: ["0x01", "0x00", "latest"] };
  assert.equal(readOnlyBatch(read), true);
  assert.equal(readOnlyBatch({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }), true);
  assert.equal(readOnlyBatch({ ...read, method: "eth_getAccountInfo" }), true);
  assert.equal(readOnlyBatch([read, { ...read, id: 2, method: "eth_chainId", params: [] }]), true);
  for (const method of ["eth_sendTransaction", "eth_sendRawTransaction", "eth_sign", "personal_unlockAccount",
    "anvil_setCode", "anvil_setStorageAt", "debug_setHead", "eth_estimateGas"]) {
    assert.equal(readOnlyBatch({ ...read, method }), false);
    assert.equal(readOnlyBatch([read, { ...read, method }]), false);
  }
  for (const value of [null, [], {}, [read, null], { ...read, jsonrpc: "1.0" }, { ...read, params: null }, Array(51).fill(read)])
    assert.equal(readOnlyBatch(value), false);
  // No network access is needed: invalid requests must never contact this upstream.
  const relay = await startReadOnlyRpc("https://invalid.invalid");
  try {
    const response = await fetch(relay.url, { method: "POST",
      body: JSON.stringify([read, { ...read, method: "eth_sendRawTransaction" }]) });
    assert.equal(response.status, 403);
    assert.equal(relay.counts.forwardedReads, 0); assert.equal(relay.counts.deniedRequests, 1);
  } finally { await relay.close(); }
  await assert.rejects(() => startReadOnlyRpc("http://127.0.0.1"), /HTTPS/);
});

test("fork relay retries read-only transport failures and preserves RPC errors without exposing endpoint credentials", async () => {
  const original = globalThis.fetch;
  let attempts = 0;
  let offline = false;
  const requests: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    if (input instanceof URL && input.hostname === "fork-fixture.invalid") {
      requests.push(JSON.parse(String(init?.body)));
      assert.equal(init?.redirect, "error");
      attempts++;
      if (offline) throw new Error("private-test-key must not be included in the response");
      return attempts === 1 ? new Response("", { status: 429 }) :
        Response.json({ jsonrpc: "2.0", id: 7, error: { code: -32000, message: "historical state unavailable" } });
    }
    return original(input, init);
  };
  const relay = await startReadOnlyRpc("https://fork-fixture.invalid/private-test-key");
  try {
    const request = { jsonrpc: "2.0", id: 7, method: "eth_getCode", params: ["0x01", "0x20"] };
    const response = await original(relay.url, { method: "POST", body: JSON.stringify(request) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).error.message, "historical state unavailable");
    assert.deepEqual(requests, [request, request]);
    assert.equal(relay.counts.retries, 1);
    assert.equal(relay.counts.forwardedReads, 1);
    assert.equal(relay.counts.upstreamFailures, 0);
    assert.equal(relay.lastFailure(), "HTTP 429 (eth_getCode)");
    assert.ok(!relay.lastFailure().includes("private-test-key"));
    offline = true;
    const failed = await original(relay.url, { method: "POST", body: JSON.stringify(request) });
    assert.equal(failed.status, 502);
    assert.equal((await failed.json()).error, "Read-only upstream unavailable");
    assert.equal(attempts, 5);
    assert.equal(relay.counts.retries, 3);
    assert.equal(relay.counts.upstreamFailures, 1);
  } finally { await relay.close(); globalThis.fetch = original; }
});
