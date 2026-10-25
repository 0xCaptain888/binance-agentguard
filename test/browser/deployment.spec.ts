import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

// Browser interaction tests use a stub wallet/RPC, never real signatures or BSC proof.
const owner = "0x0000000000000000000000000000000000000001", hash = `0x${"ab".repeat(32)}`;
const preflight = { state: "READY", sameBlock: true, matchingReads: true, stillCanonical: true,
  primary: { blockNumber: "100", checks: [{ name: "owner_test_gas", passed: true, detail: "STUB" }], gas: { ownerBalance: "1000000000000000000", estimate: "1000000", gasPrice: "1000000000" } },
  independent: { checks: [{ name: "owner_test_gas", passed: true, detail: "STUB" }] } };
async function setup(page: Page) {
  const [html, script] = await Promise.all([readFile("site/bsc/deploy/index.html", "utf8"), readFile("site/bsc/deploy/app.js", "utf8")]);
  await page.route("**/bsc/deploy/", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.route("**/bsc/deploy/app.js", route => route.fulfill({ contentType: "text/javascript", body: script }));
  await page.route("**/api/v1/deployment/preflight", route => route.fulfill({ json: preflight }));
  await page.route("**/api/v1/deployment", route => route.fulfill({ json: {
    chainId: 97, status: "UNSIGNED_TESTNET_DEPLOYMENT", initCodeHash: `0x${"12".repeat(32)}`, note: "STUB TEST CONFIGURATION",
    config: { owner, operator: owner, token0: owner, token1: owner, router: owner, feed0: owner, feed1: owner,
      policy: { maxActionUsd: "10000000000000000000", maxDailyUsd: "25000000000000000000", targetToken0Bps: 5000, maxSlippageBps: 100, cooldownSeconds: 300, maxOracleAge: 3600 } },
    transaction: { from: owner, data: "0x1234", value: "0x0", chainId: "0x61" }
  } }));
  await page.route("**/api/v1/registration", route => route.fulfill({ json: {
    status: "UNSIGNED_ERC8004_REGISTRATION", chainId: 97,
    registry: "0x0000000000000000000000000000000000000800", owner,
    agentURI: "https://agentguard.example/agent.json", simulatedAtBlock: "100",
    transaction: { from: owner, to: "0x0000000000000000000000000000000000000800", data: "0xfeed", value: "0x0", chainId: "0x61" }
  } }));
  await page.addInitScript(({ owner, hash }) => {
    const w = window as any; w.walletStub = { chain: "0x61", account: owner, error: 0, sends: [] };
    w.okxwallet = { isOkxWallet: true, on() {}, removeListener() {}, async request(input: any) {
      if (input.method === "eth_chainId") return w.walletStub.chain;
      if (["eth_requestAccounts", "eth_accounts"].includes(input.method)) return [w.walletStub.account];
      if (input.method === "eth_sendTransaction") {
        w.walletStub.sends.push(input.params[0]);
        if (w.walletStub.error) throw Object.assign(new Error("Wallet interrupted"), { code: w.walletStub.error });
        return hash;
      }
      throw new Error(`Unexpected wallet call: ${input.method}`);
    } };
  }, { owner, hash });
  await page.goto("/bsc/deploy/"); await expect(page.locator("#connect")).toBeEnabled();
  await expect(page.locator("#preflight-state")).toHaveText("READY");
}
async function ready(page: Page) {
  await page.locator("#connect").click(); await page.locator("#review-addresses").check(); await page.locator("#review-policy").check();
  await expect(page.locator("#deploy")).toBeEnabled();
}
test("OKX is used when MetaMask is the injected default", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const w = window as any, okx = w.okxwallet;
    w.metamaskCalls = 0;
    const metamask = { isMetaMask: true, request() { w.metamaskCalls++; throw new Error('Wrong wallet'); } };
    w.ethereum = metamask;
    for (const [rdns, provider] of [['com.okex.wallet', okx], ['io.metamask', metamask]]) {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: rdns, name: rdns, rdns }, provider } }));
    }
  });
  await ready(page);
  await expect(page.locator('#connect')).toContainText('OKX');
  expect(await page.evaluate(() => (window as any).metamaskCalls)).toBe(0);
});
test("missing OKX shows instructions without requesting MetaMask accounts", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const w = window as any; w.metamaskCalls = 0;
    delete w.okxwallet;
    w.ethereum = { isMetaMask: true, request() { w.metamaskCalls++; } };
  });
  await page.locator('#connect').click();
  await expect(page.locator('#notice')).toContainText('OKX Wallet not detected');
  await expect(page.locator('#deploy')).toBeDisabled();
  expect(await page.evaluate(() => (window as any).metamaskCalls)).toBe(0);
});
test("deployment wallet checks chain and owner and only sends after explicit review", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { (window as any).walletStub.chain = "0x38"; });
  await page.locator("#connect").click(); await expect(page.locator("#notice")).toContainText("Testnet (97)");
  await expect(page.locator("#deploy")).toBeDisabled();
  await page.evaluate(() => { (window as any).walletStub.chain = "0x61"; (window as any).walletStub.account = "0x0000000000000000000000000000000000000009"; });
  await page.locator("#connect").click(); await expect(page.locator("#notice")).toContainText("configured owner");
  await page.evaluate(owner => { (window as any).walletStub.account = owner; }, owner);
  await ready(page);
  expect(await page.evaluate(() => (window as any).walletStub.sends)).toEqual([]);
  await page.locator("#deploy").click(); await expect(page.locator("#hash")).toHaveValue(hash);
  expect(await page.evaluate(() => (window as any).walletStub.sends)).toEqual([{ from: owner, data: "0x1234", value: "0x0", chainId: "0x61" }]);
  await expect(page.locator("#deploy")).toBeDisabled();
});
test("ambiguous wallet errors survive reload and require manual hash verification", async ({ page }) => {
  await setup(page); await ready(page);
  await page.evaluate(() => { (window as any).walletStub.error = 4900; });
  await page.locator("#deploy").click(); await expect(page.locator("#result")).toContainText("Submission status is uncertain");
  await page.reload(); await expect(page.locator("#connect")).toBeEnabled();
  await page.locator("#connect").click(); await page.locator("#review-addresses").check(); await page.locator("#review-policy").check();
  await expect(page.locator("#deploy")).toBeDisabled();
  await page.route("**/api/v1/deployment/verify", route => route.fulfill({ json: { state: "PENDING", transactionHash: hash, reason: "Waiting for two confirmations" } }));
  await page.locator("#hash").fill(hash); await page.locator("#verify").click();
  await expect(page.locator("#result")).toContainText("PENDING");
  expect(await page.evaluate(() => (window as any).walletStub.sends)).toEqual([]);
});
test("explicit wallet rejection allows a deliberate retry without an automatic send", async ({ page }) => {
  await setup(page); await ready(page);
  await page.evaluate(() => { (window as any).walletStub.error = 4001; });
  await page.locator("#deploy").click(); await expect(page.locator("#notice")).toContainText("cancelled");
  await expect(page.locator("#deploy")).toBeEnabled();
  expect(await page.evaluate(() => (window as any).walletStub.sends.length)).toBe(1);
  await page.evaluate(() => { (window as any).walletStub.error = 0; });
  await page.locator("#deploy").click(); await expect(page.locator("#hash")).toHaveValue(hash);
  expect(await page.evaluate(() => (window as any).walletStub.sends.length)).toBe(2);
});
test("a failed pre-send readiness recheck prevents any wallet transaction and allows manual recovery", async ({ page }) => {
  await setup(page); await ready(page);
  await page.route("**/api/v1/deployment/preflight", route => route.fulfill({ json: { ...preflight, state: "BLOCKED", matchingReads: false } }));
  await page.locator("#deploy").click(); await expect(page.locator("#preflight-state")).toHaveText("BLOCKED");
  await expect(page.locator("#deploy")).toBeDisabled();
  expect(await page.evaluate(() => (window as any).walletStub.sends)).toEqual([]);
  await page.route("**/api/v1/deployment/preflight", route => route.fulfill({ json: preflight }));
  await page.locator("#refresh-preflight").click(); await expect(page.locator("#deploy")).toBeEnabled();
  expect(await page.evaluate(() => (window as any).walletStub.sends)).toEqual([]);
});

