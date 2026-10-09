'use strict';
// Accounts and sessions: sign-up, sign-in, sign-out, expiry, and rate limiting.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const f = require('./support/factory');
const { useServer, client, signedIn } = require('./support/http');
const { DEFAULT_BUDGETS, EXPENSE_CATS } = require('../seed');

const ctx = useServer();
const signupBody = (over = {}) => ({ name: 'Ada Lovelace', email: f.track(f.uniqueEmail()), password: f.PASSWORD, sample: false, ...over });

describe('sign up', { concurrency: true }, () => {
  it('creates the account, signs in with a hardened cookie, and stores only a bcrypt hash', async () => {
    const c = client(ctx);
    const body = signupBody();
    const r = await c.post('/api/auth/signup', body);

    assert.equal(r.status, 201);
    assert.deepEqual(Object.keys(r.body.user).sort(), ['email', 'id', 'name']);
    assert.equal(r.body.token, undefined, 'same-origin clients never see the raw token');
    assert.match(r.setCookie, /^st_session=[A-Za-z0-9_-]{43};/);
    assert.match(r.setCookie, /; HttpOnly/i);
    assert.match(r.setCookie, /; SameSite=Lax/i);
    assert.match(r.setCookie, /; Path=\//i);
    assert.match(r.setCookie, /; Max-Age=2592000/i);

    const me = await c.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, body.email);

    const user = await f.row('SELECT password_hash FROM users WHERE email = ?', [body.email]);
    assert.match(user.password_hash, /^\$2[aby]\$12\$/);
    const token = c.cookie.split('=')[1];
    const session = await f.row('SELECT token_hash FROM sessions WHERE token_hash = ?', [f.sha256(token)]);
    assert.ok(session, 'only the SHA-256 of the token is stored');
    assert.equal(await f.row('SELECT 1 FROM sessions WHERE token_hash = ?', [token]), undefined);
  });

  it('starts empty, with default budgets and sample data only when asked', async () => {
    const empty = client(ctx);
    await empty.post('/api/auth/signup', signupBody({ sample: false }));
    const d1 = (await empty.get('/api/data')).body;
    assert.deepEqual(d1.transactions, []);
    assert.deepEqual(d1.budgets, Object.fromEntries(EXPENSE_CATS.map(k => [k, 0])));

    const withSample = client(ctx);
    await withSample.post('/api/auth/signup', signupBody({ sample: true }));
    const d2 = (await withSample.get('/api/data')).body;
    assert.ok(d2.transactions.length > 50);
    assert.deepEqual(d2.budgets, DEFAULT_BUDGETS);
  });

  it('normalises email case and whitespace', async () => {
    const email = f.track(f.uniqueEmail());
    const r = await client(ctx).post('/api/auth/signup', signupBody({ email: `  ${email.toUpperCase()} ` }));
    assert.equal(r.status, 201);
    assert.equal(r.body.user.email, email);
  });

  it('rejects a duplicate email with 409, even when two sign-ups race', async () => {
    const body = signupBody();
    const statuses = (await Promise.all([client(ctx).post('/api/auth/signup', body), client(ctx).post('/api/auth/signup', body)]))
      .map(r => r.status).sort();
    assert.deepEqual(statuses, [201, 409]);
    const again = await client(ctx).post('/api/auth/signup', { ...body, email: body.email.toUpperCase() });
    assert.equal(again.status, 409);
    assert.match(again.body.error, /already exists/);
  });

  const invalid = [
    ['missing name', { name: '' }],
    ['name over 80 chars', { name: 'x'.repeat(81) }],
    ['malformed email', { email: 'not-an-email' }],
    ['email without domain dot', { email: 'a@b' }],
    ['password under 8 chars', { password: '1234567' }],
    ['password over 72 chars (bcrypt limit)', { password: 'x'.repeat(73) }],
  ];
  for (const [name, over] of invalid) {
    it(`rejects ${name} with 400 and creates nothing`, async () => {
      const body = signupBody(over);
      const r = await client(ctx).post('/api/auth/signup', body);
      assert.equal(r.status, 400);
      assert.ok(r.body.error);
      assert.equal(r.setCookie, null);
      assert.equal(await f.row('SELECT 1 FROM users WHERE email = ?', [String(body.email).toLowerCase()]), undefined);
    });
  }

  it('accepts the boundary values (80-char name, 8- and 72-char passwords)', async () => {
    for (const over of [{ name: 'x'.repeat(80), password: '12345678' }, { password: 'y'.repeat(72) }]) {
      const body = signupBody(over);
      const c = client(ctx);
      assert.equal((await c.post('/api/auth/signup', body)).status, 201);
      assert.equal((await client(ctx).post('/api/auth/login', { email: body.email, password: body.password })).status, 200);
    }
  });
});

