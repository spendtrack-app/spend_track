'use strict';
// Playwright fixtures. Test data is created straight in MySQL (test/support/factory),
// so each test starts in the exact state it needs, in milliseconds, and only drives
// the UI it is about. Works against the local server (cookie session) and the GitHub
// Pages site (bearer token in localStorage, API reached through api-config.js).
const crypto = require('crypto');
const base = require('@playwright/test');
const factory = require('../../test/support/factory');
const { App } = require('./app');

const test = base.test.extend({
  // test.use({ fakeClock: true }) installs Playwright's clock before the app loads. Time
  // still flows until the test calls page.clock.pauseAt(); after that the page's timers
  // fire only on page.clock.runFor(), so timing-sensitive tests never sleep.
  fakeClock: [false, { option: true }],

  // How the site under test reaches its API. Worker-scoped: detected once per worker.
  target: [async ({ playwright }, use, workerInfo) => {
    const baseURL = workerInfo.project.use.baseURL;
    const req = await playwright.request.newContext();
    const me = await req.get(new URL('api/auth/me', baseURL).href);
    let target;
    if ((me.headers()['content-type'] || '').includes('application/json')) {
      target = { auth: 'cookie', baseURL };
    } else {
      const cfg = await (await req.get(new URL(`api-config.js?t=${Date.now()}`, baseURL).href)).text();
      const apiBase = cfg.match(/SPEND_TRACK_API\s*=\s*'([^']+)'/)?.[1];
      if (!apiBase) throw new Error(`${baseURL} has no API (api-config.js is empty). Run: npm run tunnel -- --publish`);
      target = { auth: 'bearer', baseURL, apiBase };
    }
    await req.dispose();
    await use(target);
  }, { scope: 'worker' }],

  // Closes this worker's DB pool once all its tests are done.
  db: [async ({}, use) => { await use(factory); await factory.close(); }, { scope: 'worker', auto: true }],

  // A fresh account per test (email e2e-…@example.test), deleted afterwards.
  account: async ({ db }, use) => {
    await use(await db.createUser({ prefix: 'e2e', name: 'Ada Lovelace' }));
    await db.cleanup();
  },

  // Each test is its own client. Against the local server, give it its own client IP
  // (X-Forwarded-For is trusted from loopback only) so the per-IP sign-in rate limit,
  // which the integration tests cover, doesn't leak between tests and runs. Through the
  // tunnel this header can't be spoofed, which is the point.
  app: async ({ page, target }, use) => {
    if (target.auth === 'cookie') {
      const ip = `10.${crypto.randomInt(256)}.${crypto.randomInt(256)}.${crypto.randomInt(1, 255)}`;
      await page.context().setExtraHTTPHeaders({ 'X-Forwarded-For': ip });
    }
    await use(new App(page));
  },

  // The app, open and signed in as `account`, without going through the sign-in form.
  signedIn: async ({ page, context, target, account, db, app, fakeClock }, use) => {
    if (fakeClock) await page.clock.install({ time: new Date() });
    const token = await db.createSession(account.id);
    if (target.auth === 'cookie') {
      await context.addCookies([{ name: 'st_session', value: token, url: target.baseURL, httpOnly: true, sameSite: 'Lax' }]);
    } else {
      await context.addInitScript(t => { if (!localStorage.getItem('spendtrack.token')) localStorage.setItem('spendtrack.token', t); }, token);
    }
    await app.open();
    await base.expect(app.accountPanel).toContainText(account.email);
    await app.getStarted(); // every fresh visit starts on the front page
    await use(app);
  },
});

module.exports = { test, expect: base.expect, factory };
