'use strict';
// In-process server plus a small HTTP client for the integration tests.
const { before, after } = require('node:test');
const crypto = require('crypto');
const app = require('../../server/index');
const factory = require('./factory');

const PAGES_ORIGIN = 'https://spendtrack-app.github.io';

// Registers before/after hooks for one test file: starts the app on a random port,
// then deletes every user the file created and closes the pool.
function useServer() {
  const ctx = { base: '' };
  let server;
  before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    ctx.base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await factory.cleanup();
    await new Promise(r => server.close(r));
    await factory.close();
  });
  return ctx;
}

// Each client is one browser: it keeps its own cookie, and it has its own client IP
// (X-Forwarded-For, trusted from loopback) so rate limits never leak between tests.
// With `origin`, it behaves like the GitHub Pages front end: Origin header + bearer token.
function client(ctx, { origin, token, ip } = {}) {
  let cookie = !origin && token ? `st_session=${token}` : '';
  let bearer = origin ? token : null;
  const clientIp = ip || `10.${crypto.randomInt(256)}.${crypto.randomInt(256)}.${crypto.randomInt(1, 255)}`;

  async function request(method, path, body, headers = {}) {
    const res = await fetch(ctx.base + path, {
      method,
      headers: {
        'X-Forwarded-For': clientIp,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(cookie && { Cookie: cookie }),
        ...(origin && { Origin: origin }),
        ...(bearer && { Authorization: `Bearer ${bearer}` }),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0].endsWith('=') ? '' : setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (json?.token) bearer = json.token;
    return { status: res.status, body: json, text, headers: res.headers, setCookie };
  }
  return {
    request,
    get: (p, h) => request('GET', p, undefined, h),
    post: (p, b = {}, h) => request('POST', p, b, h),
    put: (p, b, h) => request('PUT', p, b, h),
    del: (p, h) => request('DELETE', p, undefined, h),
    get cookie() { return cookie; },
    get token() { return bearer; },
  };
}

// A signed-in client for a fresh factory user (fast path: no API sign-up).
async function signedIn(ctx, opts = {}) {
  const user = await factory.createUser(opts);
  const token = await factory.createSession(user.id);
  return { user, token, c: client(ctx, { token, origin: opts.origin }) };
}

const txBody = (over = {}) => ({ type: 'expense', category: 'dining', merchant: 'Cafe', amount: 12.5, date: factory.isoDate(), note: '', ...over });

module.exports = { PAGES_ORIGIN, useServer, client, signedIn, txBody };
