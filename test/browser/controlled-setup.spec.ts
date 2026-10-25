import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

// UI-only wallet/RPC stubs. These tests never sign, broadcast, or prove public-chain activity.
const owner = "0x0000000000000000000000000000000000000001";
const feed0 = "0x0000000000000000000000000000000000000010";
const feed1 = "0x0000000000000000000000000000000000000011";
const deploymentHash = `0x${"ab".repeat(32)}`, refreshHash = `0x${"cd".repeat(32)}`;
const key = `agentguard:controlled:97:${owner}`, refreshKey = `${key}:refresh:${feed0}`;
const saved = { state: "SUBMITTED", to: feed0, nonce: 7, hash: refreshHash, requestedAt: 1 };
const proof = { state: "VERIFIED", chainId: 97, owner, transactionHash: deploymentHash,
  dependencyMode: "CONTROLLED_TEST_ASSETS", primary: { contractAddress: owner, dependencies: { feed0, feed1 } } };
const unsignedTransaction = { from: owner, data: "0x1234", value: "0x0", chainId: "0x61",
  type: "0x0", gas: "0x124f80", gasPrice: "0x3b9aca00" };
const preparation = () => ({
  status: "UNSIGNED_CONTROLLED_TESTNET_DEPLOYMENT", owner, chainId: 97, independentChecked: true,
  dependencyMode: "CONTROLLED_TEST_ASSETS", preparedAt: Date.now(),
  gas: { estimate: "1000000", limit: "1200000", gasPrice: "1000000000",
    bufferedCost: "1200000000000000", ownerBalance: "1000000000000000000" },
  transaction: unsignedTransaction
});

async function install(context: BrowserContext) {
  for (const path of ["index.html", "app.js"]) {
    const body = await readFile(`site/bsc/setup/${path}`, "utf8");
    await context.route(path === "index.html" ? "**/bsc/setup/" : "**/bsc/setup/app.js", route => route.fulfill({
      contentType: path === "index.html" ? "text/html" : "text/javascript", body
    }));
  }
  await context.route("**/api/v1/controlled", route => route.fulfill({ json: {
    owner, chainId: 97, dependencyMode: "CONTROLLED_TEST_ASSETS", note: "Synthetic fixed $1 test feeds. Not market execution."
  } }));
  await context.route("**/api/v1/controlled/prepare", route => route.fulfill({ json: preparation() }));
  await context.route("**/api/v1/controlled/prepare-retry", route => route.fulfill({ json: {
    ...preparation(), retryNonce: route.request().postDataJSON().nonce
  } }));
  await context.route("**/api/v1/controlled/verify", route => route.fulfill({ json: {
    ...proof, expectedNonce: route.request().postDataJSON().nonce
  } }));
  await context.route("**/api/v1/controlled/refresh", route => route.fulfill({ json: {
    status: "UNSIGNED_CONTROLLED_FEED_REFRESH", preparedAt: Date.now(),
    transactions: [feed0, feed1].map(to => ({ from: owner, to, value: "0x0", chainId: "0x61", data: "0xf8ac93e8" }))
  } }));
  await context.route("**/api/v1/controlled/verify-refresh", route => route.fulfill({ json: {
    state: "VERIFIED", transactionHash: refreshHash, feed: 0, nonce: 7, matchingReads: true, canonical: true
  } }));
  await context.addInitScript(({ owner, deploymentHash, refreshHash }) => {
    const w = window as any;
    w.walletStub = { chain: "0x61", account: owner, nonce: "0x7", error: 0, sends: [], events: {} };
    w.okxwallet = { isOkxWallet: true,
      on(event: string, listener: Function) { w.walletStub.events[event] = listener; },
      removeListener(event: string) { delete w.walletStub.events[event]; },
      async request(input: any) {
        if (input.method === "eth_chainId") return w.walletStub.chain;
        if (input.method === "eth_requestAccounts" && w.walletStub.holdConnect)
          await new Promise(resolve => { w.walletStub.releaseConnect = resolve; });
        if (["eth_requestAccounts", "eth_accounts"].includes(input.method)) return [w.walletStub.account];
        if (input.method === "eth_getTransactionCount") {
          if (w.walletStub.holdNonce) await new Promise(resolve => { w.walletStub.releaseNonce = resolve; });
          return w.walletStub.nonce;
        }
        if (input.method === "eth_sendTransaction") {
          w.walletStub.sends.push(input.params[0]);
          if (w.walletStub.hold) await new Promise(resolve => { w.walletStub.release = resolve; });
          if (w.walletStub.error) throw Object.assign(new Error("Wallet interrupted"), { code: w.walletStub.error });
          return input.params[0].to ? refreshHash : deploymentHash;
        }
        throw new Error(`Unexpected wallet call: ${input.method}`);
      }
    };
  }, { owner, deploymentHash, refreshHash });
}
async function open(page: Page) {
  await page.goto("/bsc/setup/"); await expect(page.locator("#connect")).toBeEnabled();
}
async function connect(page: Page) {
  await page.locator("#connect").click(); await expect(page.locator("#wallet-status")).toContainText("Configured owner connected");
}
async function verify(page: Page) {
  await page.locator("#hash").fill(deploymentHash); await page.locator("#verify").click();
  await expect(page.locator("#download")).toBeEnabled();
}
async function readyDeploy(page: Page) {
  await connect(page); await page.locator("#ack").check(); await page.locator("#prepare").click();
  await expect(page.locator("#deploy")).toBeEnabled();
}
const feedButton = (page: Page) => page.locator(`[data-feed="${feed0}"]`);
const sends = (page: Page) => page.evaluate(() => (window as any).walletStub.sends);
test.beforeEach(async ({ context }) => { await install(context); });

