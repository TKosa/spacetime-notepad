#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"

for name in spacetime frontend; do
  pid_file="$RUNTIME_DIR/$name.pid"
  if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    echo "$name: running (pid $(cat "$pid_file"))"
  else
    echo "$name: stopped"
  fi
done

echo "\nListening ports:"
ss -ltnp | rg ':3100|:4174' || true

echo "\nRecent logs:"
for file in "$RUNTIME_DIR/spacetime.log" "$RUNTIME_DIR/frontend.log"; do
  echo "--- $file ---"
  tail -n 20 "$file" 2>/dev/null || true
done
