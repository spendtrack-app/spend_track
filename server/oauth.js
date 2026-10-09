'use strict';
// Sign in with Google or GitHub: OAuth 2.0 authorization code flow with PKCE.
//
//   GET  /api/auth/providers                 which providers this server offers
//   GET  /api/auth/oauth/:provider/start      redirects the browser to the provider
//   GET  /api/auth/oauth/:provider/callback   the provider redirects back here
//   POST /api/auth/oauth/exchange {code}      the page trades a one-time code for a session
//
// The callback never puts a session token in a URL. It sends the browser back to the page
// with a one-time code in the fragment (#login_code=…, valid for 60 s, single use), and the
// page exchanges it like a normal login: the same-origin app gets the HttpOnly cookie and
// the GitHub Pages copy gets a bearer token.
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { getPool, withTransaction } = require('./db');
const { readCookie, createSession, setSessionCookie, publicUser } = require('./auth');

const STATE_COOKIE = 'st_oauth';
const STATE_PATH = '/api/auth/oauth';
const STATE_TTL_MS = 10 * 60 * 1000; // time allowed on the provider's consent screen
const CODE_TTL_MS = 60 * 1000;
const MAX_PENDING = 5000;
const TIMEOUT = 10_000;

const random = () => crypto.randomBytes(32).toString('base64url');
const challengeOf = verifier => crypto.createHash('sha256').update(verifier).digest('base64url');

async function fetchJson(url, options) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return body;
}

// Provider endpoints. Exported so the integration tests can point them at a fake provider.
const PROVIDERS = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    extraAuthParams: { prompt: 'select_account' },
    async profile(accessToken) {
      const u = await fetchJson(this.userinfoUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      return { id: String(u.sub || ''), email: u.email, emailVerified: u.email_verified === true, name: u.name };
    },
  },
  github: {
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    apiUrl: 'https://api.github.com',
    scope: 'read:user user:email',
    extraAuthParams: { allow_signup: 'true' },
    async profile(accessToken) {
      const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'spend-track' };
      const u = await fetchJson(`${this.apiUrl}/user`, { headers });
      const emails = await fetchJson(`${this.apiUrl}/user/emails`, { headers });
      const verified = (Array.isArray(emails) ? emails : []).filter(e => e.verified);
      const best = verified.find(e => e.primary) || verified[0];
      return { id: String(u.id || ''), email: best?.email, emailVerified: !!best, name: u.name || u.login };
    },
  },
};

const configured = name => !!(config.oauth[name]?.clientId && config.oauth[name]?.clientSecret);

// Short-lived, in-memory state. A restart only means an in-progress sign-in has to be retried.
const pending = new Map();    // state -> { provider, verifier, returnTo, expires }
const loginCodes = new Map(); // one-time code -> { userId, expires }

function sweep(map) {
  const now = Date.now();
  for (const [k, v] of map) if (v.expires < now) map.delete(k);
}
function remember(map, key, value) {
  if (map.size >= MAX_PENDING) sweep(map);
  if (map.size >= MAX_PENDING) return false;
  map.set(key, value);
  return true;
}
function take(map, key) {
  const v = key && map.get(key);
  if (key) map.delete(key);
  return v && v.expires >= Date.now() ? v : null;
}

const requestOrigin = req => `${req.protocol}://${req.get('host')}`;
const apiOrigin = req => (config.publicUrl ? new URL(config.publicUrl).origin : requestOrigin(req));

// Where the browser may be sent back to: the GitHub Pages site (ALLOWED_ORIGINS), this API's
// own address, or the app on this machine. Anything else falls back to this API's own page.
function safeReturn(req, value) {
  const fallback = `${apiOrigin(req)}/`;
  let url;
  try { url = new URL(String(value || '')); } catch { return fallback; }
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  const allowed = config.allowedOrigins.includes(url.origin) || url.origin === apiOrigin(req) || local;
  if (!allowed || !['http:', 'https:'].includes(url.protocol)) return fallback;
  url.hash = '';
  return url.href;
}

function finish(res, returnTo, { code, error }) {
  const url = new URL(returnTo);
  url.hash = code ? `login_code=${code}` : `login_error=${error}`;
  res.set('Cache-Control', 'no-store');
  res.redirect(303, url.href);
}

// Finds the user for a provider identity, linking it to an existing account with the same
// (provider-verified) email, or creating a new password-less account.
async function userFor(provider, profile) {
  const email = profile.email.trim().toLowerCase();
  const name = String(profile.name || email.split('@')[0]).trim().slice(0, 80) || 'Spend Track user';
  const link = async conn => {
    const [linked] = await conn.query('SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?', [provider, profile.id]);
    if (linked[0]) return linked[0].user_id;
    const [existing] = await conn.query('SELECT id FROM users WHERE email = ? FOR UPDATE', [email]);
    let userId = existing[0]?.id;
    if (!userId) {
      const [r] = await conn.query('INSERT INTO users (email, name, password_hash) VALUES (?, ?, NULL)', [email, name]);
      userId = r.insertId;
    }
    await conn.query('INSERT INTO oauth_accounts (user_id, provider, provider_user_id, email) VALUES (?, ?, ?, ?)',
      [userId, provider, profile.id, email]);
    return userId;
  };
  try {
    return await withTransaction(link);
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    return withTransaction(link); // a parallel first sign-in won the race; this time it finds it
  }
}