test("controlled setup selects OKX, not the injected MetaMask default, and requires explicit review", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const w = window as any; w.metamaskCalls = 0;
    w.ethereum = { isMetaMask: true, request() { w.metamaskCalls++; throw new Error("Wrong wallet"); } };
  });
  await expect(page.locator("#deploy")).toBeDisabled(); await readyDeploy(page);
  expect(await sends(page)).toEqual([]);
  await page.locator("#deploy").click(); await expect(page.locator("#hash")).toHaveValue(deploymentHash);
  expect(await sends(page)).toEqual([{ ...unsignedTransaction, nonce: "0x7" }]);
  expect(await page.evaluate(() => (window as any).metamaskCalls)).toBe(0);
  await page.reload(); await connect(page); await page.locator('#ack').check(); await page.locator('#prepare').click();
  await expect(page.locator("#deploy")).toBeDisabled();
  await expect(page.locator("#result")).toContainText("Previous wallet request");
  expect(await sends(page)).toEqual([]);
});

test("deployment recovery persists nonce and sends it to independent verification", async ({ page }) => {
  await open(page); await readyDeploy(page);
  await page.locator("#deploy").click(); await expect(page.locator("#hash")).toHaveValue(deploymentHash);
  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key);
  expect(stored).toMatchObject({ state: "SUBMITTED", nonce: 7, hash: deploymentHash });
  await page.route("**/api/v1/controlled/verify", route => {
    expect(route.request().postDataJSON()).toEqual({ hash: deploymentHash, nonce: 7 });
    return route.fulfill({ json: { ...proof, expectedNonce: 7 } });
  });
  await page.locator("#verify").click(); await expect(page.locator("#download")).toBeEnabled();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key)).toMatchObject({
    state: "VERIFIED", nonce: 7, hash: deploymentHash
  });
});

