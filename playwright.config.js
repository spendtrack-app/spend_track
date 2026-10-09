'use strict';
// Browser end-to-end tests.
//   npm run e2e                                                        # local server (started if needed)
//   E2E_BASE_URL=https://spendtrack-app.github.io/spend_track/ npm run e2e  # live GitHub Pages site
const { defineConfig, devices } = require('@playwright/test');

const external = process.env.E2E_BASE_URL;
const port = process.env.PORT || 3000;

module.exports = defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Tests are independent (own account each, seeded in the DB), so they run in parallel.
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalTeardown: require.resolve('./e2e/teardown.js'),
  use: {
    baseURL: external || `http://localhost:${port}/`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, grepInvert: /@mobile/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
  webServer: external ? undefined : {
    command: 'node server/index.js',
    url: `http://localhost:${port}/`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
