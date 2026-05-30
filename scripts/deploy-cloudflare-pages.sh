#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL_ENV="$ROOT_DIR/.env.local"

if [ -f "$LOCAL_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$LOCAL_ENV"
  set +a
fi

: "${CLOUDFLARE_ACCOUNT_ID:?Missing CLOUDFLARE_ACCOUNT_ID}"
: "${CLOUDFLARE_API_TOKEN:?Missing CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_PAGES_PROJECT_NAME_NOTEPAD:?Missing CLOUDFLARE_PAGES_PROJECT_NAME_NOTEPAD}"

cd "$ROOT_DIR"
npm run build

npx wrangler pages deploy dist --project-name="$CLOUDFLARE_PAGES_PROJECT_NAME_NOTEPAD"