test("ERC-8004 registration requires owner review, sends the prepared call and exposes verified proof", async ({ page }) => {
  await setup(page);
  await expect(page.locator("#registration-state")).toHaveText("READY");
  await expect(page.locator("#register")).toBeDisabled();
  await page.locator("#connect").click();
  await page.locator("#registration-owner-review").check();
  await expect(page.locator("#register")).toBeEnabled();
  expect(await page.evaluate(() => (window as any).walletStub.sends)).toEqual([]);
  await page.locator("#register").click();
  await expect(page.locator("#registration-hash")).toHaveValue(hash);
  expect(await page.evaluate(() => (window as any).walletStub.sends)).toEqual([{
    from: owner, to: "0x0000000000000000000000000000000000000800", data: "0xfeed", value: "0x0", chainId: "0x61"
  }]);
  await page.route("**/api/v1/registration/verify", route => route.fulfill({ json: {
    state: "VERIFIED", transactionHash: hash, registry: "0x0000000000000000000000000000000000000800",
    agentId: "42", evidenceHash: "0x1234", registration: { state: "VERIFIED", agentId: "42" }
  } }));
  await page.locator("#verify-registration").click();
  await expect(page.locator("#registration-result")).toContainText("independently verified");
  await expect(page.locator("#export-registration")).toBeEnabled();
});