describe('sign in', { concurrency: true }, () => {
  it('accepts the right password with any email casing', async () => {
    const u = await f.createUser();
    const r = await client(ctx).post('/api/auth/login', { email: ` ${u.email.toUpperCase()} `, password: u.password });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.user, { id: u.id, name: u.name, email: u.email });
  });

  it('gives the same 401 for a wrong password and an unknown email (no account enumeration)', async () => {
    const u = await f.createUser();
    const wrong = await client(ctx).post('/api/auth/login', { email: u.email, password: 'wrong password' });
    const unknown = await client(ctx).post('/api/auth/login', { email: f.uniqueEmail(), password: 'wrong password' });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.body.error, unknown.body.error);
    assert.equal(wrong.setCookie, null);
  });

  it('keeps separate sessions per device; signing out one leaves the other signed in', async () => {
    const u = await f.createUser();
    const phone = client(ctx), laptop = client(ctx);
    await phone.post('/api/auth/login', { email: u.email, password: u.password });
    await laptop.post('/api/auth/login', { email: u.email, password: u.password });
    assert.notEqual(phone.cookie, laptop.cookie);

    const out = await phone.post('/api/auth/logout');
    assert.equal(out.status, 200);
    assert.match(out.setCookie, /^st_session=;.*Expires=Thu, 01 Jan 1970/i);
    assert.equal((await phone.get('/api/auth/me')).status, 401);
    assert.equal((await laptop.get('/api/auth/me')).status, 200);
  });
});

describe('sessions', { concurrency: true }, () => {
  it('sign-out deletes the session server-side, so a copied cookie stops working', async () => {
    const { user, token, c } = await signedIn(ctx);
    await c.post('/api/auth/logout');
    assert.equal((await client(ctx, { token }).get('/api/data')).status, 401);
    assert.equal(await f.row('SELECT 1 FROM sessions WHERE user_id = ?', [user.id]), undefined);
  });

  it('rejects expired, unknown, and malformed session cookies', async () => {
    const u = await f.createUser();
    const expired = await f.createSession(u.id, { ttlMs: f.EXPIRED });
    for (const cookie of [`st_session=${expired}`, 'st_session=' + 'A'.repeat(43), 'st_session=', 'st_session=%E0%A4%A']) {
      const r = await client(ctx).get('/api/auth/me', { Cookie: cookie });
      assert.equal(r.status, 401, cookie);
    }
  });

  it('logging in again later cleans up expired sessions', async () => {
    const u = await f.createUser();
    await f.createSession(u.id, { ttlMs: f.EXPIRED });
    await client(ctx).post('/api/auth/login', { email: u.email, password: u.password });
    const { n } = await f.row('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at < UTC_TIMESTAMP()', [u.id]);
    assert.equal(n, 0);
  });
});

describe('rate limiting', { concurrency: true }, () => {
  it('allows 30 auth attempts per IP per 15 minutes, shared across sign-up and sign-in, then 429', async () => {
    const attacker = client(ctx, { ip: '203.0.113.7' });
    const u = await f.createUser();
    // Invalid sign-ups still count, and they are cheap (no bcrypt).
    const burst = await Promise.all(Array.from({ length: 30 }, () => attacker.post('/api/auth/signup', {})));
    assert.ok(burst.every(r => r.status === 400));
    assert.ok(burst[0].headers.get('ratelimit'), 'standard RateLimit header is sent');

    const blocked = await attacker.post('/api/auth/login', { email: u.email, password: u.password });
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.error, /Too many attempts/);

    // Other clients are unaffected.
    const other = await client(ctx, { ip: '203.0.113.8' }).post('/api/auth/login', { email: u.email, password: u.password });
    assert.equal(other.status, 200);
  });

  it('does not rate-limit normal API use', async () => {
    const { c } = await signedIn(ctx);
    const results = await Promise.all(Array.from({ length: 40 }, () => c.get('/api/auth/me')));
    assert.ok(results.every(r => r.status === 200));
  });
});

describe('deleting an account', { concurrency: true }, () => {
  const counts = async userId => ({
    users: (await f.row('SELECT COUNT(*) AS n FROM users WHERE id = ?', [userId])).n,
    sessions: (await f.row('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', [userId])).n,
    transactions: (await f.row('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?', [userId])).n,
    budgets: (await f.row('SELECT COUNT(*) AS n FROM budgets WHERE user_id = ?', [userId])).n,
    oauth: (await f.row('SELECT COUNT(*) AS n FROM oauth_accounts WHERE user_id = ?', [userId])).n,
  });

  it('removes the account and everything that belongs to it, and ends the session', async () => {
    const { user, c } = await signedIn(ctx);
    await f.createTx(user.id);
    await f.createSession(user.id); // a second device
    await f.row('INSERT INTO oauth_accounts (user_id, provider, provider_user_id, email) VALUES (?, ?, ?, ?)', [user.id, 'google', `g-${user.id}`, user.email]);
    const other = await signedIn(ctx);
    await f.createTx(other.user.id);
    assert.ok((await counts(user.id)).transactions > 0);

    const r = await c.del('/api/auth/account');
    assert.equal(r.status, 200);
    assert.match(r.setCookie, /^st_session=;/, 'the session cookie is cleared');
    assert.deepEqual(await counts(user.id), { users: 0, sessions: 0, transactions: 0, budgets: 0, oauth: 0 });
    assert.equal((await c.get('/api/auth/me')).status, 401);
    assert.equal((await counts(other.user.id)).transactions, 1, 'other accounts are untouched');
  });

  it('requires a session, and works for the GitHub Pages copy with its bearer token', async () => {
    assert.equal((await client(ctx).del('/api/auth/account')).status, 401);
    const { user, c } = await signedIn(ctx, { origin: 'https://spendtrack-app.github.io' });
    assert.equal((await c.del('/api/auth/account')).status, 200);
    assert.equal((await counts(user.id)).users, 0);
  });

  it('refuses a cross-site request', async () => {
    const { user, token } = await signedIn(ctx);
    const r = await client(ctx, { token }).del('/api/auth/account', { Origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    assert.equal((await counts(user.id)).users, 1);
  });
});
