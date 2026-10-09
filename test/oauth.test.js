'use strict';
// Sign in with Google / GitHub, end to end against a fake OAuth provider: redirects, PKCE,
// state checks, account creation and linking, the one-time code exchange, and safe returns.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const f = require('./support/factory');
const { useServer, client, PAGES_ORIGIN } = require('./support/http');
const config = require('../server/config');
const { PROVIDERS } = require('../server/oauth');

const ctx = useServer();
const sha = v => crypto.createHash('sha256').update(v || '').digest('base64url');

// A fake provider: issues access tokens only for codes whose PKCE verifier matches the
// challenge sent to /authorize, and serves the profile registered for each token.
const fake = { base: '', codes: new Map(), profiles: new Map(), tokenRequests: [] };
let fakeServer;
before(async () => {
  fakeServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && url.pathname === '/token') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const p = new URLSearchParams(raw);
      fake.tokenRequests.push(Object.fromEntries(p));
      const grant = fake.codes.get(p.get('code'));
      fake.codes.delete(p.get('code'));
      if (!grant || grant.challenge !== sha(p.get('code_verifier')) || p.get('client_secret') !== 'test-secret') {
        return send(400, { error: 'invalid_grant' });
      }
      return send(200, { access_token: grant.accessToken, token_type: 'bearer' });
    }
    const profile = fake.profiles.get((req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!profile) return send(401, { error: 'bad token' });
    if (url.pathname === '/userinfo') return send(200, profile.google);
    if (url.pathname === '/user') return send(200, profile.githubUser);
    if (url.pathname === '/user/emails') return send(200, profile.githubEmails);
    send(404, {});
  });
  await new Promise(r => fakeServer.listen(0, '127.0.0.1', r));
  fake.base = `http://127.0.0.1:${fakeServer.address().port}`;
  Object.assign(PROVIDERS.google, { authUrl: `${fake.base}/authorize`, tokenUrl: `${fake.base}/token`, userinfoUrl: `${fake.base}/userinfo` });
  Object.assign(PROVIDERS.github, { authUrl: `${fake.base}/gh/authorize`, tokenUrl: `${fake.base}/token`, apiUrl: fake.base });
  config.oauth.google = { clientId: 'google-test-id', clientSecret: 'test-secret' };
  config.oauth.github = { clientId: 'github-test-id', clientSecret: 'test-secret' };
});
after(() => new Promise(r => fakeServer.close(r)));

