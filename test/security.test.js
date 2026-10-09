'use strict';
// HTTP-level security: headers, what is served, authentication on every route,
// CSRF, CORS + bearer tokens for the GitHub Pages origin, and malformed input.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const f = require('./support/factory');
const { PAGES_ORIGIN, useServer, client, signedIn, txBody } = require('./support/http');

const ctx = useServer();
const raw = (path, init) => fetch(ctx.base + path, init);

describe('security headers', { concurrency: true }, () => {
  it('are set on pages and API responses, and the framework is not advertised', async () => {
    for (const path of ['/', '/api/auth/me']) {
      const r = await raw(path);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', path);
      assert.equal(r.headers.get('x-frame-options'), 'DENY', path);
      assert.equal(r.headers.get('referrer-policy'), 'same-origin', path);
      assert.equal(r.headers.get('x-powered-by'), null, path);
    }
  });
});

describe('static files', { concurrency: true }, () => {
  it('serves exactly the front-end files with correct content types', async () => {
    const expected = { '/': 'text/html', '/index.html': 'text/html', '/privacy.html': 'text/html', '/app.js': 'javascript', '/seed.js': 'javascript', '/api-config.js': 'javascript', '/styles.css': 'text/css' };
    for (const [path, type] of Object.entries(expected)) {
      const r = await raw(path);
      assert.equal(r.status, 200, path);
      assert.match(r.headers.get('content-type'), new RegExp(type), path);
    }
  });

  it('never exposes server code, config, secrets, or repo files', async () => {
    for (const path of ['/server/config.js', '/server/index.js', '/package.json', '/package-lock.json', '/.env', '/.git/config',
      '/scripts/setup.sh', '/migrations/001_init.sql', '/test/auth.test.js', '/e2e/auth.spec.js', '/playwright.config.js',
      '/README.md', '/node_modules/express/package.json', '/%2e%2e/%2e%2e/etc/passwd', '/..%2fpackage.json']) {
      const r = await raw(path);
      assert.equal(r.status, 404, path);
      assert.doesNotMatch(await r.text(), /DB_PASSWORD|require\(|"dependencies"/, path);
    }
  });
});

describe('authentication', { concurrency: true }, () => {
  const protectedRoutes = [
    ['GET', '/api/auth/me'], ['GET', '/api/data'], ['POST', '/api/transactions', txBody()],
    ['PUT', '/api/transactions/1', { ...txBody(), version: 1 }], ['DELETE', '/api/transactions/1'],
    ['PUT', '/api/budgets/dining', { amount: 1 }], ['POST', '/api/reset', {}],
  ];
  for (const [method, path, body] of protectedRoutes) {
    it(`${method} ${path} requires a session`, async () => {
      const r = await client(ctx).request(method, path, body);
      assert.equal(r.status, 401);
      assert.deepEqual(r.body, { error: 'Please sign in.' });
    });
  }

  it('never returns password hashes or session tokens in API responses', async () => {
    const u = await f.createUser({ sample: true });
    const c = client(ctx);
    const responses = [await c.post('/api/auth/login', { email: u.email, password: u.password }), await c.get('/api/auth/me'), await c.get('/api/data')];
    for (const r of responses) {
      assert.doesNotMatch(r.text, /\$2[aby]\$|password|token_hash/i);
      assert.equal(r.body.token, undefined);
    }
  });
});

describe('CSRF protection (cookie sessions)', { concurrency: true }, () => {
  it('rejects writes that a cross-site HTML form could send (415)', async () => {
    const { user, c } = await signedIn(ctx);
    for (const type of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain']) {
      const r = await c.request('POST', '/api/transactions', 'type=expense', { 'Content-Type': type });
      assert.equal(r.status, 415, type);
    }
    assert.equal((await f.row('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?', [user.id])).n, 0);
  });

  it('rejects JSON writes from a foreign Origin (403) but accepts our own origin', async () => {
    const { user, c } = await signedIn(ctx);
    const t = await f.createTx(user.id);
    assert.equal((await c.post('/api/transactions', txBody(), { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await c.del(`/api/transactions/${t.id}`, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await c.post('/api/transactions', txBody(), { Origin: 'null' })).status, 403);
    assert.equal((await c.post('/api/transactions', txBody(), { Origin: ctx.base })).status, 201);
    assert.ok(await f.row('SELECT 1 FROM transactions WHERE id = ?', [t.id]), 'cross-site delete did not happen');
  });
});

describe('cross-origin API for GitHub Pages', { concurrency: true }, () => {
  it('answers preflight only for the allowlisted origin, without credentials', async () => {
    const preflight = origin => raw('/api/transactions', { method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type,authorization' } });
    const ok = await preflight(PAGES_ORIGIN);
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), PAGES_ORIGIN);
    assert.match(ok.headers.get('access-control-allow-methods'), /PUT/);
    assert.match(ok.headers.get('access-control-allow-headers'), /Authorization/i);
    assert.equal(ok.headers.get('access-control-allow-credentials'), null);
    assert.match(ok.headers.get('vary'), /Origin/);

    for (const origin of ['https://evil.example', 'https://spendtrack-app.github.io.evil.example', 'http://spendtrack-app.github.io', 'https://shubin123.github.io']) {
      assert.equal((await preflight(origin)).headers.get('access-control-allow-origin'), null, origin);
    }
  });

  it('issues a bearer token on sign-in and accepts it for the full CRUD cycle', async () => {
    const u = await f.createUser();
    const pages = client(ctx, { origin: PAGES_ORIGIN });
    const login = await pages.post('/api/auth/login', { email: u.email, password: u.password });
    assert.equal(login.status, 200);
    assert.match(login.body.token, /^[A-Za-z0-9_-]{43}$/);

    const t = (await pages.post('/api/transactions', txBody())).body.transaction;
    assert.equal((await pages.put(`/api/transactions/${t.id}`, { ...txBody({ amount: 1 }), version: 1 })).status, 200);
    assert.equal((await pages.del(`/api/transactions/${t.id}`)).status, 200);
    assert.equal((await pages.post('/api/auth/logout')).status, 200);
    assert.equal((await pages.get('/api/auth/me')).status, 401, 'token is revoked on sign-out');
  });

  it('ignores cookies from the allowlisted origin, and bearer tokens from same-origin requests', async () => {
    const u = await f.createUser();
    const token = await f.createSession(u.id);
    const viaCookie = await raw('/api/auth/me', { headers: { Origin: PAGES_ORIGIN, Cookie: `st_session=${token}` } });
    assert.equal(viaCookie.status, 401);
    const viaBearerSameOrigin = await raw('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(viaBearerSameOrigin.status, 401);
    const viaBearer = await raw('/api/auth/me', { headers: { Origin: PAGES_ORIGIN, Authorization: `Bearer ${token}` } });
    assert.equal(viaBearer.status, 200);
  });

  it('rejects malformed, expired, and unknown bearer tokens', async () => {
    const u = await f.createUser();
    const expired = await f.createSession(u.id, { ttlMs: f.EXPIRED });
    for (const auth of [`Bearer ${expired}`, `Bearer ${'A'.repeat(43)}`, 'Bearer short', 'Basic dXNlcjpwYXNz', `bearer ${expired}`, '']) {
      const r = await raw('/api/auth/me', { headers: { Origin: PAGES_ORIGIN, Authorization: auth } });
      assert.equal(r.status, 401, auth);
    }
  });
});

describe('malformed requests', { concurrency: true }, () => {
  it('answers invalid JSON with 400, not 500', async () => {
    const { c } = await signedIn(ctx);
    const r = await c.request('POST', '/api/transactions', '{"amount": ', { 'Content-Type': 'application/json' });
    assert.equal(r.status, 400);
    assert.ok(r.body.error);
  });

  it('refuses bodies over 32 KB with 413', async () => {
    const { c } = await signedIn(ctx);
    const r = await c.post('/api/transactions', txBody({ note: 'x'.repeat(40 * 1024) }));
    assert.equal(r.status, 413);
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const { c } = await signedIn(ctx);
    const r = await c.get('/api/does-not-exist');
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: 'Not found.' });
  });
});
