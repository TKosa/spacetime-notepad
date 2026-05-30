#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
SPACETIME_DATA_DIR="$RUNTIME_DIR/spacetime-data"
SPACETIME_JWT_DIR="$RUNTIME_DIR/spacetime-jwt"
SPACETIME_LOG="$RUNTIME_DIR/spacetime.log"
SPACETIME_PID_FILE="$RUNTIME_DIR/spacetime.pid"
CLI_CONFIG_PATH="$RUNTIME_DIR/cli.notepad.toml"

SPACETIME_ADDR="${NOTEPAD_SPACETIME_ADDR:-127.0.0.1:3210}"
SPACETIME_ENDPOINT="http://$SPACETIME_ADDR"
SCHEMA_NAME="${NOTEPAD_SCHEMA:-mmonotepad}"
WASM_PATH="${NOTEPAD_WASM_PATH:-$ROOT_DIR/backend/mmo_spacetime.wasm}"
SPACETIME_BIN="${SPACETIME_BIN:-$HOME/.local/share/spacetime/bin/2.2.0/spacetimedb-standalone}"

mkdir -p "$RUNTIME_DIR" "$SPACETIME_DATA_DIR" "$SPACETIME_JWT_DIR"

if [ ! -x "$SPACETIME_BIN" ]; then
  echo "Missing spacetimedb-standalone at: $SPACETIME_BIN"
  exit 1
fi
if [ ! -f "$WASM_PATH" ]; then
  echo "Missing wasm module at: $WASM_PATH"
  echo "Copy one into backend/mmo_spacetime.wasm or set NOTEPAD_WASM_PATH"
  exit 1
fi

if [ -f "$SPACETIME_PID_FILE" ] && kill -0 "$(cat "$SPACETIME_PID_FILE")" 2>/dev/null; then
  echo "SpacetimeDB already running (pid $(cat "$SPACETIME_PID_FILE"))"
else
  # Fresh local runtime by default so the extracted project does not inherit
  # previous database ownership metadata from copied worktrees.
  if [ "${NOTEPAD_RESET_RUNTIME_ON_START:-1}" = "1" ]; then
    rm -rf "$SPACETIME_DATA_DIR" "$SPACETIME_JWT_DIR" "$CLI_CONFIG_PATH"
    mkdir -p "$SPACETIME_DATA_DIR" "$SPACETIME_JWT_DIR"
  fi

  nohup "$SPACETIME_BIN" start \
    --data-dir "$SPACETIME_DATA_DIR" \
    --jwt-key-dir "$SPACETIME_JWT_DIR" \
    --listen-addr "$SPACETIME_ADDR" \
    --in-memory \
    --non-interactive \
    > "$SPACETIME_LOG" 2>&1 &
  echo $! > "$SPACETIME_PID_FILE"
  sleep 2
fi

if ! spacetime --config-path "$CLI_CONFIG_PATH" login show >/dev/null 2>&1; then
  spacetime --config-path "$CLI_CONFIG_PATH" login --server-issued-login "$SPACETIME_ENDPOINT" --no-browser
fi

spacetime --config-path "$CLI_CONFIG_PATH" publish "$SCHEMA_NAME" \
  --server "$SPACETIME_ENDPOINT" \
  --bin-path "$WASM_PATH" \
  --yes --delete-data=on-conflict

spacetime --config-path "$CLI_CONFIG_PATH" describe --json --server "$SPACETIME_ENDPOINT" "$SCHEMA_NAME" >/dev/null

echo "Spacetime ready: $SPACETIME_ENDPOINT (schema $SCHEMA_NAME)"
