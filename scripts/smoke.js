#!/usr/bin/env node
'use strict';
// Smoke test: a fast, non-destructive check that a deployment is alive and its
// critical paths work. Safe to run against the live site: it never resets data or
// changes budgets, and removes the one transaction it adds.
//
//   npm run smoke                                        # local server on $PORT (cookie auth)
//   npm run smoke -- http://host:3000                    # any server
//   npm run smoke -- --pages https://spendtrack-app.github.io/spend_track/
//        # the whole deployed chain: Pages site -> api-config.js -> tunnel -> API -> MySQL,
//        # authenticated as the Pages origin with a bearer token
//
// Account: SMOKE_EMAIL + SMOKE_PASSWORD sign in to a dedicated smoke account (nothing
// is left behind, no DB access needed). Without them, a throwaway account is created
// and deleted through the local DB config afterwards.
// Exit code 0 = healthy. Stops at the first failure, since later checks depend on it.
const crypto = require('crypto');

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const pagesUrl = opt('--pages');
const SLOW_MS = Number(process.env.SMOKE_SLOW_MS || 2000);
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 15000);

const green = s => `\x1b[32m${s}\x1b[0m`, red = s => `\x1b[31m${s}\x1b[0m`, yellow = s => `\x1b[33m${s}\x1b[0m`, dim = s => `\x1b[2m${s}\x1b[0m`;
let base, origin = null, cookie = '', token = '', throwaway = null;
const started = Date.now();

class SmokeFailure extends Error {}

