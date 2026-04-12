#!/bin/bash
set -euo pipefail

ROOT="${MOBILE_DEV_HOST_DATA_ROOT:-/tmp/sparky-mobile-dev}"
CODEX_HOME="${MOBILE_DEV_CODEX_HOME:-$ROOT/codex-config}"

mkdir -p \
  "$ROOT/projects" \
  "$ROOT/go" \
  "$ROOT/go-cache" \
  "$ROOT/python-local" \
  "$ROOT/pip-cache" \
  "$ROOT/uv-cache" \
  "$CODEX_HOME"

if [[ "${MOBILE_DEV_SEED_CODEX_SAMPLE:-1}" == "1" && -d "$PWD/codex-config" ]]; then
  ./scripts/seed-mobile-dev-codex.sh
fi

exec docker compose -f docker-compose.mobile-dev.yml up -d --build "$@"
