#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
FRONTEND_LOG="$RUNTIME_DIR/frontend-web.log"
FRONTEND_PID_FILE="$RUNTIME_DIR/frontend-web.pid"

SPACETIME_ADDR="${NOTEPAD_SPACETIME_ADDR:-127.0.0.1:3210}"
SPACETIME_ENDPOINT="http://$SPACETIME_ADDR"
SCHEMA_NAME="${NOTEPAD_SCHEMA:-mmonotepad}"
FRONTEND_PORT="${NOTEPAD_WEB_PORT:-4375}"
NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v24.16.0/bin/node}"

mkdir -p "$RUNTIME_DIR"

if [ ! -x "$NODE_BIN" ]; then
  echo "Missing Node binary at: $NODE_BIN"
  exit 1
fi

if [ -f "$FRONTEND_PID_FILE" ] && kill -0 "$(cat "$FRONTEND_PID_FILE")" 2>/dev/null; then
  echo "Frontend web server already running (pid $(cat "$FRONTEND_PID_FILE"))"
  exit 0
fi

cat > "$ROOT_DIR/.env.local" <<EOV
VITE_SPACE_TIME_ENDPOINT=$SPACETIME_ENDPOINT
VITE_SPACE_TIME_SCHEMA=mmo
VITE_NOTEPAD_SPACE_TIME_ENDPOINT=$SPACETIME_ENDPOINT
VITE_NOTEPAD_SPACE_TIME_SCHEMA=$SCHEMA_NAME
EOV

"$NODE_BIN" "$ROOT_DIR/node_modules/vite/bin/vite.js" build >/dev/null
nohup "$NODE_BIN" "$ROOT_DIR/node_modules/vite/bin/vite.js" preview \
  --host 0.0.0.0 \
  --port "$FRONTEND_PORT" \
  --strictPort \
  > "$FRONTEND_LOG" 2>&1 &

echo $! > "$FRONTEND_PID_FILE"
sleep 1

echo "Notepad web server: http://127.0.0.1:$FRONTEND_PORT"
