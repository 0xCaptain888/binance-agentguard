import { test, expect, type Page } from '@playwright/test';

const vault = `0x${'11'.repeat(20)}`, account = `0x${'22'.repeat(20)}`;
const hash = `0x${'33'.repeat(32)}`, planId = `0x${'44'.repeat(32)}`;
async function simulatedTestnet(page: Page, behavior: 'ambiguous' | 'rejected' | 'success', options: { connect?: boolean; sessionDuration?: number } = {}) {
  let expirePlan = false, exchanges = 0;
  const baseline = await (await page.request.get('/api/v1/status')).json();
  const plan = { id: planId, chainId: 97, vault, owner: account, operator: account,
    tokenIn: baseline.snapshot.token0, tokenOut: baseline.snapshot.token1, sellToken0: true,
    amountIn: '10000000000000000000', minAmountOut: '9900000', notionalUsd: '10000000000000000000',
    driftBeforeBps: '3000', expectedDriftAfterBps: '2000', nonce: '0', deadline: String(Math.floor(Date.now() / 1000) + 90), data: '0x1234' };
  const job: any = { id: planId, createdAt: new Date().toISOString(), state: 'AWAITING_SIGNATURE', plan };
  const status = { ...baseline, mode: 'testnet', environment: 'BSC_TESTNET', note: 'Browser test fixture. No chain transactions.',
    snapshot: { ...baseline.snapshot, vault, chainId: 97, owner: account, operator: account, nonce: '0' },
    journal: { version: 1, frozen: false, jobs: [] as any[] } };
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let value: any, code = 200;
    if (path.endsWith('/status')) value = status;
    else if (path.endsWith('/auth/challenge')) value = { nonce: 'test-nonce', message: 'Browser fixture session only' };
    else if (path.endsWith('/auth/session')) { exchanges++; value = { token: 'test-session-never-persisted', expires: Date.now() + (options.sessionDuration ?? 900000) }; }
    else if (path.endsWith('/auth/logout')) value = { revoked: true };
    else if (path.endsWith('/plans')) {
      if (expirePlan) { expirePlan = false; code = 401; value = { error: 'Wallet session required' }; }
      else { status.journal.jobs = [job]; value = { state: 'READY', job }; }
    }
    else if (path.endsWith('/verify')) {
      expect(route.request().postDataJSON()).toEqual({ jobId: planId, hash });
      job.state = 'VERIFIED'; job.transactionHash = hash;
      job.receipt = { state: 'VERIFIED', chainId: 97, planId, transactionHash: hash,
        checks: { calldataBound: true, canonicalBlock: true }, reasons: [] };
      value = { job };
    } else { code = 404; value = { error: 'Unexpected browser fixture endpoint' }; }
    await route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(value) });
  });
  await page.addInitScript(({ account, hash, behavior }) => {
    const browser = window as any;
    browser.sendCount = 0; browser.walletBehavior = behavior; browser.walletAccount = account;
    const listeners = new Map<string, Set<() => void>>();
    browser.emitWallet = (event: string) => { for (const listener of [...listeners.get(event) || []]) listener(); };
    browser.okxwallet = {
      isOkxWallet: true,
      on(event: string, listener: () => void) { const set = listeners.get(event) || new Set(); set.add(listener); listeners.set(event, set); },
      removeListener(event: string, listener: () => void) { listeners.get(event)?.delete(listener); },
      request: async ({ method }: { method: string }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [browser.walletAccount];
      if (method === 'eth_chainId') return '0x61';
      if (method === 'personal_sign') {
        if (browser.deferSign) return new Promise(resolve => { browser.resolveSign = () => resolve('0x1234'); });
        return '0x1234';
      }
      if (method === 'eth_sendTransaction') {
        browser.sendCount++;
        if (browser.switchOnSend) { browser.walletAccount = `0x${'55'.repeat(20)}`; browser.emitWallet('accountsChanged'); return hash; }
        if (browser.walletBehavior === 'rejected') throw Object.assign(new Error('Rejected'), { code: 4001 });
        if (browser.walletBehavior === 'ambiguous') throw new Error('Wallet transport disconnected');
        return hash;
      }
      throw new Error(`Unexpected wallet method ${method}`);
    } };
  }, { account, hash, behavior });
  await page.goto('/bsc/');
  if (options.connect !== false) {
    await page.locator('#connect').click();
    await expect(page.locator('#plan')).toBeEnabled();
    await page.locator('#plan').click();
  }
  return { key: `agentguard-rebalance:97:${vault}`, expireNextPlan: () => { expirePlan = true; }, exchanges: () => exchanges };
}

