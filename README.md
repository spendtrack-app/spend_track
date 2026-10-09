# Spend Track

A high-fidelity spending tracker with real accounts. The Node/Express API stores users, sessions, transactions, and budgets in MySQL.

- **Live site:** https://spendtrack-app.github.io/spend_track/. Accounts work while the team server is running (see [The live server](#the-live-server-mac--tailscale-funnel)). When it's offline, the site says so and runs in browser-only mode, with data kept in the browser.
- **Run it yourself:** set up a server locally (see [Setup](#setup)) and open http://localhost:3000.

## Features

- **Accounts**: sign up, sign in, and sign out. Passwords are hashed with bcrypt (cost 12). Sessions use an opaque token in an `HttpOnly`, `SameSite=Lax` cookie, and only its SHA-256 is stored in MySQL.
- **Front page**: welcome screen with a Get started button that leads to log in, or straight into the demo
- **Log in / create account**: separate screens, with a repeat-password check on sign-up
- **Overview**: switch between day, week, month, and year. Shows the period total, the change from the previous period, a category pie chart, and a ranking of categories or merchants
- **History**: every entry in the selected period, with search, filters, add/edit/delete with undo, and CSV export
- **Repeating entries**: log rent or a subscription once and choose how often it repeats and how many times. Future-dated entries show as upcoming and count only once their date arrives
- **Budgets**: per-category monthly limits with status and how much you are over; click a card to change its limit (or use the pencil for defaults and removal), and every change asks for confirmation first
- **Safe updates**:
  - Every change is saved to MySQL before the UI updates.
  - Edits use optimistic concurrency (`version` column). If two tabs or devices edit the same transaction, the second save gets `409` and shows the latest copy instead of silently overwriting.
  - Every query is scoped to the signed-in user.
- Three themes to pick from (Honey, Pastel, Twilight), with green for money in and red for money out in each; responsive layout, and the `n` keyboard shortcut for a new entry

## Setup

Requires Node 21+ (`.nvmrc` pins 22) and a MySQL server: CI tests against MySQL 8.4, and the live server runs Homebrew MySQL 26.7. It can be local or hosted (for example AWS RDS).

```sh
git clone https://github.com/spendtrack-app/spend_track.git && cd spend_track
npm run setup     # prompts for DB host and admin login, then does everything below
npm start         # http://localhost:3000
npm run doctor    # verify the install at any time
```

`scripts/setup.sh`:
1. Writes credentials to `~/.config/spend_track/.env` with mode `600`. This is **outside the repo**, and the script refuses to write inside the project.
2. Downloads the AWS RDS CA bundle so the database connection uses verified TLS. It skips this step when `DB_SSL=off`.
3. Runs `npm ci` and the migrations.
4. Creates two least-privilege MySQL users and switches the config to them, so the admin password isn't stored on disk:
   - `spend_track_app` can only `SELECT/INSERT/UPDATE/DELETE` on `spend_track.*`. The server runs as this user.
   - `spend_track_migrator` has full rights on `spend_track.*` only. `npm run migrate` runs as this user.
   Both require TLS unless `DB_SSL=off`.
5. Optionally creates an account, with or without sample data.
6. Runs `npm run doctor`.

### Non-interactive setup (CI, scripts, a second machine)

`--yes`, or any environment with `CI` set, takes every answer from environment variables:

```sh
DB_HOST=… DB_USER=admin DB_PASSWORD=… [DB_NAME=spend_track DB_SSL=required PORT=3000] \
  [ST_EMAIL=you@example.com ST_PASSWORD=…] npm run setup -- --yes
```

For a local MySQL instead of RDS, use `DB_HOST=127.0.0.1 DB_USER=root DB_SSL=off`. To host several copies on one server, use different `DB_NAME` values plus `ST_APP_USER` / `ST_MIGRATE_USER`. Re-running setup is safe: it keeps an existing config and skips work that's already done.

`.github/workflows/ci.yml` runs exactly this on every push, on a clean runner with an empty MySQL 8.4. It then runs the integration tests, the smoke test, and the browser e2e tests. That's the check that the setup reproduces from scratch.

Use `SPEND_TRACK_ENV_FILE=/path/to/.env` to keep the config elsewhere. Real environment variables override the file. See `.env.example` for the keys.

### Secrets policy

- No credentials live in this repository. `.gitignore` blocks `.env*` and `*.pem`, and CI runs [gitleaks](https://github.com/gitleaks/gitleaks) on every push.
- `create-user.js` reads the password from environment variables, so it never lands in shell history or process arguments.
- The app never runs as the RDS master user. Keep the master password in a password manager or the macOS Keychain, not in the `.env` file.
- To rotate the app and migrator passwords: `DB_ADMIN_USER=admin DB_ADMIN_PASSWORD=… node scripts/create-db-users.js`. To keep the password out of shell history, read it from the Keychain: `DB_ADMIN_PASSWORD="$(security find-generic-password -s 'Spend Track RDS master (…)' -w)"`.
- If the master credential is ever committed or shared, rotate it in AWS (RDS → Modify → master password), then rotate the app users as above.
- `npm run setup` briefly writes the admin password into `.env` until the restricted users exist. To keep it off disk entirely, follow the steps in [The live server](#the-live-server-mac--tailscale-funnel) instead.

## The live server (Mac + Tailscale Funnel)

The live site's API currently runs on a team member's Mac, at no cost:

| Part | What | Where |
| --- | --- | --- |
| Website | GitHub Pages, published from `main` | https://spendtrack-app.github.io/spend_track/ |
| API | `server/index.js`, started by launchd | `127.0.0.1:3000` on the Mac |
| Database | Homebrew MySQL, listening on `127.0.0.1` only | `spend_track` on the Mac |
| Public address | [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) (free, permanent HTTPS) | https://kuro.tail5c9ccb.ts.net |
| Backups | Daily `mysqldump` at 03:00, keeps 7 | `~/Library/Application Support/SpendTrack/backups/` |

**Limitation:** accounts work only while the Mac is awake. Keep it plugged in with "Prevent automatic sleeping" on. The server, Funnel, and backups all come back on their own after a restart.

### Setting it up on a Mac

Needs Homebrew MySQL (`brew install mysql && brew services start mysql`), the [Tailscale app](https://tailscale.com/download/mac) logged in, and Node 22+.

**1. Save the MySQL root password in the Keychain.** It's used only in memory, never written to a file.

```sh
security add-generic-password -a root -s 'Spend Track MySQL root' -w
```

**2. Write a config with no secrets in it:**

```sh
mkdir -p ~/.config/spend_track && chmod 700 ~/.config/spend_track
( umask 077; cat > ~/.config/spend_track/.env <<'EOF'
DB_HOST='127.0.0.1'
DB_PORT='3306'
DB_NAME='spend_track'
DB_SSL='off'
PORT='3000'
HOST='127.0.0.1'
ALLOWED_ORIGINS='https://spendtrack-app.github.io'
EOF
)
```

- `HOST=127.0.0.1` keeps the server off the local network. Funnel connects through `127.0.0.1`.
- `ALLOWED_ORIGINS` is the site allowed to call the API. `https://spendtrack-app.github.io` is also the default, but setting it explicitly documents it.

**3. Create the database and the restricted users**, with the root password in memory only:

```sh
ROOTPW="$(security find-generic-password -s 'Spend Track MySQL root' -w)"
DB_USER=root DB_PASSWORD="$ROOTPW" node scripts/migrate.js          # creates the database and tables
DB_USER=root DB_PASSWORD="$ROOTPW" node scripts/create-db-users.js  # adds spend_track_app / spend_track_migrator to .env
unset ROOTPW
npm run doctor
```

**4. Start the server at login and restart it on crash.** Create `~/Library/LaunchAgents/app.spendtrack.server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>app.spendtrack.server</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/node</string><string>/path/to/spend_track/server/index.js</string></array>
  <key>WorkingDirectory</key><string>/path/to/spend_track</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/Users/you/Library/Logs/spend-track/server.log</string>
  <key>StandardErrorPath</key><string>/Users/you/Library/Logs/spend-track/server.log</string>
</dict>
</plist>
```

```sh
mkdir -p ~/Library/Logs/spend-track
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.spendtrack.server.plist
curl -s http://127.0.0.1:3000/api/health      # {"status":"ok","db":"up",...}
```

**5. Publish it with Funnel** and point the Pages site at it. This is a one-time step, because the address never changes:

```sh
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
$TS funnel --bg 3000        # the first time, it prints a link to enable Funnel for your tailnet
$TS funnel status           # shows https://<machine>.<tailnet>.ts.net
npm run pages:api -- https://<machine>.<tailnet>.ts.net --publish
```

**6. Daily backups.** Save this as `~/Library/Application Support/SpendTrack/backup.sh` (`chmod 700`). It uses the migrator login from `.env`, never root:

```sh
#!/bin/bash
set -euo pipefail
ENV_FILE="$HOME/.config/spend_track/.env"
OUT="$HOME/Library/Application Support/SpendTrack/backups"
get() { sed -n "s/^$1='\(.*\)'\$/\1/p" "$ENV_FILE"; }
umask 077; mkdir -p "$OUT"
export MYSQL_PWD="$(get DB_MIGRATE_PASSWORD)"
FILE="$OUT/spend_track-$(date +%Y-%m-%d).sql.gz"
/usr/local/bin/mysqldump --single-transaction --set-gtid-purged=OFF --no-tablespaces --routines --triggers \
  --skip-masking-policies -h 127.0.0.1 -u "$(get DB_MIGRATE_USER)" "$(get DB_NAME)" | gzip > "$FILE.tmp"
mv "$FILE.tmp" "$FILE"
ls -1t "$OUT"/spend_track-*.sql.gz | tail -n +8 | while read -r old; do rm -f "$old"; done
```

Then add a launchd job `app.spendtrack.backup` with `StartCalendarInterval` set to 03:00. If the Mac is asleep at 03:00, launchd runs it on wake. To restore a backup:

```sh
gunzip -c ~/Library/Application\ Support/SpendTrack/backups/spend_track-YYYY-MM-DD.sql.gz \
  | MYSQL_PWD="$(security find-generic-password -s 'Spend Track MySQL root' -w)" mysql -u root -h 127.0.0.1 spend_track
```

### Day-to-day

| Task | Command |
| --- | --- |
| Is it up? | `npm run doctor`, or `curl https://<machine>.<tailnet>.ts.net/api/health` |
| Logs | `tail -f ~/Library/Logs/spend-track/server.log` (backups: `backup.log`) |
| Deploy new code | `git pull && npm run migrate && launchctl kickstart -k gui/$(id -u)/app.spendtrack.server` (the service runs from this working copy) |
| Take it offline | `$TS funnel --https=443 off`. Run `$TS funnel --bg 3000` to bring it back. |
| Stop the server | `launchctl bootout gui/$(id -u)/app.spendtrack.server` |
| Run a backup now | `launchctl kickstart gui/$(id -u)/app.spendtrack.backup` |

### Security notes

- Only Funnel is reachable from outside. The API listens on `127.0.0.1:3000`, and MySQL's `bind_address` and `mysqlx_bind_address` are `127.0.0.1`.
- The server runs as `spend_track_app` (`SELECT/INSERT/UPDATE/DELETE` on `spend_track.*`). Backups and migrations use `spend_track_migrator`. The root password stays in the Keychain.
- Funnel sets `X-Forwarded-For` to the visitor's real IP and replaces any value the client sent. Its proxy connects from `127.0.0.1`, and the default `TRUST_PROXY=loopback` trusts only that, so the sign-in rate limit applies per visitor and can't be dodged with a fake header.
- Only `ALLOWED_ORIGINS` (the Pages site) gets CORS access. Other sites are refused.

**Known quirk:** on a device logged into the same tailnet, the `.ts.net` name resolves to the private Tailscale IP. Chrome then blocks the Pages site from calling it ("local network access"), and the site falls back to browser-only mode. Visitors outside the tailnet aren't affected. On the server's own Mac, use http://localhost:3000, allow Chrome's local-network prompt, or turn off "Use Tailscale DNS".

To move off the Mac later, run the same app on a cloud server with [the Ubuntu installer](#deploying-to-an-ubuntu-server). Then point the Pages site at the new address with `npm run pages:api`.

## Deploying to an Ubuntu server

One command sets up Ubuntu 22.04+ or Debian 12+. It installs Node 22, a hardened systemd service, least-privilege DB users, and (with `DOMAIN`) Caddy with automatic HTTPS:

```sh
git clone https://github.com/spendtrack-app/spend_track.git && cd spend_track
sudo DB_HOST=your-db.rds.amazonaws.com DB_USER=admin DB_PASSWORD=… \
     DOMAIN=api.example.com bash scripts/install-ubuntu.sh
```

Before running it:
- Point the domain's DNS at the server.
- Open ports 80 and 443.
- Allow the server's IP in the RDS security group.

For a MySQL on the same machine or a private network, use `DB_HOST=127.0.0.1 DB_SSL=off`. Without `DOMAIN` the app serves plain HTTP on `PORT`, which is for testing only.

| What | Where |
| --- | --- |
| Code | `/opt/spend_track`, owned by root and read-only to the app |
| Config | `/etc/spend_track/.env`, mode 600, owned by the `spendtrack` user. It holds the restricted DB logins, never the admin password. |
| Service | `systemctl status spend-track`, logs with `journalctl -u spend-track -f`. Runs migrations before each start, restarts on crash, shuts down gracefully, and is sandboxed (`ProtectSystem=strict`, no capabilities, and more). |
| Health | `GET /api/health` returns `{"status":"ok","db":"up"}`, or 503 when the DB is unreachable. Use it for uptime monitoring. |
| HTTPS | Caddy (`/etc/caddy/Caddyfile`) proxies to the app on `127.0.0.1`. The app trusts `X-Forwarded-For` only from loopback. |

**Update:** `git pull && sudo bash scripts/install-ubuntu.sh`. It keeps the config and HTTPS, redeploys the code, migrates, and restarts.

**Point the Pages site at the server:** run `npm run pages:api -- https://api.example.com --publish` on your dev machine. That replaces the tunnel.

CI runs this installer on a clean Ubuntu 24.04 machine with real systemd on every push. It checks the plain-HTTP install, the file permissions and sandboxing, a smoke test, restart after a crash, and an in-place update to HTTPS behind Caddy.

## Connecting GitHub Pages

GitHub Pages only hosts static files, so `api-config.js` tells the Pages site where the API is. The live site uses the permanent Funnel address from [The live server](#the-live-server-mac--tailscale-funnel), set once with `npm run pages:api -- <url> --publish`.

For a quick temporary test without Tailscale, use a [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) instead:

```sh
npm start                        # terminal 1
npm run tunnel -- --publish      # terminal 2: writes the URL to api-config.js, commits and pushes it
```

- The quick-tunnel URL changes on every run, so re-run with `--publish` after each restart. Pages picks up the change within a few minutes.
- While the tunnel or server is down, the Pages site says so and falls back to browser-only mode.
- Only origins in `ALLOWED_ORIGINS` get CORS access. The default is `https://spendtrack-app.github.io`, the live Pages site. Those requests authenticate with a bearer token kept in `localStorage`, and the session cookie is ignored for them. Same-origin use (`http://localhost:3000`) keeps the HttpOnly cookie.

## Database changes

Migrations live in `migrations/NNN_name.sql` and are tracked in a `schema_migrations` table with checksums.

```sh
npm run migrate   # applies any new migrations; safe to re-run
```

To change the schema, **add a new numbered file**. Don't edit an applied migration; the runner refuses if a checksum changes.

## Testing

Three layers, each with one job:

| Layer | Command | What it proves | Speed |
| --- | --- | --- | --- |
| **Integration** | `npm test` | Every API rule against a real MySQL: auth and sessions, validation boundaries, optimistic concurrency, per-user isolation, CSRF/CORS/bearer tokens, rate limiting, headers, and which files are served | ~91 tests in ~10 s |
| **E2E** | `npm run e2e` | Real user journeys in Chromium (desktop and mobile), with each result checked against what MySQL stored: sign-up/in/out, add/edit/delete/undo, conflict handling, failed saves, filters, months, CSV export, KPIs, budgets, reset, theme, offline fallback | ~24 tests in ~15 s |
| **Smoke** | `npm run smoke` | A deployment is alive and its critical path works. Non-destructive, stops at the first failure, reports timings | ~3 s |

Against the live GitHub Pages site: `npm run smoke:pages` checks the whole chain (Pages → `api-config.js` → tunnel → API → MySQL), and `npm run e2e:pages` runs the browser suite there.

How the tests stay fast and reliable:
- **Test-data factory** (`test/support/factory.js`, shared by integration and e2e). It creates users, sessions and transactions directly in MySQL, so each test sets up exactly the state it needs in milliseconds, and only the auth tests go through sign-up. Everything it creates is deleted afterwards; test accounts use `*@example.test`.
- **Parallel by default.** Every test has its own account and its own client IP (`X-Forwarded-For`, trusted only from loopback), so tests and the per-IP sign-in rate limit never interfere.
- **No sleeps.** E2E waits on web-first assertions and on `<html data-state="ready">`, which the app sets when boot finishes. Timing-sensitive tests use Playwright's fake clock (`test.use({ fakeClock: true })`).
- **Checked against the database.** E2E tests confirm what MySQL stored, not just what the screen shows.

Smoke options: `npm run smoke -- <url>` for any server. Set `SMOKE_EMAIL`/`SMOKE_PASSWORD` to use a fixed account (no DB access needed); otherwise a throwaway account is created and removed. First-time e2e needs a browser: `npx playwright install chromium`. All three need the DB config from `npm run setup`.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run setup [-- --yes]` | First-time setup (credentials, TLS CA, install, migrate, least-privilege users, optional account, health check) |
| `npm run doctor` | Health check: config permissions, TLS, DB logins and privileges, migrations, server, and tunnel |
| `npm start` | Start the server on `PORT` (default 3000) |
| `npm run dev` | Start with auto-reload |
| `npm run tunnel [-- --publish]` | Expose the local API to the Pages site via a Cloudflare quick tunnel |
| `npm run pages:api -- <https-url> [--publish]` | Point the Pages site at an API (checks `/api/health` first) |
| `sudo bash scripts/install-ubuntu.sh` | Install or update on an Ubuntu/Debian server (see above) |
| `npm run migrate` | Apply pending migrations (as `DB_MIGRATE_USER` when set) |
| `DB_ADMIN_USER=… DB_ADMIN_PASSWORD=… node scripts/create-db-users.js` | Create or rotate the least-privilege DB users and update the config file |
| `ST_EMAIL=… ST_PASSWORD=… node scripts/create-user.js` | Create an account or reset its password |

## Layout

```
index.html, styles.css, app.js   Front end (works standalone on GitHub Pages in browser-only mode)
api-config.js                    API URL for the Pages copy (written by pages-api.sh or tunnel.sh)
seed.js                          Categories + sample data, shared by browser and server
images/                          Category icons (<category>.png), tinted with each category's color
server/                          Express app: config, db pool, auth, data API
migrations/                      Versioned SQL schema
scripts/                         setup.sh, install-ubuntu.sh, doctor.js, migrate.js, create-user.js, create-db-users.js,
                                 tunnel.sh, pages-api.sh, smoke.js
deploy/                          systemd unit and Caddyfile template used by install-ubuntu.sh
test/                            API integration tests (node:test)
e2e/                             Playwright browser tests
```