test("uncertain registration survives reload without opening a second wallet transaction", async ({ page }) => {
  await setup(page);
  await page.locator("#connect").click(); await page.locator("#registration-owner-review").check();
  await page.evaluate(() => { (window as any).walletStub.error = 4900; });
  await page.locator("#register").click();
  await expect(page.locator("#registration-result")).toContainText("Submission status is uncertain");
  await page.reload();
  await expect(page.locator("#registration-state")).toHaveText("READY");
  await page.locator("#connect").click(); await page.locator("#registration-owner-review").check();
  await expect(page.locator("#register")).toBeDisabled();
  await expect(page.locator("#registration-result")).toContainText("Check the existing registration request");
  expect(await page.evaluate(() => (window as any).walletStub.sends)).toEqual([]);
  await page.locator("#registration-hash").fill(hash);
  await expect(page.locator("#verify-registration")).toBeEnabled();
});

test("an explicitly rejected registration permits deliberate retry without resending automatically", async ({ page }) => {
  await setup(page);
  await page.locator("#connect").click(); await page.locator("#registration-owner-review").check();
  await page.evaluate(() => { (window as any).walletStub.error = 4001; });
  await page.locator("#register").click(); await expect(page.locator("#notice")).toContainText("cancelled");
  await expect(page.locator("#register")).toBeEnabled();
  expect(await page.evaluate(() => (window as any).walletStub.sends.length)).toBe(1);
  await page.evaluate(() => { (window as any).walletStub.error = 0; });
  await page.locator("#register").click(); await expect(page.locator("#registration-hash")).toHaveValue(hash);
  expect(await page.evaluate(() => (window as any).walletStub.sends.length)).toBe(2);
});

test("unavailable browser storage blocks deployment and registration before any wallet send", async ({ page }) => {
  await setup(page); await ready(page);
  await page.locator("#registration-owner-review").check();
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException("Denied", "SecurityError"); }; });
  await page.locator("#deploy").click(); await expect(page.locator("#notice")).toContainText("storage is unavailable");
  await page.locator("#register").click(); await expect(page.locator("#notice")).toContainText("storage is unavailable");
  expect(await page.evaluate(() => (window as any).walletStub.sends)).toEqual([]);
});
