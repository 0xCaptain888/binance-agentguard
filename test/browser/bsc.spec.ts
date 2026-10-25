import { test, expect } from "@playwright/test";

test("desktop: real local trade, replay-safe receipt, owner pause and failed proof freeze", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/bsc/");
  await expect(page.locator("#value")).toHaveText("$100.00");
  await expect(page.locator("#connect")).toBeVisible();
  await page.locator("#plan").click(); await expect(page.locator("#decision")).toContainText("AWAITING_SIGNATURE");
  await page.locator("#execute").click(); await expect(page.locator("#decision")).toContainText("VERIFIED");
  await expect(page.locator("#share0")).toHaveText("70.0%");
  await expect(page.locator("#budget")).toHaveText("$15.00");
  await page.locator("#pause").click(); await expect(page.locator("#runner-state")).toHaveText("Vault paused");
  await page.locator("#plan").click(); await expect(page.locator("#decision")).toContainText("BLOCKED");
  await page.locator("#judge-run").click();
  await expect(page.locator("#runner-state")).toHaveText("Runner frozen");
  await expect(page.locator("#receipts")).toContainText("VERIFIED"); await expect(page.locator("#receipts")).toContainText("FROZEN");
  await expect(page.locator("#plan")).toBeDisabled(); await expect(page.locator("#pause")).toBeEnabled();
  await page.screenshot({ path: ".runtime/bsc-desktop-proof.png", fullPage: true });
  await page.reload(); await expect(page.locator("#runner-state")).toHaveText("Runner frozen");
  await page.locator("#reset").click(); await expect(page.locator("#value")).toHaveText("$100.00");
  await expect(page.locator("#runner-state")).toHaveText("Ready to plan");
  expect(errors).toEqual([]);
});

test("mobile: wallet entry visible without scrolling, readable layout and no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/bsc/"); await expect(page.locator("#value")).toHaveText("$100.00");
  const wallet = await page.locator("#connect").boundingBox(); expect(wallet!.y + wallet!.height).toBeLessThan(300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: ".runtime/bsc-mobile.png", fullPage: true });
});

test("dependency diagnostics show saved blockers without a wallet request and replace stale success after failure", async ({ page }) => {
  let failed = false;
  await page.route("**/api/v1/dependencies", route => route.fulfill({ json: failed ? { state: "UNAVAILABLE" } : {
    state: "STALE_SNAPSHOT", checkedAt: "2026-10-25T00:00:00.000Z", blockNumber: "123",
    independentReadsAgree: true,
    counts: { tokens: 7, pairs: 21, quoteDirections: 12, compatibleCandidates: 0 },
    policy: { maxActionUsd: "10000000000000000000", maxSlippageBps: 100, maxOracleAgeSeconds: "3600" },
    blockers: { staleOrInvalidFeeds: 4, missingPairs: 15, failedQuoteDirections: 6, rpcErrors: 0 }
  } }));
  await page.addInitScript(() => {
    (window as any).okxwallet = { request: () => { throw new Error("Diagnostics must not request the wallet"); } };
  });
  await page.goto("/bsc/");
  await expect(page.locator("#dependency-state")).toHaveText("STALE SNAPSHOT");
  await expect(page.locator("#dependency-facts")).toContainText("7 tokens · 21 direct pairs");
  await expect(page.locator("#dependency-facts")).toContainText("Stale or invalid price feeds");
  await expect(page.locator("#dependency-summary")).toContainText("historical snapshot");
  failed = true;
  await page.locator("#reload-dependencies").click();
  await expect(page.locator("#dependency-state")).toHaveText("UNAVAILABLE");
  await expect(page.locator("#dependency-facts")).toBeEmpty();
  await expect(page.locator("#reload-dependencies")).toBeEnabled();
});

test("an older service missing the diagnostics module still loads the local console", async ({ page }) => {
  await page.route("**/bsc/dependencies.js", route => route.fulfill({ status: 404, body: "Not found" }));
  await page.goto("/bsc/");
  await expect(page.locator("#dependency-state")).toHaveText("SERVICE UPDATE REQUIRED");
  await expect(page.locator("#reload-dependencies")).toBeDisabled();
  await expect(page.locator("#value")).toHaveText("$100.00");
  await expect(page.locator("#plan")).toBeEnabled();
});