for (const kind of ["deployment", "refresh"]) {
  for (const format of ["hex", "uppercase hex", "decimal", "number", "bigint", "zero"]) {
    test(`${kind} normalizes a ${format} nonce and persists the exact sent value`, async ({ page }) => {
      await open(page);
      if (kind === "deployment") await readyDeploy(page);
      else { await connect(page); await verify(page); }
      await page.evaluate(format => {
        (window as any).walletStub.nonce = format === "hex" ? "0x7" : format === "uppercase hex" ? "0X07"
          : format === "decimal" ? "7" : format === "bigint" ? 7n : format === "zero" ? 0 : 7;
      }, format);
      await (kind === "deployment" ? page.locator("#deploy") : feedButton(page)).click();
      await expect(page.locator(kind === "deployment" ? "#hash" : "#refresh-hash-0")).toHaveValue(
        kind === "deployment" ? deploymentHash : refreshHash);
      const nonce = format === "zero" ? 0 : 7;
      expect(await sends(page)).toHaveLength(1);
      expect((await sends(page))[0].nonce).toBe(`0x${nonce.toString(16)}`);
      expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), kind === "deployment" ? key : refreshKey))
        .toMatchObject({ state: "SUBMITTED", nonce });
    });
  }
  for (const format of ["missing", "null", "empty", "malformed", "object", "unsafe", "negative", "fraction"]) {
    test(`${kind} refuses a ${format} nonce before sending or saving a request lock`, async ({ page }) => {
      await open(page);
      if (kind === "deployment") await readyDeploy(page);
      else { await connect(page); await verify(page); }
      await page.evaluate(format => {
        (window as any).walletStub.nonce = format === "missing" ? undefined : format === "null" ? null
          : format === "empty" ? "" : format === "malformed" ? "0x" : format === "object" ? { result: "0x7" }
          : format === "unsafe" ? "0x20000000000000" : format === "negative" ? -1 : 0.5;
      }, format);
      const storage = kind === "deployment" ? key : refreshKey;
      const before = await page.evaluate(key => localStorage.getItem(key), storage);
      await (kind === "deployment" ? page.locator("#deploy") : feedButton(page)).click();
      await expect(page.locator("#notice")).toContainText("No transaction was requested");
      expect(await sends(page)).toEqual([]);
      expect(await page.evaluate(key => localStorage.getItem(key), storage)).toBe(before);
    });
  }
  test(`${kind} cannot send when the wallet disconnects during the pending nonce read`, async ({ page }) => {
    await open(page);
    if (kind === "deployment") await readyDeploy(page);
    else { await connect(page); await verify(page); }
    await page.evaluate(() => { (window as any).walletStub.holdNonce = true; });
    await (kind === "deployment" ? page.locator("#deploy") : feedButton(page)).click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).walletStub.releaseNonce)).toBe("function");
    await page.evaluate(() => { const s = (window as any).walletStub; s.events.disconnect(); s.releaseNonce(); });
    await expect(page.locator("#notice")).toHaveText("Connect the configured owner.");
    await expect(page.locator("#connect")).toHaveText("Connect OKX Wallet");
    await expect(page.locator(kind === "deployment" ? "#deploy" : `[data-feed="${feed0}"]`)).toBeDisabled();
    expect(await sends(page)).toEqual([]);
    expect(await page.evaluate(key => localStorage.getItem(key), kind === "deployment" ? key : refreshKey)).toBeNull();
  });
}

test("a deployment recovery response missing the saved nonce cannot unlock configuration export", async ({ page }) => {
  await open(page); await readyDeploy(page);
  await page.locator("#deploy").click(); await expect(page.locator("#hash")).toHaveValue(deploymentHash);
  await page.route("**/api/v1/controlled/verify", route => route.fulfill({ json: proof }));
  await page.locator("#verify").click();
  await expect(page.locator("#notice")).toContainText("does not match");
  await expect(page.locator("#download")).toBeDisabled(); await expect(page.locator("#export")).toBeDisabled();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key)).toMatchObject({
    state: "SUBMITTED", nonce: 7, hash: deploymentHash
  });
});

for (const event of ["accountsChanged", "chainChanged", "disconnect"]) test(`setup ${event} during the account prompt requires a fresh connection`, async ({ page }) => {
  await open(page);
  await page.evaluate(() => { (window as any).walletStub.holdConnect = true; });
  await page.locator("#connect").click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).walletStub.releaseConnect)).toBe("function");
  await page.evaluate(event => {
    const s = (window as any).walletStub; s.events[event](); s.releaseConnect();
  }, event);
  await expect(page.locator("#notice")).toContainText("connection changed");
  await expect(page.locator("#connect")).toHaveText("Connect OKX Wallet");
  await expect(page.locator("#deploy")).toBeDisabled();
  expect(await sends(page)).toEqual([]);
  await page.evaluate(() => { (window as any).walletStub.holdConnect = false; });
  await connect(page);
});

test("setup disconnect clears the prepared deployment and detaches provider listeners", async ({ page }) => {
  await open(page); await readyDeploy(page);
  await page.evaluate(() => { (window as any).walletStub.events.disconnect(); });
  await expect(page.locator("#connect")).toHaveText("Connect OKX Wallet");
  await expect(page.locator("#deploy")).toBeDisabled();
  expect(await page.evaluate(() => Object.keys((window as any).walletStub.events))).toEqual([]);
  await connect(page); await expect(page.locator("#deploy")).toBeDisabled();
  expect(await sends(page)).toEqual([]);
});