async function http(method, url, { body, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (origin) { h.Origin = origin; if (token) h.Authorization = `Bearer ${token}`; }
  else if (cookie) h.Cookie = cookie;
  const res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (json?.token) token = json.token;
  return { status: res.status, headers: res.headers, text, json };
}
const api = (method, path, body) => http(method, `${base}/api/${path}`, { body });

async function check(name, fn) {
  const t0 = Date.now();
  let detail;
  try {
    detail = await fn();
  } catch (err) {
    console.log(`  ${red('✗')} ${name}\n      ${red(err instanceof SmokeFailure ? err.message : `${err.name}: ${err.message}${err.cause?.code ? ` (${err.cause.code})` : ''}`)}`);
    throw new SmokeFailure(name);
  }
  const ms = Date.now() - t0;
  const time = ms > SLOW_MS ? yellow(`${ms} ms (slow)`) : dim(`${ms} ms`);
  console.log(`  ${green('✓')} ${name} ${time}${detail ? dim(`  ${detail}`) : ''}`);
}
function expect(cond, message) { if (!cond) throw new SmokeFailure(message); }
function expectStatus(r, want) {
  if (r.status === 429) throw new SmokeFailure('rate limited (429): more than 30 sign-ins from this IP in 15 minutes. Wait, or restart the server to clear the in-memory limit.');
  expect(r.status === want, `expected HTTP ${want}, got ${r.status}: ${r.text.slice(0, 200)}`);
}

async function main() {
  if (pagesUrl) {
    const site = pagesUrl.endsWith('/') ? pagesUrl : pagesUrl + '/';
    origin = new URL(site).origin;
    console.log(`Smoke test: ${site} (GitHub Pages -> API)`);
    await check('Pages site is up and serves the app', async () => {
      const r = await http('GET', site);
      expectStatus(r, 200);
      expect(r.text.includes('app.js') && r.text.includes('api-config.js'), 'index.html does not load app.js and api-config.js');
    });
    await check('Pages front-end assets load', async () => {
      for (const f of ['app.js', 'seed.js', 'styles.css']) expectStatus(await http('GET', site + f), 200);
    });
    await check('api-config.js points at an API', async () => {
      const r = await http('GET', `${site}api-config.js?nocache=${Date.now()}`);
      expectStatus(r, 200);
      base = r.text.match(/SPEND_TRACK_API\s*=\s*'([^']+)'/)?.[1]?.replace(/\/+$/, '');
      expect(base, 'api-config.js has no API URL, so the site is in browser-only mode (run: npm run tunnel -- --publish)');
      return base;
    });
    await check('CORS preflight allows the Pages origin', async () => {
      const r = await http('OPTIONS', `${base}/api/transactions`, { headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' } });
      expect(r.status === 204 && r.headers.get('access-control-allow-origin') === origin,
        `preflight returned ${r.status}, allow-origin=${r.headers.get('access-control-allow-origin')} (is the tunnel up and ALLOWED_ORIGINS correct?)`);
    });
  } else {
    base = (argv[0] || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
    console.log(`Smoke test: ${base}`);
    await check('server is up and serves the app', async () => {
      const r = await http('GET', base + '/');
      expectStatus(r, 200);
      expect(r.text.includes('app.js'), 'index.html does not reference app.js');
      expect(r.headers.get('x-content-type-options') === 'nosniff', 'security headers missing');
    });
    await check('server code is not exposed', async () => {
      for (const p of ['/server/config.js', '/package.json', '/.env']) expectStatus(await http('GET', base + p), 404);
    });
  }

  await check('API answers and requires a session', async () => {
    const r = await api('GET', 'auth/me');
    expectStatus(r, 401);
    expect(r.json?.error, 'API did not return JSON (wrong URL, or tunnel pointing at something else?)');
  });

  await check('sign in', async () => {
    if (process.env.SMOKE_EMAIL) {
      const r = await api('POST', 'auth/login', { email: process.env.SMOKE_EMAIL, password: process.env.SMOKE_PASSWORD || '' });
      expectStatus(r, 200);
      return `as ${process.env.SMOKE_EMAIL}`;
    }
    throwaway = `smoke-${crypto.randomBytes(5).toString('hex')}@example.test`;
    const r = await api('POST', 'auth/signup', { name: 'Smoke Test', email: throwaway, password: crypto.randomBytes(12).toString('base64url'), sample: false });
    expectStatus(r, 201);
    return `throwaway ${throwaway}`;
  });
  await check('session is recognised', async () => expectStatus(await api('GET', 'auth/me'), 200));

  let txId;
  const merchant = `Smoke ${crypto.randomBytes(3).toString('hex')}`;
  await check('write: add a transaction', async () => {
    const r = await api('POST', 'transactions', { type: 'expense', category: 'dining', merchant, amount: 1.23, date: new Date().toISOString().slice(0, 10), note: 'smoke test' });
    expectStatus(r, 201);
    txId = r.json.transaction.id;
  });
  await check('read: it is stored in the database', async () => {
    const r = await api('GET', 'data');
    expectStatus(r, 200);
    expect(r.json.transactions.some(t => t.id === txId && t.merchant === merchant && t.amount === 1.23), 'new transaction missing from /api/data');
    return `${r.json.transactions.length} transaction(s)`;
  });
  await check('update with optimistic concurrency', async () => {
    const body = { type: 'expense', category: 'dining', merchant, amount: 2.34, date: new Date().toISOString().slice(0, 10), note: 'smoke test' };
    expectStatus(await api('PUT', `transactions/${txId}`, { ...body, version: 1 }), 200);
    expectStatus(await api('PUT', `transactions/${txId}`, { ...body, version: 1 }), 409);
  });
  await check('delete: clean up the transaction', async () => {
    expectStatus(await api('DELETE', `transactions/${txId}`), 200);
    txId = null;
  });
  await check('sign out ends the session', async () => {
    expectStatus(await api('POST', 'auth/logout', {}), 200);
    cookie = ''; token = '';
    expectStatus(await api('GET', 'auth/me'), 401);
  });
}

async function cleanup() {
  if (!throwaway) return;
  try {
    const { getPool } = require('../server/db');
    const [r] = await getPool().query('DELETE FROM users WHERE email = ?', [throwaway]);
    await getPool().end();
    if (r.affectedRows) console.log(`  ${green('✓')} removed throwaway account ${dim(throwaway)}`);
  } catch (err) {
    console.log(`  ${yellow('!')} could not remove ${throwaway} (${err.message}); set SMOKE_EMAIL/SMOKE_PASSWORD to use a fixed account`);
  }
}

main()
  .then(() => ({ ok: true }), err => {
    if (!(err instanceof SmokeFailure)) console.log(red(`  ✗ ${err.stack}`));
    return { ok: false };
  })
  .then(async ({ ok }) => {
    await cleanup();
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(ok ? green(`Smoke test passed in ${secs}s`) : red(`Smoke test FAILED after ${secs}s`));
    process.exit(ok ? 0 : 1);
  });