const router = express.Router();
const startLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a few minutes.' } });
const exchangeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a few minutes.' } });

router.get('/providers', (_req, res) => {
  res.json({ google: configured('google'), github: configured('github') });
});

router.get('/oauth/:provider/start', startLimiter, (req, res) => {
  const name = req.params.provider;
  const provider = PROVIDERS[name];
  if (!provider || !configured(name)) return res.status(404).json({ error: 'That sign-in option is not available.' });
  // The state cookie must live on the host the provider will redirect back to.
  // (Compares hosts only: behind a TLS proxy the request may arrive as plain http.)
  if (config.publicUrl && req.get('host') !== new URL(config.publicUrl).host) {
    return res.redirect(302, config.publicUrl + req.originalUrl);
  }
  const state = random();
  const verifier = random();
  const returnTo = safeReturn(req, req.query.return);
  if (!remember(pending, state, { provider: name, verifier, returnTo, expires: Date.now() + STATE_TTL_MS })) {
    return res.status(503).json({ error: 'Too many sign-ins in progress. Try again in a minute.' });
  }
  res.cookie(STATE_COOKIE, state, {
    httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: STATE_PATH, maxAge: STATE_TTL_MS,
  });
  const url = new URL(provider.authUrl);
  url.search = new URLSearchParams({
    client_id: config.oauth[name].clientId,
    redirect_uri: `${apiOrigin(req)}${STATE_PATH}/${name}/callback`,
    response_type: 'code',
    scope: provider.scope,
    state,
    code_challenge: challengeOf(verifier),
    code_challenge_method: 'S256',
    ...provider.extraAuthParams,
  }).toString();
  res.set('Cache-Control', 'no-store');
  res.redirect(302, url.href);
});

router.get('/oauth/:provider/callback', async (req, res) => {
  const name = req.params.provider;
  const provider = PROVIDERS[name];
  if (!provider || !configured(name)) return res.status(404).json({ error: 'That sign-in option is not available.' });

  // The state must match the one issued to this browser (stops forged sign-ins).
  const state = String(req.query.state || '');
  const cookieState = readCookie(req, STATE_COOKIE);
  res.clearCookie(STATE_COOKIE, { path: STATE_PATH });
  const flow = take(pending, state);
  if (!flow || !cookieState || cookieState !== state || flow.provider !== name) {
    return finish(res, safeReturn(req, flow?.returnTo), { error: 'expired' });
  }
  if (req.query.error) return finish(res, flow.returnTo, { error: req.query.error === 'access_denied' ? 'cancelled' : 'failed' });

  try {
    const tokens = await fetchJson(provider.tokenUrl, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(req.query.code || ''),
        redirect_uri: `${apiOrigin(req)}${STATE_PATH}/${name}/callback`,
        client_id: config.oauth[name].clientId,
        client_secret: config.oauth[name].clientSecret,
        code_verifier: flow.verifier,
      }),
    });
    if (!tokens.access_token) throw new Error(`no access token (${tokens.error || 'unknown error'})`);
    const profile = await provider.profile(tokens.access_token);
    if (!profile.id) throw new Error('profile has no id');
    if (!profile.email || !profile.emailVerified) return finish(res, flow.returnTo, { error: 'no_verified_email' });

    const userId = await userFor(name, profile);
    const code = random();
    if (!remember(loginCodes, code, { userId, expires: Date.now() + CODE_TTL_MS })) throw new Error('too many pending codes');
    finish(res, flow.returnTo, { code });
  } catch (err) {
    console.error(`[oauth] ${name} sign-in failed: ${err.message}`);
    finish(res, flow.returnTo, { error: 'failed' });
  }
});

router.post('/oauth/exchange', exchangeLimiter, async (req, res) => {
  const entry = take(loginCodes, String(req.body?.code || ''));
  if (!entry) return res.status(400).json({ error: 'That sign-in expired. Please try again.' });
  const pool = getPool();
  const [rows] = await pool.query('SELECT id, name, email FROM users WHERE id = ?', [entry.userId]);
  if (!rows[0]) return res.status(400).json({ error: 'That sign-in expired. Please try again.' });
  const token = await createSession(pool, rows[0].id);
  setSessionCookie(res, token);
  res.json({ user: publicUser(rows[0]), ...(req.crossOrigin && { token }) });
});

module.exports = { router, PROVIDERS };
