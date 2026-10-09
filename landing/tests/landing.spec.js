'use strict';
const { test, expect } = require('@playwright/test');

test('loads its own assets at a subpath without errors or horizontal overflow', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => errors.push(request.url()));
  page.on('response', response => { if (response.status() >= 400) errors.push(response.url()); });
  await page.goto('/landing/');
  await expect(page).toHaveTitle(/Spend Track/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('.feature-card')).toHaveCount(4);
  expect(await page.locator('.button').first().evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(251, 171, 87)');
  expect(await page.locator('img').evaluateAll(images => images.every(img => img.complete && img.naturalWidth > 0))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('navigation reaches each section and keyboard users can skip the header', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/landing/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#main$/);
  for (const [name, id] of [['Features', 'features'], ['Download', 'download'], ['Home', 'home']]) {
    await page.getByRole('navigation').getByRole('link', { name }).click();
    await expect(page).toHaveURL(new RegExp(`#${id}$`));
    const top = await page.locator(`#${id}`).evaluate(el => el.getBoundingClientRect().top);
    const headerBottom = await page.locator('header').evaluate(el => el.getBoundingClientRect().bottom);
    expect(top).toBeGreaterThanOrEqual(headerBottom);
    expect(top).toBeLessThan(page.viewportSize().height);
  }
});

test('offers the web app and accurately marks all desktop downloads unavailable', async ({ page }) => {
  await page.goto('/landing/');
  await expect(page.getByRole('link', { name: 'Open the web app' })).toHaveAttribute('href', 'https://spendtrack-app.github.io/spend_track/');
  const download = page.getByRole('button', { name: 'Download Spend Track' });
  await expect(download).toBeDisabled();
  await expect(download).toHaveAttribute('aria-describedby', 'download-status');
  await expect(page.locator('#download-status')).toContainText('Not available yet');
  await expect(page.locator('.platform')).toHaveCount(3);
  for (const platform of await page.locator('.platform').all()) {
    await expect(platform).toContainText('Not released');
    await expect(platform.locator('a')).toHaveCount(0);
  }
  await expect(page.getByRole('link', { name: 'Read the setup guide' })).toHaveAttribute('href', 'https://github.com/spendtrack-app/spend_track#setup');
});
