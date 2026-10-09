#!/usr/bin/env bash
# Points the GitHub Pages front end at an API, by writing api-config.js.
#
#   npm run pages:api -- https://api.example.com             # write api-config.js
#   npm run pages:api -- https://api.example.com --publish   # ...then commit + push it
#   npm run pages:api -- ""                                  # back to browser-only mode
#
# The API must allow the Pages origin (ALLOWED_ORIGINS, default https://spendtrack-app.github.io).
set -euo pipefail
cd "$(dirname "$0")/.."

URL="${1-}"; URL="${URL%/}"
PUBLISH=n; [[ "${2:-}" == "--publish" ]] && PUBLISH=y
if [[ -n "$URL" ]]; then
  [[ "$URL" =~ ^https:// ]] || { echo "The Pages site is HTTPS, so the API must be https:// too (got '$URL')." >&2; exit 1; }
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$URL/api/health" || true)"
  [[ "$status" == 200 ]] || { echo "$URL/api/health returned '$status'; is the server up?" >&2; exit 1; }
  echo "API healthy: $URL"
fi

cat > api-config.js <<JS
// Where the GitHub Pages copy of the site finds the API. Written by scripts/pages-api.sh.
// Empty = browser-only mode. Ignored when the page is served by the Node server itself.
window.SPEND_TRACK_API = '$URL';
JS
echo "api-config.js -> ${URL:-(browser-only mode)}"

if [[ $PUBLISH == y ]]; then
  if git diff --quiet -- api-config.js; then echo "api-config.js unchanged"
  else
    git commit -q -m "Point GitHub Pages at ${URL:-browser-only mode}" -- api-config.js
    git push -q && echo "Pushed. GitHub Pages picks it up within a few minutes."
  fi
fi