for (const kind of ["deployment", "refresh"]) test(`disconnect during the ${kind} wallet dialog preserves the returned hash and recovery lock`, async ({ page }) => {
  await open(page);
  if (kind === "deployment") await readyDeploy(page);
  else { await connect(page); await verify(page); }
  await page.evaluate(() => { (window as any).walletStub.hold = true; });
  await (kind === "deployment" ? page.locator("#deploy") : feedButton(page)).click();
  await expect.poll(async () => (await sends(page)).length).toBe(1);
  await page.evaluate(() => { const s = (window as any).walletStub; s.events.disconnect(); s.release(); });
  const hash = kind === "deployment" ? deploymentHash : refreshHash;
  await expect(page.locator(kind === "deployment" ? "#hash" : "#refresh-hash-0")).toHaveValue(hash);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), kind === "deployment" ? key : refreshKey))
    .toMatchObject({ state: "SUBMITTED", nonce: 7, hash });
  await expect(page.locator("#connect")).toHaveText("Connect OKX Wallet");
  await connect(page);
  await expect(kind === "deployment" ? page.locator("#deploy") : feedButton(page)).toBeDisabled();
  expect((await sends(page)).length).toBe(1);
});

test("uncertain deployment survives reload and never unlocks a new-nonce send", async ({ page }) => {
  await open(page); await readyDeploy(page);
  await page.evaluate(() => { (window as any).walletStub.error = 4900; });
  await page.locator("#deploy").click(); await expect(page.locator("#result")).toContainText("Submission uncertain");
  await page.reload(); await connect(page); await page.locator("#ack").check(); await page.locator("#prepare").click();
  await expect(page.locator("#deploy")).toBeDisabled(); expect(await sends(page)).toEqual([]);
});

const interruptedDeployment = { state: "WALLET_REQUESTED", nonce: 7, requestedAt: 1 };
async function seedDeployment(page: Page, record: unknown = interruptedDeployment) {
  await open(page);
  await page.evaluate(({ key, record }) => localStorage.setItem(key,
    typeof record === "string" ? record : JSON.stringify(record)), { key, record });
  await page.reload();
}
async function readyRetry(page: Page) {
  await seedDeployment(page); await connect(page); await page.locator("#ack").check();
  await page.locator("#retry-recovery summary").click(); await page.locator("#retry-ack").check();
  await expect(page.locator("#retry")).toBeEnabled(); await expect(page.locator("#deploy")).toBeDisabled();
}

test("hashless recovery needs both acknowledgements and submits only the saved nonce with explicit fees", async ({ page }) => {
  await seedDeployment(page);
  await expect(page.locator("#retry-recovery")).toBeVisible();
  await page.locator("#retry-recovery summary").click();
  await expect(page.locator("#retry")).toBeDisabled();
  await connect(page); await page.locator("#retry-ack").check();
  await expect(page.locator("#retry")).toBeDisabled();
  await page.locator("#ack").check(); await page.locator("#retry-ack").uncheck();
  await expect(page.locator("#retry")).toBeDisabled();
  await page.locator("#retry-ack").check();
  await page.locator("#retry").click(); await expect(page.locator("#hash")).toHaveValue(deploymentHash);
  expect(await sends(page)).toEqual([{ ...unsignedTransaction, nonce: "0x7" }]);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key)).toMatchObject({
    ...interruptedDeployment, state: "SUBMITTED", hash: deploymentHash
  });
  await expect(page.locator("#deploy")).toBeDisabled();
  await expect(page.locator("#retry-recovery")).toBeHidden();
});

for (const record of [
  { state: "SUBMITTED", nonce: 7, hash: deploymentHash },
  { state: "VERIFIED", nonce: 7, hash: deploymentHash },
  { ...interruptedDeployment, hash: deploymentHash },
  { state: "WALLET_REQUESTED" },
  { ...interruptedDeployment, nonce: -1 },
  "WALLET_REQUESTED", deploymentHash, "{broken"
]) test(`recovery never enables a retry for ${JSON.stringify(record)}`, async ({ page }) => {
  await seedDeployment(page, record); await connect(page); await page.locator("#ack").check();
  await page.locator("#prepare").click();
  await expect(page.locator("#retry-recovery")).toBeHidden();
  await expect(page.locator("#deploy")).toBeDisabled(); expect(await sends(page)).toEqual([]);
});

