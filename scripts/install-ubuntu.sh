#!/usr/bin/env bash
# Installs or updates Spend Track on an Ubuntu (22.04+) or Debian server.
#
# First install, from a checkout of the repo:
#   sudo DB_HOST=… DB_USER=admin DB_PASSWORD=… DOMAIN=api.example.com bash scripts/install-ubuntu.sh
#
# Update after pulling new code (config, database users and HTTPS are kept):
#   git pull && sudo bash scripts/install-ubuntu.sh
#
# Settings (environment variables):
#   DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME DB_SSL   MySQL admin login, first install only.
#                             DB_SSL=off for a MySQL on this machine or private network.
#   DOMAIN                    Public hostname. Installs Caddy with automatic HTTPS (Let's Encrypt)
#                             and binds the app to 127.0.0.1. Without it the app serves plain
#                             HTTP on PORT, for testing only.
#   PORT                      App port (default 3000).
#   ALLOWED_ORIGINS           Sites allowed to call the API cross-origin
#                             (default https://spendtrack-app.github.io, the GitHub Pages front end).
#   ST_EMAIL ST_PASSWORD      Optionally create an app account.
#
# Layout: code /opt/spend_track (root-owned, read-only to the app), config
# /etc/spend_track/.env (mode 600, owned by the service user), service `spend-track`.
set -euo pipefail

APP_DIR=/opt/spend_track
CONF_DIR=/etc/spend_track
ENV_FILE=$CONF_DIR/.env
APP_USER=spendtrack
SERVICE=spend-track
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_MAJOR="$(tr -dc '0-9' < "$SRC_DIR/.nvmrc" 2>/dev/null || echo 22)"
NODE=/usr/bin/node
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"   # use the system Node, not a user-installed one

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Sets KEY='value' in the config file (replacing an existing line).
upsert_env() {
  local key=$1 value=$2
  if grep -q "^$key=" "$ENV_FILE"; then sed -i "s|^$key=.*|$key='$value'|" "$ENV_FILE"
  else printf "%s='%s'\n" "$key" "$value" >> "$ENV_FILE"; fi
}
# Reads KEY from the config file; empty if the file or key doesn't exist (first install).
env_value() {
  [[ -f $ENV_FILE ]] || return 0
  { grep -E "^$1=" "$ENV_FILE" || true; } | tail -1 | cut -d= -f2- | sed "s/^'//; s/'\$//"
}

[[ $EUID -eq 0 ]] || die "Run as root: sudo bash scripts/install-ubuntu.sh"
command -v apt-get >/dev/null || die "This installer supports Ubuntu/Debian (apt)."
[[ -f "$SRC_DIR/server/index.js" ]] || die "Run from a checkout of the spend_track repository."

FIRST_INSTALL=y; [[ -f $ENV_FILE ]] && FIRST_INSTALL=n
DOMAIN="${DOMAIN-$(env_value SPEND_TRACK_DOMAIN)}"
PORT="${PORT:-$(env_value PORT)}"; PORT="${PORT:-3000}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS-$(env_value ALLOWED_ORIGINS)}"; ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://spendtrack-app.github.io}"
if [[ $FIRST_INSTALL == y ]]; then
  [[ -n "${DB_HOST:-}" && -n "${DB_PASSWORD:-}" ]] || die "First install needs DB_HOST, DB_USER and DB_PASSWORD (MySQL admin login)."
fi

bold "1. System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg rsync >/dev/null
ok "ca-certificates curl gnupg rsync"

bold "2. Node.js $NODE_MAJOR"
if [[ -x $NODE ]] && (( $($NODE -p 'process.versions.node.split(".")[0]') >= NODE_MAJOR )); then
  ok "node $($NODE -v) already installed"
else
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  ok "installed node $($NODE -v)"
fi

bold "3. Service user"
if id "$APP_USER" >/dev/null 2>&1; then ok "$APP_USER exists"
else
  useradd --system --home-dir /var/lib/spend_track --create-home --shell /usr/sbin/nologin "$APP_USER"
  ok "created system user $APP_USER"
fi

bold "4. Application code -> $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude .git --exclude node_modules --exclude test-results --exclude playwright-report \
  --exclude .env --exclude '.env.*' --exclude '*.pem' \
  "$SRC_DIR/" "$APP_DIR/"
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
# Root owns the code; the service can read it but not change it.
chown -R root:"$APP_USER" "$APP_DIR"
chmod -R u=rwX,g=rX,o= "$APP_DIR"
ok "$(cd "$APP_DIR" && git -C "$SRC_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown) deployed, production dependencies installed"

