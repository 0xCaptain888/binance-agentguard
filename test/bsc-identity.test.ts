import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { type Address, type Hash, type PublicClient } from "viem";
import { startLocalFixture, type LocalFixture } from "../src/bsc/local.js";
import { prepareRegistration, registrationCard, registrationTransaction, verifyRegistration } from "../src/bsc/identity.js";

const baseUrl = "https://agentguard.example";
let f: LocalFixture, registry: Address;
before(async () => {
  f = await startLocalFixture();
  const hash = await f.wallet.deployContract({ ...f.artifacts.TestIdentityRegistry, account: f.owner });
  const receipt = await f.wait(hash);
  if (!receipt.contractAddress) throw new Error("Registry fixture deployment failed");
  registry = receipt.contractAddress;
});
after(async () => { await f?.close(); });
function override(client: PublicClient, methods: Record<string, unknown>): PublicClient { return new Proxy(client, {
  get(target, key) { return Object.hasOwn(methods, key) ? methods[key as string] : Reflect.get(target, key); }
}); }
async function register(uriBase = baseUrl) {
  const prepared = await prepareRegistration(f.client, uriBase, f.owner, 31337, registry);
  const hash = await f.wallet.sendTransaction({ account: f.owner, to: registry, data: prepared.transaction.data, value: 0n });
  await f.wait(hash); return { hash, prepared };
}

test("registration preparation validates a public HTTPS origin and simulates without sending", async () => {
  const nonce = await f.client.getTransactionCount({ address: f.owner });
  const prepared = await prepareRegistration(f.client, baseUrl, f.owner, 31337, registry);
  assert.equal(prepared.transaction.to, registry); assert.equal(prepared.transaction.from, f.owner);
  assert.equal(prepared.transaction.chainId, "0x7a69"); assert.equal(prepared.transaction.value, "0x0");
  assert.equal(await f.client.getTransactionCount({ address: f.owner }), nonce);
  for (const url of ["http://agentguard.example", "https://localhost", "https://agentguard.example/path", "https://user:pass@agentguard.example"])
    await assert.rejects(() => prepareRegistration(f.client, url, f.owner, 31337, registry));
  await assert.rejects(() => prepareRegistration(f.client, baseUrl, f.owner, 31337, f.stranger));
  await assert.rejects(() => prepareRegistration(f.client, baseUrl, f.owner, 97, registry));
});

test("a real registry transaction is bound to sender, calldata, event, historical state and current state", async () => {
  const { hash } = await register(); await f.rpc("evm_mine");
  const proof = await verifyRegistration(f.client, f.client, baseUrl, f.owner, hash, 31337, registry);
  assert.equal(proof.state, "VERIFIED");
  if (proof.state !== "VERIFIED") throw new Error(JSON.stringify(proof));
  assert.equal(proof.agentId, "0"); assert.ok(Object.values(proof.checks).every(Boolean));
  assert.match(proof.evidenceHash, /^sha256:[0-9a-f]{64}$/);
  const card = registrationCard(baseUrl, { agentId: proof.agentId!, owner: f.owner, transactionHash: hash, evidenceHash: proof.evidenceHash });
  assert.equal(card.active, true); assert.equal(card.status, "REGISTERED_NOT_MARKETPLACE_VERIFIED");
  assert.equal(card.marketplace.listed, false);
});

test("unknown and one-confirmation registrations remain pending", async () => {
  const { hash } = await register();
  assert.equal((await verifyRegistration(f.client, f.client, baseUrl, f.owner, hash, 31337, registry)).state, "PENDING");
  assert.equal((await verifyRegistration(f.client, f.client, baseUrl, f.owner, `0x${"87".repeat(32)}`, 31337, registry)).state, "PENDING");
});

test("wrong URI and changed current identity state cannot be advertised as verified", async () => {
  const wrong = await register("https://wrong.example"); await f.rpc("evm_mine");
  const wrongProof = await verifyRegistration(f.client, f.client, baseUrl, f.owner, wrong.hash, 31337, registry);
  assert.equal(wrongProof.state, "MISMATCH");
  if (wrongProof.state === "MISMATCH") { assert.equal(wrongProof.checks.exactCalldata, false); assert.equal(wrongProof.checks.eventUri, false); }

  const good = await register(); await f.rpc("evm_mine");
  const goodProof = await verifyRegistration(f.client, f.client, baseUrl, f.owner, good.hash, 31337, registry);
  if (goodProof.state !== "VERIFIED") throw new Error("Expected verified registration");
  await f.write(registry, f.artifacts.TestIdentityRegistry.abi, "setURI", [BigInt(goodProof.agentId!), "https://changed.example"]);
  const changed = await verifyRegistration(f.client, f.client, baseUrl, f.owner, good.hash, 31337, registry);
  assert.equal(changed.state, "MISMATCH"); if (changed.state === "MISMATCH") assert.equal(changed.checks.currentUri, false);
});

test("independent RPC disagreement, a reorg, wrong owner and transport failures never verify", async () => {
  const { hash } = await register(); await f.rpc("evm_mine");
  const disagree = override(f.client, { getBlock: async (args: any) => ({ ...(await f.client.getBlock(args)), hash: `0x${"ff".repeat(32)}` as Hash }) });
  const proof = await verifyRegistration(disagree, f.client, baseUrl, f.owner, hash, 31337, registry);
  assert.equal(proof.state, "MISMATCH"); if (proof.state === "MISMATCH") assert.equal(proof.checks.independentBlock, false);
  const wrongOwner = await verifyRegistration(f.client, f.client, baseUrl, f.stranger, hash, 31337, registry);
  assert.equal(wrongOwner.state, "MISMATCH");
  await assert.rejects(() => verifyRegistration(override(f.client, { getTransactionReceipt: async () => { throw new Error("RPC offline"); } }),
    f.client, baseUrl, f.owner, hash, 31337, registry), /RPC offline/);
  await assert.rejects(() => verifyRegistration(f.client, f.client, baseUrl, f.owner, hash, 97, registry), /Wrong registration/);
});

test("registration transaction helper encodes the official BSC testnet request without signing", () => {
  const tx = registrationTransaction(baseUrl, f.owner);
  assert.equal(tx.chainId, "0x61"); assert.equal(tx.from, f.owner); assert.equal(tx.value, "0x0");
  assert.match(tx.data, /^0x[0-9a-f]+$/);
});