for (const code of [4001, 4900]) test(`same-nonce wallet error ${code} preserves the original recovery lock`, async ({ page }) => {
  await readyRetry(page);
  const original = await page.evaluate(key => localStorage.getItem(key), key);
  await page.evaluate(code => { (window as any).walletStub.error = code; }, code);
  await page.locator("#retry").click();
  await expect(page.locator("#notice")).toContainText(code === 4001 ? "Original recovery lock retained" : "Wallet interrupted");
  const record = await page.evaluate(key => localStorage.getItem(key), key);
  if (code === 4001) expect(record).toBe(original);
  else expect(JSON.parse(record!)).toMatchObject(interruptedDeployment);
  expect(await sends(page)).toEqual([{ ...unsignedTransaction, nonce: "0x7" }]);
  await expect(page.locator("#retry-ack")).not.toBeChecked();
  await expect(page.locator("#deploy")).toBeDisabled();
  await page.reload(); await connect(page);
  await expect(page.locator("#retry-recovery")).toBeVisible();
  await expect(page.locator("#deploy")).toBeDisabled(); expect(await sends(page)).toEqual([]);
});

for (const failure of ["RPC disagreement", "wrong confirmed nonce", "wallet nonce mismatch"]) test(`same-nonce recovery blocks ${failure} without changing the saved request`, async ({ page }) => {
  await readyRetry(page);
  const original = await page.evaluate(key => localStorage.getItem(key), key);
  if (failure === "wallet nonce mismatch")
    await page.evaluate(() => { (window as any).walletStub.nonce = "0x8"; });
  else await page.route("**/api/v1/controlled/prepare-retry", route => route.fulfill(
    failure === "RPC disagreement" ? { status: 409, json: { error: "Independent nonce disagreement" } } :
      { json: { ...preparation(), retryNonce: 8 } }));
  await page.locator("#retry").click();
  await expect(page.locator("#notice")).toContainText(failure === "RPC disagreement" ? "nonce disagreement" :
    failure === "wrong confirmed nonce" ? "did not confirm the saved nonce" : "pending nonce differs");
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(original);
  await expect(page.locator("#deploy")).toBeDisabled(); expect(await sends(page)).toEqual([]);
});

for (const field of ["type", "gas", "gasPrice", "maxFeePerGas", "limit", "bufferedCost", "ownerBalance", "data"])
  test(`deployment and same-nonce recovery refuse an inconsistent ${field}`, async ({ page }) => {
    await readyRetry(page);
    const invalidPreparation = () => {
      const value = preparation();
      value.transaction = { ...value.transaction };
      if (field === "type") value.transaction.type = "0x2";
      else if (field === "gas" || field === "gasPrice") value.transaction[field] = "0x0";
      else if (field === "maxFeePerGas") Object.assign(value.transaction, { maxFeePerGas: "0x1" });
      else if (field === "data") value.transaction.data = "0x123";
      else value.gas[field as "limit" | "bufferedCost" | "ownerBalance"] = "1";
      return value;
    };
    await page.route("**/api/v1/controlled/prepare", route => route.fulfill({ json: invalidPreparation() }));
    await page.locator("#prepare").click(); await expect(page.locator("#notice")).toContainText("Prepare again");
    await expect(page.locator("#deploy")).toBeDisabled();
    await page.route("**/api/v1/controlled/prepare-retry", route => route.fulfill({ json: {
      ...invalidPreparation(), retryNonce: 7
    } }));
    const original = await page.evaluate(key => localStorage.getItem(key), key);
    await page.locator("#retry").click(); await expect(page.locator("#notice")).toContainText("Prepare again");
    expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(original);
    expect(await sends(page)).toEqual([]);
  });

for (const stage of ["prepare", "nonce"]) {
  for (const change of ["account", "network", "disconnect", "storage"])
    test(`same-nonce recovery blocks a ${change} change during ${stage}`, async ({ page }) => {
      await readyRetry(page);
      const original = await page.evaluate(key => localStorage.getItem(key), key);
      const changedRecord = JSON.stringify({ ...interruptedDeployment, nonce: 8 });
      const mutate = async () => page.evaluate(({ change, key, changedRecord }) => {
        const s = (window as any).walletStub;
        if (change === "storage") localStorage.setItem(key, changedRecord);
        else if (change === "account") { s.account = "0x0000000000000000000000000000000000000002"; s.events.accountsChanged([s.account]); }
        else if (change === "network") { s.chain = "0x38"; s.events.chainChanged(s.chain); }
        else s.events.disconnect();
      }, { change, key, changedRecord });
      if (stage === "prepare") await page.route("**/api/v1/controlled/prepare-retry", async route => {
        await mutate(); await route.fulfill({ json: { ...preparation(), retryNonce: 7 } });
      });
      else await page.evaluate(() => { (window as any).walletStub.holdNonce = true; });
      await page.locator("#retry").click();
      if (stage === "nonce") {
        await expect.poll(() => page.evaluate(() => typeof (window as any).walletStub.releaseNonce)).toBe("function");
        await mutate(); await page.evaluate(() => { (window as any).walletStub.releaseNonce(); });
      }
      await expect(page.locator("#notice")).toContainText(change === "storage" ? "Saved request" : "Connect the configured owner");
      expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(change === "storage" ? changedRecord : original);
      await expect(page.locator("#deploy")).toBeDisabled(); expect(await sends(page)).toEqual([]);
    });
}