test("read-only scan starts once, polls completion and respects server cooldown without a wallet prompt", async ({ page }) => {
  let state = "IDLE", starts = 0;
  await page.addInitScript(() => {
    (window as any).okxwallet = { request: () => { throw new Error("Scan must never request a wallet"); } };
  });
  await page.route("**/api/v1/dependencies", route => route.fulfill({ json: {
    state: state === "SUCCEEDED" ? "BLOCKED" : "NOT_CHECKED", deploymentReady: false,
    scan: { enabled: true, state, retryAfterSeconds: state === "SUCCEEDED" ? 60 : 0 }
  } }));
  await page.route("**/api/v1/dependencies/scan", async route => {
    starts++; state = "RUNNING";
    expect(route.request().method()).toBe("POST");
    await route.fulfill({ status: 202, json: { scan: { enabled: true, state, retryAfterSeconds: 0 } } });
  });
  await page.goto("/bsc/");
  await expect(page.locator("#run-dependencies")).toBeEnabled();
  await page.locator("#run-dependencies").click();
  await expect(page.locator("#run-dependencies")).toHaveText("Scanning testnet…");
  await expect(page.locator("#run-dependencies")).toBeDisabled();
  await expect(page.locator("#dependency-scan-status")).toContainText("No wallet request");
  state = "SUCCEEDED";
  await expect(page.locator("#dependency-state")).toHaveText("BLOCKED", { timeout: 10000 });
  await expect(page.locator("#dependency-scan-status")).toContainText("Retry available");
  await expect(page.locator("#run-dependencies")).toBeDisabled();
  expect(starts).toBe(1);
  await expect(page.locator("#plan")).toBeEnabled();
});

test("a visible candidate expires without a response from a stalled status refresh", async ({ page }) => {
  await page.clock.install();
  let reads = 0;
  await page.route("**/api/v1/dependencies", async route => {
    reads++;
    if (reads > 1) { await route.abort(); return; }
    await route.fulfill({ json: {
      state: "REVIEW_REQUIRED", snapshotFresh: true, serverTime: "2026-10-25T00:00:00.000Z",
      expiresAt: "2026-10-25T00:00:02.000Z", scan: { enabled: true, state: "IDLE", retryAfterSeconds: 0 }
    } });
  });
  await page.goto("/bsc/");
  await expect(page.locator("#dependency-state")).toHaveText("REVIEW REQUIRED");
  await page.clock.fastForward(3000);
  await expect(page.locator("#dependency-state")).toHaveText("STALE SNAPSHOT");
  await expect(page.locator("#dependency-summary")).toContainText("historical snapshot");
});

test("local VERIFYING journal restores a retry control after reload even without live pricing", async ({ page }) => {
  await page.goto("/bsc/");
  await page.locator("#reset").click();
  await expect(page.locator("#value")).toHaveText("$100.00");
  await page.locator("#plan").click(); await page.locator("#execute").click();
  await expect(page.locator("#decision")).toContainText("VERIFIED");
  const before = await (await page.request.get("/api/v1/status")).json();
  const hash = before.journal.jobs[0].transactionHash;
  // Emulate the interrupted service's public status at the UI boundary. Actual
  // RPC failures and single-broadcast recovery are covered by service tests.
  let interrupted = true;
  await page.route("**/api/v1/status", async route => {
    const response = await route.fetch(), status = await response.json();
    if (interrupted) {
      status.journal.jobs[0].state = "VERIFYING"; delete status.journal.jobs[0].receipt;
      status.pricing.available = false; status.portfolio = null;
    }
    await route.fulfill({ response, json: status });
  });
  await page.route("**/api/v1/local/execute", async route => { interrupted = false; await route.continue(); });
  await page.reload();
  await expect(page.locator("#value")).toHaveText("Unavailable");
  await page.getByRole("button", { name: "Resume verification →" }).click();
  await expect(page.locator("#execute")).toHaveText("Retry verification · no new trade");
  await expect(page.locator("#execute")).toBeEnabled();
  await page.locator("#execute").click();
  await expect(page.locator("#decision")).toContainText("VERIFIED");
  const after = await (await page.request.get("/api/v1/status")).json();
  expect(after.snapshot.nonce).toBe(before.snapshot.nonce);
  expect(after.journal.jobs[0].receipt.transactionHash).toBe(hash);
});

test("oracle outage survives reload and keeps owner pause visible without displaying stale valuation", async ({ page }) => {
  await page.goto("/bsc/");
  await page.locator("#reset").click();
  await expect(page.locator("#value")).toHaveText("$100.00");
  await page.locator("#oracle-outage").click();
  await expect(page.locator("#value")).toHaveText("Unavailable");
  await expect(page.locator("#runner-state")).toHaveText("Price source unavailable");
  await page.reload();
  await expect(page.locator("#asset0")).toContainText("TEST-A · 80");
  await expect(page.locator("#plan")).toBeDisabled();
  await expect(page.locator("#pause")).toBeEnabled();
  await expect(page.locator("#allocation-bar")).toBeHidden();
  await page.locator("#pause").click();
  await expect(page.locator("#runner-state")).toHaveText("Vault paused");
  await page.locator("#reset").click();
  await expect(page.locator("#value")).toHaveText("$100.00");
});
