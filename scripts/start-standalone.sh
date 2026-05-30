#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
SPACETIME_DATA_DIR="$RUNTIME_DIR/spacetime-data"
SPACETIME_JWT_DIR="$RUNTIME_DIR/spacetime-jwt"
SPACETIME_LOG="$RUNTIME_DIR/spacetime.log"
FRONTEND_LOG="$RUNTIME_DIR/frontend.log"
SPACETIME_PID_FILE="$RUNTIME_DIR/spacetime.pid"
FRONTEND_PID_FILE="$RUNTIME_DIR/frontend.pid"
CLI_CONFIG_PATH="$RUNTIME_DIR/cli.notepad-standalone.toml"

SPACETIME_ADDR="127.0.0.1:3100"
SPACETIME_ENDPOINT="http://$SPACETIME_ADDR"
FRONTEND_PORT="4174"
ENV_LOCAL_PATH="$ROOT_DIR/.env.local"

mkdir -p "$RUNTIME_DIR" "$SPACETIME_DATA_DIR" "$SPACETIME_JWT_DIR"

if [ -f "$SPACETIME_PID_FILE" ] && kill -0 "$(cat "$SPACETIME_PID_FILE")" 2>/dev/null; then
  echo "SpacetimeDB already running (pid $(cat "$SPACETIME_PID_FILE"))"
else
  nohup "$HOME/.local/share/spacetime/bin/2.2.0/spacetimedb-standalone" \
    start \
    --data-dir "$SPACETIME_DATA_DIR" \
    --jwt-key-dir "$SPACETIME_JWT_DIR" \
    --listen-addr "$SPACETIME_ADDR" \
    --in-memory \
    --non-interactive \
    > "$SPACETIME_LOG" 2>&1 &
  echo $! > "$SPACETIME_PID_FILE"
  sleep 2
fi

NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v24.16.0/bin/node}"
if [ ! -x "$NODE_BIN" ]; then
  echo "Missing Node binary at $NODE_BIN"
  exit 1
fi

# Ensure schema exists on dedicated Notepad Spacetime instance.
# Re-uses MMO spacetime module binary because Notepad reducers/tables still live there.
(
  cd /home/sword/projects/mmo/spacetime
  if ! spacetime --config-path "$CLI_CONFIG_PATH" login show >/dev/null 2>&1; then
    spacetime --config-path "$CLI_CONFIG_PATH" login --server-issued-login "$SPACETIME_ENDPOINT" --no-browser
  fi

  spacetime --config-path "$CLI_CONFIG_PATH" publish mmonotepad \
    --server "$SPACETIME_ENDPOINT" \
    --bin-path target/wasm32-unknown-unknown/release/mmo_spacetime.wasm \
    --yes --delete-data=on-conflict

  spacetime --config-path "$CLI_CONFIG_PATH" describe --json --server "$SPACETIME_ENDPOINT" mmonotepad >/dev/null
)

if [ -f "$FRONTEND_PID_FILE" ] && kill -0 "$(cat "$FRONTEND_PID_FILE")" 2>/dev/null; then
  echo "Frontend already running (pid $(cat "$FRONTEND_PID_FILE"))"
else
  cat > "$ENV_LOCAL_PATH" <<EOF
VITE_SPACE_TIME_ENDPOINT=$SPACETIME_ENDPOINT
VITE_SPACE_TIME_SCHEMA=mmo
VITE_NOTEPAD_SPACE_TIME_ENDPOINT=$SPACETIME_ENDPOINT
VITE_NOTEPAD_SPACE_TIME_SCHEMA=mmonotepad
EOF

  export VITE_SPACE_TIME_ENDPOINT="$SPACETIME_ENDPOINT"
  export VITE_SPACE_TIME_SCHEMA="mmo"
  export VITE_NOTEPAD_SPACE_TIME_ENDPOINT="$SPACETIME_ENDPOINT"
  export VITE_NOTEPAD_SPACE_TIME_SCHEMA="mmonotepad"

  nohup "$NODE_BIN" "$ROOT_DIR/node_modules/vite/bin/vite.js" \
    --host 0.0.0.0 \
    --port "$FRONTEND_PORT" \
    --strictPort \
    > "$FRONTEND_LOG" 2>&1 &
  echo $! > "$FRONTEND_PID_FILE"
  sleep 2
fi

echo "Notepad frontend: http://localhost:$FRONTEND_PORT"
echo "Notepad Spacetime: $SPACETIME_ENDPOINT"