test("cross-tab recovery never opens a second same-nonce wallet dialog", async ({ page, context }) => {
  await readyRetry(page);
  const other = await context.newPage(); await open(other); await connect(other);
  await other.locator("#ack").check(); await other.locator("#retry-recovery summary").click();
  await other.locator("#retry-ack").check();
  await page.evaluate(() => { (window as any).walletStub.hold = true; });
  await page.locator("#retry").click(); await expect.poll(async () => (await sends(page)).length).toBe(1);
  await other.locator("#retry").click(); await expect(other.locator("#notice")).toContainText("Another tab");
  expect(await sends(other)).toEqual([]);
  await page.evaluate(() => { (window as any).walletStub.release(); });
  await expect(page.locator("#hash")).toHaveValue(deploymentHash);
});

test("explicit deployment rejection permits a deliberate retry without clearing uncertain requests", async ({ page }) => {
  await open(page); await readyDeploy(page);
  await page.evaluate(() => { (window as any).walletStub.error = 4001; });
  await page.locator("#deploy").click(); await expect(page.locator("#notice")).toContainText("Wallet rejected");
  await expect(page.locator("#deploy")).toBeEnabled(); expect((await sends(page)).length).toBe(1);
});

test("refresh persists the exact nonce and selector before requesting the wallet and restores them after reload", async ({ page }) => {
  await open(page); await connect(page); await verify(page); await feedButton(page).click();
  await expect(page.locator("#refresh-hash-0")).toHaveValue(refreshHash);
  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), refreshKey);
  expect(stored).toMatchObject({ state: saved.state, to: saved.to, nonce: saved.nonce, hash: saved.hash });
  expect(stored.requestedAt).toBeGreaterThan(Date.now() - 60000);
  expect(stored.requestedAt).toBeLessThanOrEqual(Date.now());
  expect(await sends(page)).toEqual([{ from: owner, to: feed0, value: "0x0", chainId: "0x61", data: "0xf8ac93e8", nonce: "0x7" }]);
  await page.reload(); await connect(page); await verify(page);
  await expect(feedButton(page)).toBeDisabled(); await expect(page.locator("#refresh-hash-0")).toHaveValue(refreshHash);
  await expect(page.locator("#refresh-nonce-0")).toHaveValue("7");
  await page.locator("#verify-refresh-0").click(); await expect(feedButton(page)).toBeEnabled();
  expect(await page.evaluate(key => localStorage.getItem(key), refreshKey)).toBeNull();
  expect(await sends(page)).toEqual([]);
});

for (const code of [4001, 4900]) test(`refresh wallet error ${code} ${code === 4001 ? "allows deliberate retry" : "keeps the recovery lock"}`, async ({ page }) => {
  await open(page); await connect(page); await verify(page);
  await page.evaluate(code => { (window as any).walletStub.error = code; }, code);
  await feedButton(page).click(); await expect(page.locator("#notice")).toContainText("Wallet interrupted");
  expect((await sends(page)).length).toBe(1);
  if (code === 4001) { await expect(feedButton(page)).toBeEnabled(); expect(await page.evaluate(key => localStorage.getItem(key), refreshKey)).toBeNull(); }
  else {
    await expect(feedButton(page)).toBeDisabled(); await page.reload(); await connect(page); await verify(page);
    await expect(feedButton(page)).toBeDisabled(); await expect(page.locator("#refresh-nonce-0")).toHaveValue("7");
    await page.locator("#refresh-hash-0").fill(refreshHash); await page.locator("#verify-refresh-0").click();
    await expect(feedButton(page)).toBeEnabled(); expect(await sends(page)).toEqual([]);
  }
});