bold "5. Configuration $ENV_FILE"
install -d -m 700 -o "$APP_USER" -g "$APP_USER" "$CONF_DIR"
if [[ $FIRST_INSTALL == y ]]; then
  # setup.sh writes the config, downloads the RDS CA if needed, migrates, creates the
  # least-privilege DB users (dropping the admin password from the file), and checks health.
  sudo -u "$APP_USER" env PATH="$PATH" HOME=/var/lib/spend_track NODE_ENV=production \
    SPEND_TRACK_ENV_FILE="$ENV_FILE" ST_SKIP_INSTALL=1 \
    DB_HOST="$DB_HOST" DB_PORT="${DB_PORT:-3306}" DB_USER="${DB_USER:-admin}" DB_PASSWORD="$DB_PASSWORD" \
    DB_NAME="${DB_NAME:-spend_track}" DB_SSL="${DB_SSL:-required}" PORT="$PORT" \
    ST_EMAIL="${ST_EMAIL:-}" ST_PASSWORD="${ST_PASSWORD:-}" ST_NAME="${ST_NAME:-}" \
    bash "$APP_DIR/scripts/setup.sh" --yes
else
  ok "keeping existing config"
fi
if [[ -n "$DOMAIN" ]]; then
  upsert_env HOST 127.0.0.1; upsert_env TRUST_PROXY loopback; upsert_env COOKIE_SECURE true
else
  upsert_env HOST 0.0.0.0; upsert_env TRUST_PROXY false; upsert_env COOKIE_SECURE false
fi
upsert_env PORT "$PORT"
upsert_env ALLOWED_ORIGINS "$ALLOWED_ORIGINS"
upsert_env SPEND_TRACK_DOMAIN "$DOMAIN"
chown "$APP_USER:$APP_USER" "$ENV_FILE"; chmod 600 "$ENV_FILE"
ok "HOST=$(env_value HOST) PORT=$PORT TRUST_PROXY=$(env_value TRUST_PROXY) COOKIE_SECURE=$(env_value COOKIE_SECURE)"

bold "6. systemd service $SERVICE"
install -m 644 "$APP_DIR/deploy/spend-track.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable --quiet "$SERVICE"
systemctl restart "$SERVICE"
healthy=n
for _ in $(seq 60); do
  if curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/health"; then healthy=y; break; fi
  sleep 0.5
done
if [[ $healthy != y ]]; then
  journalctl -u "$SERVICE" -n 40 --no-pager >&2 || true
  die "Service did not become healthy. Logs above; also: journalctl -u $SERVICE"
fi
ok "running, enabled at boot, healthy ($(curl -fsS "http://127.0.0.1:$PORT/api/health"))"

bold "7. HTTPS"
if [[ -n "$DOMAIN" ]]; then
  if ! command -v caddy >/dev/null; then
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
  sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__PORT__|$PORT|g" "$APP_DIR/deploy/Caddyfile.template" > /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || die "Generated Caddyfile is invalid."
  systemctl enable --quiet caddy
  systemctl restart caddy
  listening=n
  for _ in $(seq 30); do
    if systemctl is-active --quiet caddy && ss -ltn | grep -q ':443 '; then listening=y; break; fi
    sleep 0.5
  done
  if [[ $listening != y ]]; then
    journalctl -u caddy -n 30 --no-pager >&2 || true
    die "Caddy is not running or not listening on 443 (logs above)."
  fi
  ok "Caddy listening on 443 for https://$DOMAIN (certificate is issued on first request; DNS must point here)"
else
  warn "No DOMAIN: serving plain HTTP on port $PORT. Fine for testing; for real use re-run with DOMAIN=your.host"
fi

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  if [[ -n "$DOMAIN" ]]; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ok "ufw: opened 80, 443"
  else ufw allow "$PORT"/tcp >/dev/null; ok "ufw: opened $PORT"; fi
fi

URL=$([[ -n "$DOMAIN" ]] && echo "https://$DOMAIN" || echo "http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT")
echo
bold "Spend Track is running at $URL"
cat <<EOF
  Logs:         journalctl -u $SERVICE -f
  Health:       curl $URL/api/health
  Status:       systemctl status $SERVICE
  Update:       git pull && sudo bash scripts/install-ubuntu.sh
  Pages front:  on your dev machine, npm run pages:api -- $URL --publish
EOF
