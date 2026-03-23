#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEB_DIR="$ROOT_DIR/web"
SERVER_DIR="$ROOT_DIR/server-go"
SERVER_PORT="${SERVER_PORT:-3010}"
WEB_PORT="${WEB_PORT:-5174}"
SERVER_URL="http://localhost:$SERVER_PORT"
WEB_URL="http://localhost:$WEB_PORT"

kill_port_processes() {
  local port="$1"
  local pids

  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    return
  fi

  echo "Killing existing process on port $port: $pids"
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    kill "$pid" 2>/dev/null || true
  done <<< "$pids"
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM

  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi

  if [[ -n "${WEB_PID:-}" ]] && kill -0 "$WEB_PID" 2>/dev/null; then
    kill "$WEB_PID" 2>/dev/null || true
  fi

  wait 2>/dev/null || true
  exit "$exit_code"
}

trap cleanup EXIT INT TERM

kill_port_processes "$SERVER_PORT"
kill_port_processes "$WEB_PORT"

echo "Backend: $SERVER_URL"
echo "Frontend: $WEB_URL"
echo "Starting Go backend..."
(
  cd "$SERVER_DIR"
  go run ./cmd/server
) &
SERVER_PID=$!

echo "Starting web frontend..."
(
  cd "$WEB_DIR"
  npm run dev
) &
WEB_PID=$!

wait -n "$SERVER_PID" "$WEB_PID"