for (const failure of ["throw", "readback"]) test(`storage ${failure} failure prevents deployment wallet sends`, async ({ page }) => {
  await open(page); await readyDeploy(page);
  await page.evaluate(failure => {
    Storage.prototype.setItem = failure === "throw" ? () => { throw new DOMException("Denied", "SecurityError"); } : () => {};
  }, failure);
  await page.locator("#deploy").click(); await expect(page.locator("#notice")).not.toBeEmpty(); expect(await sends(page)).toEqual([]);
  await verify(page);
  await expect(feedButton(page)).toBeVisible(); await expect(feedButton(page)).toBeDisabled();
  await expect(page.locator('#download')).toBeEnabled();
  await expect(page.locator('#notice')).toContainText('Recovery storage'); expect(await sends(page)).toEqual([]);
});

for (const failure of ["throw", "readback"]) test(`storage ${failure} failure prevents refresh wallet sends`, async ({ page }) => {
  await open(page); await connect(page); await verify(page);
  await page.evaluate(failure => {
    Storage.prototype.setItem = failure === "throw" ? () => { throw new DOMException("Denied", "SecurityError"); } : () => {};
  }, failure);
  await feedButton(page).click();
  await expect(feedButton(page)).toBeDisabled(); expect(await sends(page)).toEqual([]);
  await expect(page.locator('#notice')).toContainText('Recovery storage');
});

for (const invalid of ["stale", "selector"]) test(`a ${invalid} refresh preparation cannot request the wallet`, async ({ page }) => {
  await open(page); await connect(page); await verify(page);
  await page.route("**/api/v1/controlled/refresh", route => route.fulfill({ json: {
    status: "UNSIGNED_CONTROLLED_FEED_REFRESH", preparedAt: Date.now() - (invalid === "stale" ? 61000 : 0),
    transactions: [feed0, feed1].map(to => ({ from: owner, to, value: "0x0", chainId: "0x61", data: invalid === "selector" ? "0xdeadbeef" : "0xf8ac93e8" }))
  } }));
  await feedButton(page).click(); await expect(page.locator("#notice")).toContainText(invalid === "stale" ? "stale" : "Unexpected refresh");
  expect(await sends(page)).toEqual([]);
});

test("stale deployment preparation remains blocked without any wallet send", async ({ page }) => {
  await open(page); await connect(page); await page.locator("#ack").check();
  await page.route("**/api/v1/controlled/prepare", route => route.fulfill({ json: {
    status: "UNSIGNED_CONTROLLED_TESTNET_DEPLOYMENT", owner, chainId: 97, independentChecked: true,
    dependencyMode: "CONTROLLED_TEST_ASSETS", preparedAt: Date.now() - 61000
  } }));
  await page.locator("#prepare").click(); await expect(page.locator("#notice")).toContainText("stale");
  await expect(page.locator("#deploy")).toBeDisabled(); expect(await sends(page)).toEqual([]);
});

test("pending, wrong-nonce and noncanonical recovery results never release the saved request", async ({ page }) => {
  await open(page); await page.evaluate(({ key, saved }) => localStorage.setItem(key, JSON.stringify(saved)), { key: refreshKey, saved });
  await connect(page); await verify(page);
  for (const override of [{ state: "PENDING" }, { nonce: 8 }, { canonical: false }, { transactionHash: deploymentHash }]) {
    await page.route("**/api/v1/controlled/verify-refresh", route => route.fulfill({ json: {
      state: "VERIFIED", transactionHash: refreshHash, feed: 0, nonce: 7, matchingReads: true, canonical: true, ...override
    } }));
    await page.locator("#verify-refresh-0").click(); await expect(feedButton(page)).toBeDisabled();
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), refreshKey)).toEqual(saved);
  }
  expect(await sends(page)).toEqual([]);
});

test("matching canonical reverted refresh releases only its lock and never claims success", async ({ page }) => {
  await open(page); await page.evaluate(({ key, saved }) => localStorage.setItem(key, JSON.stringify(saved)), { key: refreshKey, saved });
  await connect(page); await verify(page);
  await page.route("**/api/v1/controlled/verify-refresh", route => route.fulfill({ json: {
    state: "REVERTED", transactionHash: refreshHash, feed: 0, nonce: 7, matchingReads: true, canonical: true
  } }));
  await page.locator("#verify-refresh-0").click(); await expect(feedButton(page)).toBeEnabled();
  await expect(page.locator("#refresh-actions")).toContainText("no refresh succeeded"); expect(await sends(page)).toEqual([]);
});