// One browser: its own cookie jar and client IP, and it never follows redirects by itself.
function browser() {
  const ip = `10.${crypto.randomInt(256)}.${crypto.randomInt(256)}.${crypto.randomInt(1, 255)}`;
  const jar = {};
  async function go(path) {
    const res = await fetch(ctx.base + path, {
      redirect: 'manual',
      headers: { 'X-Forwarded-For': ip, Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    for (const c of res.headers.getSetCookie()) {
      const [k, v] = c.split(';')[0].split('=');
      if (!v || /expires=thu, 01 jan 1970/i.test(c)) delete jar[k]; else jar[k] = v;
    }
    return res;
  }
  return { go, jar };
}

const googleProfile = (email, over = {}) => ({ google: { sub: `g-${crypto.randomUUID()}`, email, email_verified: true, name: 'Grace Google', ...over } });

// Runs start -> (provider consent) -> callback, and returns where the browser lands.
async function signIn(b, provider, profile, { returnTo } = {}) {
  const start = await b.go(`/api/auth/oauth/${provider}/start${returnTo ? `?return=${encodeURIComponent(returnTo)}` : ''}`);
  assert.equal(start.status, 302);
  const auth = new URL(start.headers.get('location'));
  const code = crypto.randomBytes(8).toString('hex');
  const accessToken = `at-${code}`;
  fake.codes.set(code, { challenge: auth.searchParams.get('code_challenge'), accessToken });
  fake.profiles.set(accessToken, profile);
  const callback = await b.go(`/api/auth/oauth/${provider}/callback?code=${code}&state=${auth.searchParams.get('state')}`);
  assert.equal(callback.status, 303);
  return { start, auth, back: new URL(callback.headers.get('location')) };
}
const loginCode = back => /^#login_code=([A-Za-z0-9_-]{43})$/.exec(back.hash)?.[1];

// Changes the shared provider config, so it runs on its own before the parallel tests.
describe('provider configuration', () => {
  it('lists only configured providers and refuses unconfigured ones', async () => {
    const saved = config.oauth.github;
    config.oauth.github = { clientId: 'github-test-id', clientSecret: '' };
    try {
      assert.deepEqual((await client(ctx).get('/api/auth/providers')).body, { google: true, github: false });
      assert.equal((await browser().go('/api/auth/oauth/github/start')).status, 404);
      assert.equal((await browser().go('/api/auth/oauth/twitter/start')).status, 404);
    } finally {
      config.oauth.github = saved;
    }
  });
});

describe('sign in with Google or GitHub', { concurrency: true }, () => {
  it('Google: PKCE and state, a password-less account, and a single-use code', async () => {
    const email = f.track(f.uniqueEmail('oauth'));
    const b = browser();
    const { start, auth, back } = await signIn(b, 'google', googleProfile(email));

    assert.equal(auth.origin + auth.pathname, `${fake.base}/authorize`);
    assert.equal(auth.searchParams.get('client_id'), 'google-test-id');
    assert.equal(auth.searchParams.get('redirect_uri'), `${ctx.base}/api/auth/oauth/google/callback`);
    assert.equal(auth.searchParams.get('response_type'), 'code');
    assert.equal(auth.searchParams.get('scope'), 'openid email profile');
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    assert.match(auth.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
    const stateCookie = start.headers.getSetCookie().find(c => c.startsWith('st_oauth='));
    assert.match(stateCookie, /HttpOnly/i);
    assert.match(stateCookie, /SameSite=Lax/i);
    assert.match(stateCookie, /Path=\/api\/auth\/oauth/i);
    assert.equal(b.jar.st_oauth, undefined, 'the state cookie is cleared by the callback');

    // No return address given: back to this server's own page, with a code (never a session token).
    assert.equal(back.origin + back.pathname, `${ctx.base}/`);
    const code = loginCode(back);
    assert.ok(code);

    const c = client(ctx);
    const r = await c.post('/api/auth/oauth/exchange', { code });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.email, email);
    assert.equal(r.body.user.name, 'Grace Google');
    assert.equal(r.body.token, undefined, 'same-origin clients get the cookie, not the token');
    assert.equal((await c.get('/api/auth/me')).body.user.email, email);

    assert.equal((await client(ctx).post('/api/auth/oauth/exchange', { code })).status, 400, 'codes are single use');
    const user = await f.row('SELECT id, password_hash FROM users WHERE email = ?', [email]);
    assert.equal(user.password_hash, null);
    assert.equal((await f.row('SELECT provider FROM oauth_accounts WHERE user_id = ?', [user.id])).provider, 'google');
    const pw = await client(ctx).post('/api/auth/login', { email, password: f.PASSWORD });
    assert.equal(pw.status, 401, 'a password-less account cannot log in with a password');
  });

  it('signing in again with the same identity reuses the account', async () => {
    const email = f.track(f.uniqueEmail('oauth'));
    const profile = googleProfile(email);
    const first = await client(ctx).post('/api/auth/oauth/exchange', { code: loginCode((await signIn(browser(), 'google', profile)).back) });
    const second = await client(ctx).post('/api/auth/oauth/exchange', { code: loginCode((await signIn(browser(), 'google', profile)).back) });
    assert.equal(second.body.user.id, first.body.user.id);
    assert.equal((await f.row('SELECT COUNT(*) AS n FROM oauth_accounts WHERE user_id = ?', [first.body.user.id])).n, 1);
  });

  it('links to an existing email account when the provider verified the email', async () => {
    const existing = await f.createUser({ prefix: 'oauth' });
    const { back } = await signIn(browser(), 'google', googleProfile(existing.email.toUpperCase()));
    const r = await client(ctx).post('/api/auth/oauth/exchange', { code: loginCode(back) });
    assert.equal(r.body.user.id, existing.id);
    assert.equal(r.body.user.name, existing.name, 'the existing account is kept as it was');
    assert.equal((await client(ctx).post('/api/auth/login', { email: existing.email, password: f.PASSWORD })).status, 200);
  });

  it('GitHub: uses a verified email and falls back to the login name', async () => {
    const verified = f.track(f.uniqueEmail('oauth'));
    const unverified = f.track(f.uniqueEmail('oauth'));
    const profile = {
      githubUser: { id: crypto.randomInt(1e9), login: 'octo-dev', name: null },
      githubEmails: [{ email: unverified, primary: true, verified: false }, { email: verified, primary: false, verified: true }],
    };
    const { auth, back } = await signIn(browser(), 'github', profile);
    assert.equal(auth.searchParams.get('scope'), 'read:user user:email');
    const r = await client(ctx).post('/api/auth/oauth/exchange', { code: loginCode(back) });
    assert.equal(r.body.user.email, verified);
    assert.equal(r.body.user.name, 'octo-dev');
  });

  it('refuses an account without a verified email', async () => {
    const email = f.track(f.uniqueEmail('oauth'));
    const { back } = await signIn(browser(), 'google', googleProfile(email, { email_verified: false }));
    assert.equal(back.hash, '#login_error=no_verified_email');
    assert.equal(await f.row('SELECT id FROM users WHERE email = ?', [email]), undefined);
  });

  it('rejects a callback that does not match the browser that started it', async () => {
    const a = browser();
    const start = await a.go('/api/auth/oauth/google/start');
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const code = `forged-${crypto.randomUUID()}`;

    const forged = await browser().go(`/api/auth/oauth/google/callback?code=${code}&state=${state}`); // no state cookie
    assert.equal(new URL(forged.headers.get('location')).hash, '#login_error=expired');
    const replay = await a.go(`/api/auth/oauth/google/callback?code=${code}&state=${state}`); // state already used
    assert.equal(new URL(replay.headers.get('location')).hash, '#login_error=expired');
    assert.ok(!fake.tokenRequests.some(t => t.code === code), 'the provider was never asked for a token');
  });

  it('reports a cancelled consent screen', async () => {
    const b = browser();
    const start = await b.go('/api/auth/oauth/google/start');
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const r = await b.go(`/api/auth/oauth/google/callback?error=access_denied&state=${state}`);
    assert.equal(new URL(r.headers.get('location')).hash, '#login_error=cancelled');
  });

  it('only returns to the Pages site, this server, or the app on this machine', async () => {
    const landing = async returnTo => (await signIn(browser(), 'google', googleProfile(f.track(f.uniqueEmail('oauth'))), { returnTo })).back;
    assert.equal((await landing('https://evil.example/steal')).origin, ctx.base);
    assert.equal((await landing(`${PAGES_ORIGIN}.evil.example/`)).origin, ctx.base);
    const pages = await landing(`${PAGES_ORIGIN}/spend_track/#old`);
    assert.equal(pages.origin + pages.pathname, `${PAGES_ORIGIN}/spend_track/`);
    assert.equal((await landing('http://localhost:3000/')).origin, 'http://localhost:3000');
  });

  it('gives the GitHub Pages copy a bearer token', async () => {
    const email = f.track(f.uniqueEmail('oauth'));
    const { back } = await signIn(browser(), 'google', googleProfile(email), { returnTo: `${PAGES_ORIGIN}/spend_track/` });
    const pages = client(ctx, { origin: PAGES_ORIGIN });
    const r = await pages.post('/api/auth/oauth/exchange', { code: loginCode(back) });
    assert.equal(r.status, 200);
    assert.match(r.body.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await pages.get('/api/auth/me')).body.user.email, email);
  });

  it('turns provider failures into a sign-in error, not a crash', async () => {
    const b = browser();
    const start = await b.go('/api/auth/oauth/google/start');
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const r = await b.go(`/api/auth/oauth/google/callback?code=never-issued&state=${state}`);
    assert.equal(new URL(r.headers.get('location')).hash, '#login_error=failed');
  });
});
