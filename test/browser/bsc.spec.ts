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