test("legacy recovery accepts a supplied nonce and hash but removes only the inspected record", async ({ page }) => {
  await open(page);
  await page.evaluate(({ key, hash }) => {
    localStorage.setItem(`${key}:100`, "WALLET_REQUESTED"); localStorage.setItem(`${key}:101`, hash);
    localStorage.setItem("unrelated-recovery", "keep");
  }, { key: refreshKey, hash: deploymentHash });
  await connect(page); await verify(page);
  await expect(feedButton(page)).toBeDisabled(); await expect(page.locator("#refresh-nonce-0")).toBeEditable();
  await page.locator("#refresh-nonce-0").fill("7"); await page.locator("#refresh-hash-0").fill(refreshHash);
  await page.locator("#verify-refresh-0").click(); await expect(page.locator("#notice")).toContainText("Another saved request");
  expect(await page.evaluate(key => localStorage.getItem(`${key}:100`), refreshKey)).toBeNull();
  expect(await page.evaluate(key => localStorage.getItem(`${key}:101`), refreshKey)).toBe(deploymentHash);
  expect(await page.evaluate(() => localStorage.getItem("unrelated-recovery"))).toBe("keep");
  await expect(feedButton(page)).toBeDisabled(); expect(await sends(page)).toEqual([]);
});

test("cross-tab Web Locks prevent a second wallet request while one is open", async ({ page, context }) => {
  await open(page); await connect(page); await verify(page);
  const other = await context.newPage(); await open(other); await connect(other); await verify(other);
  await page.evaluate(() => { (window as any).walletStub.hold = true; });
  await feedButton(page).click(); await expect.poll(async () => (await sends(page)).length).toBe(1);
  await other.locator(`[data-feed="${feed1}"]`).click();
  await expect(other.locator("#notice")).toContainText("Another tab"); expect(await sends(other)).toEqual([]);
  await page.evaluate(() => { (window as any).walletStub.release(); });
  await expect(page.locator("#refresh-hash-0")).toHaveValue(refreshHash);
});

test("wallet change or environment change during refresh preparation prevents submission", async ({ page }) => {
  await open(page); await connect(page); await verify(page);
  await page.route("**/api/v1/controlled/refresh", async route => {
    await page.evaluate(() => { const w = window as any; w.walletStub.chain = "0x38"; w.walletStub.events.chainChanged(); });
    await route.fulfill({ json: { status: "UNSIGNED_CONTROLLED_FEED_REFRESH", preparedAt: Date.now(), transactions: [] } });
  });
  await feedButton(page).click(); await expect(page.locator("#notice")).toContainText("Connect the configured owner");
  expect(await sends(page)).toEqual([]);
  await page.evaluate(() => { (window as any).walletStub.chain = "0x61"; }); await connect(page);
  await page.route("**/api/v1/controlled/refresh", async route => {
    await page.evaluate(() => { (document.getElementById("hash") as HTMLInputElement).value = `0x${"ef".repeat(32)}`; });
    await route.fulfill({ json: { status: "UNSIGNED_CONTROLLED_FEED_REFRESH", preparedAt: Date.now(), transactions: [] } });
  });
  await feedButton(page).click(); await expect(page.locator("#notice")).toContainText("Environment changed"); expect(await sends(page)).toEqual([]);
});

test("export binds environment and requires a deliberate manual or delegated authority choice", async ({ page }) => {
  await open(page); await verify(page); await expect(page.locator("#export")).toBeDisabled();
  await page.locator("#mode").selectOption("OWNER_MANUAL"); await expect(page.locator("#operator")).toHaveValue(owner);
  await expect(page.locator("#export")).toBeEnabled();
  await page.route("**/api/v1/controlled/config", route => {
    expect(route.request().postDataJSON()).toEqual({ operator: owner, mode: "OWNER_MANUAL", environmentHash: deploymentHash });
    return route.fulfill({ status: 201, json: { path: "config/bsc-controlled.json" } });
  });
  await page.locator("#export").click(); await expect(page.locator("#next")).toContainText("vault is NOT deployed yet");
  await page.locator("#mode").selectOption("DELEGATED"); await expect(page.locator("#operator")).toBeEmpty();
  await expect(page.locator("#export")).toBeDisabled(); expect(await sends(page)).toEqual([]);
});