test('ambiguous wallet submission survives reload and resumes verification without another send', async ({ page }) => {
  const { key } = await simulatedTestnet(page, 'ambiguous');
  await page.locator('#execute').click();
  await expect(page.locator('#submission-recovery')).toBeVisible();
  await expect(page.locator('#execute')).toBeDisabled();
  expect(await page.evaluate(() => (window as any).sendCount)).toBe(1);
  await page.reload();
  await expect(page.locator('#submission-recovery')).toBeVisible();
  await expect(page.locator('#plan')).toBeDisabled();
  await page.locator('#connect').click();
  await page.locator('#resume-submission').click();
  await page.locator('#transaction-hash').fill(hash);
  await page.locator('#verify').click();
  await expect(page.locator('#decision')).toContainText('VERIFIED');
  await expect(page.locator('#submission-recovery')).toBeHidden();
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull();
  expect(await page.evaluate(() => (window as any).sendCount)).toBe(0);
});

test('explicit wallet rejection enables deliberate retry and a verified receipt releases the saved marker', async ({ page }) => {
  const { key } = await simulatedTestnet(page, 'rejected');
  await page.locator('#execute').click();
  await expect(page.locator('#notice')).toContainText('cancelled');
  await expect(page.locator('#execute')).toBeEnabled();
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull();
  await page.evaluate(() => { (window as any).walletBehavior = 'success'; });
  await page.locator('#execute').click();
  await expect(page.locator('#decision')).toContainText('VERIFIED');
  expect(await page.evaluate(() => (window as any).sendCount)).toBe(2);
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull();
});

test('wallet switch during sign-in cancels the old login before session exchange', async ({ page }) => {
  const fixture = await simulatedTestnet(page, 'success', { connect: false });
  await page.evaluate(() => { (window as any).deferSign = true; });
  await page.locator('#connect').click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).resolveSign)).toBe('function');
  await page.evaluate(() => { const browser = window as any; browser.walletAccount = `0x${'55'.repeat(20)}`; browser.emitWallet('accountsChanged'); browser.resolveSign(); });
  await expect(page.locator('#connect')).toHaveText('Connect OKX Wallet');
  await expect(page.locator('#connect')).toBeEnabled();
  await expect(page.locator('#plan')).toBeDisabled();
  expect(fixture.exchanges()).toBe(0);
  expect(await page.evaluate(() => (window as any).sendCount)).toBe(0);
});

test('expired server session disables wallet actions and can be reconnected', async ({ page }) => {
  const fixture = await simulatedTestnet(page, 'success');
  fixture.expireNextPlan(); await page.locator('#plan').click();
  await expect(page.locator('#connect')).toHaveText('Connect OKX Wallet');
  for (const id of ['plan', 'pause', 'verify']) await expect(page.locator(`#${id}`)).toBeDisabled();
  await page.locator('#connect').click();
  await expect(page.locator('#plan')).toBeEnabled();
  await page.locator('#plan').click();
  await expect(page.locator('#execute')).toBeEnabled();
  expect(fixture.exchanges()).toBe(2);
});

test('client session timeout disables actions without waiting for an API failure', async ({ page }) => {
  await simulatedTestnet(page, 'success', { sessionDuration: 2000 });
  await expect(page.locator('#connect')).toHaveText('Connect OKX Wallet', { timeout: 7000 });
  await expect(page.locator('#plan')).toBeDisabled();
  await expect(page.locator('#pause')).toBeDisabled();
  await expect(page.locator('#notice')).toContainText('expired');
});

test('wallet switch after submission saves the transaction hash for recovery and prevents a second send', async ({ page }) => {
  const { key } = await simulatedTestnet(page, 'success');
  await page.evaluate(() => { (window as any).switchOnSend = true; });
  await page.locator('#execute').click();
  await expect(page.locator('#connect')).toHaveText('Connect OKX Wallet');
  await expect(page.locator('#submission-recovery')).toBeVisible();
  await expect(page.locator('#submission-detail')).toContainText(hash);
  await expect(page.locator('#plan')).toBeDisabled();
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key);
  expect(saved.hash).toBe(hash); expect(saved.jobId).toBe(planId);
  expect(await page.evaluate(() => (window as any).sendCount)).toBe(1);
});
