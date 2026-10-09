'use strict';
// Accounts through the real UI: sign-up, sign-in, sign-out, session loss.
const { test, expect, factory } = require('./support/fixtures');

test.describe('sign up', () => {
  test('with sample data lands on a populated dashboard', async ({ app, page }) => {
    const email = factory.track(factory.uniqueEmail('e2e'));
    await app.open();
    await app.getStarted();
    await app.chooseEmail();
    await page.getByRole('button', { name: 'Create one' }).click();
    await page.locator('#aName').fill('Grace Hopper');
    await page.locator('#aEmail').fill(email);
    await page.locator('#aPassword').fill(factory.PASSWORD);
    await page.locator('#aPassword2').fill(factory.PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(app.authScreen).toBeHidden();
    await expect(app.toast).toContainText('Welcome, Grace');
    await expect(app.accountPanel).toContainText('Grace Hopper');
    await expect(page.locator('#rankList .rank-row').first()).toBeVisible();
    await factory.cleanup();
  });

  test('without sample data starts empty', async ({ app, page }) => {
    const email = factory.track(factory.uniqueEmail('e2e'));
    await app.open();
    await app.getStarted();
    await app.chooseEmail();
    await page.getByRole('button', { name: 'Create one' }).click();
    await page.locator('#aName').fill('Empty Account');
    await page.locator('#aEmail').fill(email);
    await page.locator('#aPassword').fill(factory.PASSWORD);
    await page.locator('#aPassword2').fill(factory.PASSWORD);
    await page.getByLabel('Start with sample data').uncheck();
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(app.authScreen).toBeHidden();
    await app.nav('transactions');
    await expect(page.locator('#txGroups')).toContainText('Nothing logged');
    await factory.cleanup();
  });

  test('shows server validation errors and keeps the form usable', async ({ app, page, account }) => {
    await app.open();
    await app.getStarted();
    await app.chooseEmail();
    await page.getByRole('button', { name: 'Create one' }).click();
    await page.locator('#aName').fill('Dup');
    await page.locator('#aEmail').fill(account.email);
    await page.locator('#aPassword').fill('short');
    await page.locator('#aPassword2').fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(app.authError).toHaveText('Password must be 8–72 characters.');

    await page.locator('#aPassword').fill(factory.PASSWORD);
    await page.locator('#aPassword2').fill(factory.PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(app.authError).toHaveText('An account with that email already exists.');
    await expect(page.getByRole('button', { name: 'Create account' })).toBeEnabled();
  });
});

test.describe('sign in and out', () => {
  test('wrong password is rejected, right password signs in, sign-out ends the session', async ({ app, page, account }) => {
    await app.open();
    await app.getStarted();
    await expect(app.authScreen).toBeVisible();

    await app.signIn(account.email, 'not-the-password');
    await expect(app.authError).toHaveText('Incorrect email or password.');
    await expect(app.authScreen).toBeVisible();

    await app.signIn(account.email, account.password);
    await expect(app.authScreen).toBeHidden();
    await expect(app.toast).toContainText('Welcome back, Ada');
    await expect(app.accountPanel).toContainText(account.email);

    await app.signOut();
    await expect(app.authScreen).toBeVisible();
    await app.reload();
    await expect(page.locator('#landing')).toBeVisible(); // the session is gone server-side, not just hidden
    await expect(app.accountPanel).not.toContainText(account.email);
  });

  test('a session revoked elsewhere sends you to sign-in and nothing is saved', async ({ signedIn: app, page, account, db }) => {
    await db.revokeSessions(account.id);
    await app.addTx({ amount: 5, merchant: 'Should Not Save' });

    await expect(app.authScreen).toBeVisible();
    await expect(app.authError).toHaveText('Your session expired. Log in again to continue.');
    await expect(app.txDialog).toBeHidden();
    const { n } = await db.row('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?', [account.id]);
    expect(n).toBe(0);

    await app.signIn(account.email, account.password);
    await expect(app.authScreen).toBeHidden();
    await expect(page.locator('#totals')).not.toBeEmpty();
  });
});

test.describe('log-in options', () => {
  test('Log in on the front page offers Google, GitHub, and email', async ({ app, page }) => {
    await app.open();
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Log in to Spend Track' })).toBeVisible();
    // The e2e server has no Google/GitHub keys, so those options are shown but switched off.
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toBeDisabled();
    await expect(page.locator('#providersNote')).toHaveText("Google and GitHub sign-in aren't set up on this server yet.");

    await app.chooseEmail();
    await expect(page.locator('#aEmail')).toBeFocused();
    await page.getByRole('button', { name: 'Other ways to log in' }).click();
    await expect(page.getByRole('heading', { name: 'Log in to Spend Track' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to the front page' }).click();
    await expect(page.locator('#landing')).toBeVisible();
  });

  test('a Google/GitHub sign-in that fails comes back with a clear message', async ({ app, page }) => {
    await page.goto('./#login_error=cancelled');
    await app.ready();
    await expect(app.authError).toHaveText('Sign-in was cancelled.');
    expect(new URL(page.url()).hash, 'the result is removed from the address bar').toBe('');

    await page.goto(`./?again#login_code=${'x'.repeat(43)}`); // a code the server never issued
    await app.ready();
    await expect(app.authError).toHaveText('That sign-in expired. Please try again.');
  });

  test('when signed in, the front page button opens the app instead', async ({ signedIn: app, page }) => {
    await page.getByRole('button', { name: 'Spend Track front page' }).click();
    const button = page.locator('#landingLogin');
    await expect(button).toHaveText('Open the app');
    await button.click();
    await expect(page.locator('#landing')).toBeHidden();
    await expect(app.authScreen).toBeHidden();
  });
});
