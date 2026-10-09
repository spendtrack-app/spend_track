'use strict';
const path = require('path');
const express = require('express');
const config = require('./config');
const { getPool } = require('./db');
const auth = require('./auth');
const oauth = require('./oauth');
const data = require('./data');

const ROOT = path.join(__dirname, '..');
// Only the front-end files are served; server code and config are never exposed.
const STATIC_FILES = ['index.html', 'styles.css', 'app.js', 'seed.js', 'api-config.js'];

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy); // see config.trustProxy

app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  });
  next();
});

// Liveness + database check for systemd, load balancers, and uptime monitors. No auth,
// no session lookup, never cached.
app.get('/api/health', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await Promise.race([
      getPool().query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000).unref()),
    ]);
    res.json({ status: 'ok', db: 'up', uptime: Math.round(process.uptime()) });
  } catch {
    res.status(503).json({ status: 'error', db: 'down' });
  }
});

// CORS for allowlisted origins only, without credentials: those callers send a bearer
// token, and the session cookie is ignored for them (see auth.loadSession).
app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  if (!origin || !config.allowedOrigins.includes(origin)) return next();
  req.crossOrigin = true;
  res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
  if (req.method !== 'OPTIONS') return next();
  res.set({
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '600',
  });
  res.sendStatus(204);
});

// CSRF defence: state-changing API calls must be JSON from our own origin (or an
// allowlisted one using a bearer token). Browsers can't send cross-site JSON without a
// CORS preflight, which only allowlisted origins pass.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // req.is() is null for bodyless requests (e.g. DELETE) and false for a non-JSON body.
  if (req.is('application/json') === false) return res.status(415).json({ error: 'Expected application/json.' });
  const origin = req.get('origin');
  let originHost = null;
  try { originHost = origin && new URL(origin).host; } catch { /* malformed */ }
  if (origin && !req.crossOrigin && originHost !== req.get('host')) return res.status(403).json({ error: 'Cross-origin request blocked.' });
  next();
});
app.use('/api', express.json({ limit: '32kb' }));
app.use('/api', auth.loadSession);
app.use('/api/auth', auth.router);
app.use('/api/auth', oauth.router);
app.use('/api', auth.requireUser, data.router);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

app.get('/', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));
for (const f of STATIC_FILES) app.get('/' + f, (_req, res) => res.sendFile(path.join(ROOT, f)));
// Category icons. Only this folder is exposed, and never as a directory listing.
app.use('/images', express.static(path.join(ROOT, 'images'), { index: false, dotfiles: 'ignore', maxAge: '7d' }));

app.use((err, _req, res, _next) => {
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error('[server]', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

async function start() {
  const pool = getPool();
  const [[row]] = await pool.query('SELECT COUNT(*) AS n FROM schema_migrations').catch(() => [[null]]);
  if (!row) {
    console.error('[server] Database is not migrated. Run: npm run migrate');
    process.exit(1);
  }
  const server = app.listen(config.port, config.host, () => {
    const where = config.host === '0.0.0.0' ? 'localhost' : config.host;
    console.log(`[server] Spend Track running at http://${where}:${config.port} (db ${config.db.host}/${config.db.database}, ${config.production ? 'production' : 'development'})`);
  });
  server.on('error', err => { console.error('[server]', err.message); process.exit(1); });
  // Finish in-flight requests, then close the DB pool. Force-exit if that takes too long.
  const shutdown = signal => {
    console.log(`[server] ${signal} received, shutting down`);
    setTimeout(() => process.exit(1), 10_000).unref();
    server.close(() => pool.end().then(() => process.exit(0)));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Let the process manager (systemd) restart us rather than run in an unknown state.
process.on('unhandledRejection', err => { console.error('[server] unhandled rejection:', err); process.exit(1); });

if (require.main === module) start().catch(err => { console.error('[server] failed to start:', err.message); process.exit(1); });
module.exports = app;
