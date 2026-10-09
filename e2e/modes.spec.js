'use strict';
// Browser-only fallback and the mobile layout.
const { test, expect } = require('./support/fixtures');
const { assertCleared } = require('./support/reset');

test('with the API unreachable the site runs in browser-only mode and keeps data locally', async ({ app, page }) => {
  await page.route(/\/api\//, route => route.abort('connectionrefused'));
  await app.open();
  await expect(app.accountPanel).toContainText('Demo mode');
  await expect(app.authScreen).toBeHidden();
  await app.getStarted(); // first visit shows the front page
  await expect(page.locator('#totals')).not.toBeEmpty();

  await app.addTx({ amount: 3.21, merchant: 'Local Only Kiosk' });
  await app.reload();
  await app.nav('transactions');
  await expect(app.row('Local Only Kiosk')).toContainText('$3.21');
});

test('with the API unreachable, Log in explains that only the demo is available', async ({ app, page }) => {
  await page.route(/\/api\//, route => route.abort('connectionrefused'));
  await app.open();
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.locator('#authOffline')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Continue with email' })).toBeDisabled();
  await page.getByRole('button', { name: 'Try the demo' }).click();
  await expect(app.authScreen).toBeHidden();
  await expect(page.locator('#totals')).not.toBeEmpty();
});

test('browser-only reset persists an empty account across reloads', async ({ app, page }) => {
  await page.route(/\/api\//, route => route.abort('connectionrefused'));
  await app.open();
  await app.getStarted();
  await app.addTx({ amount: 25, merchant: 'Reset Local Expense' });
  await app.addTx({ amount: 1000, merchant: 'Reset Local Income', type: 'income', category: 'income' });
  const budgets = Object.fromEntries(Object.keys(require('../seed').DEFAULT_BUDGETS).map(cat => [cat, 0]));
  page.once('dialog', d => {
    expect(d.message()).toBe('Reset all financial data? This cannot be undone.');
    d.accept();
  });
  await app.openMenu();
  await page.getByRole('menuitem', { name: 'Reset data', exact: true }).click();
  await expect(app.toast).toHaveText('Financial data reset');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('spendtrack.v1')))).toEqual({ txs: [], budgets });
  await assertCleared(app, page);
  await app.reload();
  await assertCleared(app, page);
});

test('a fresh visit starts on the front page, reloads stay in the app, and the logo goes back', async ({ signedIn: app, page, context }) => {
  const landing = page.locator('#landing');
  await expect(landing).toBeHidden(); // signedIn went through Get started
  await app.reload();
  await expect(landing).toBeHidden();

  await page.getByRole('button', { name: 'Spend Track front page' }).click();
  await expect(landing).toBeVisible();
  await app.reload();
  await expect(landing).toBeVisible(); // stays on the front page until Get started
  await app.getStarted();
  await expect(landing).toBeHidden();

  const fresh = await context.newPage(); // opening the link again, still signed in
  await fresh.goto('./');
  await expect(fresh.locator('html')).toHaveAttribute('data-state', 'ready');
  await expect(fresh.locator('#landing')).toBeVisible();
  await fresh.getByRole('button', { name: 'Get started' }).click();
  await expect(fresh.locator('#auth')).toBeHidden();
  await expect(fresh.locator('#landing')).toBeHidden();
});

test.describe('mobile @mobile', () => {
  test('tab bar navigation and adding a transaction work on a phone', async ({ signedIn: app, page, account, db }) => {
    await expect(page.locator('.tabbar')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();

    await app.nav('budgets');
    await expect(page.locator('#budgetGrid .budget-card').first()).toBeVisible();
    await app.addTx({ amount: 7, merchant: 'Food Truck' });
    await expect(app.txDialog).toBeHidden();
    expect(await db.row('SELECT amount FROM transactions WHERE user_id = ? AND merchant = ?', [account.id, 'Food Truck'])).toEqual({ amount: 7 });

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, 'no horizontal scrolling').toBeLessThanOrEqual(0);
  });
});
