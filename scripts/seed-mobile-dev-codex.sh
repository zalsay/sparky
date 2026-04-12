#!/bin/bash
set -euo pipefail

WORKDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${MOBILE_DEV_HOST_DATA_ROOT:-/tmp/sparky-mobile-dev}"
CODEX_HOME="${MOBILE_DEV_CODEX_HOME:-$ROOT/codex-config}"
SOURCE_CODEX_HOME="${MOBILE_DEV_SAMPLE_CODEX_SOURCE:-$WORKDIR/codex-config}"
PROJECT_PATH="${MOBILE_DEV_SAMPLE_PROJECT_PATH:-/projects/codex-mobile-dev}"

if [[ ! -d "$SOURCE_CODEX_HOME" ]]; then
  echo "sample codex-config not found: $SOURCE_CODEX_HOME" >&2
  exit 1
fi

mkdir -p "$CODEX_HOME"
rsync -a --delete "$SOURCE_CODEX_HOME/" "$CODEX_HOME/"

python3 - "$CODEX_HOME" "$PROJECT_PATH" <<'PY'
import json
import pathlib
import sys

codex_home = pathlib.Path(sys.argv[1])
project_path = sys.argv[2]

for rollout_path in codex_home.glob("sessions/*/*/*/rollout-*.jsonl"):
    changed = False
    output = []
    with rollout_path.open("r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.rstrip("\n")
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                output.append(raw_line)
                continue

            if record.get("type") == "session_meta":
                payload = record.get("payload")
                if isinstance(payload, dict) and payload.get("cwd") != project_path:
                    payload["cwd"] = project_path
                    changed = True

            output.append(json.dumps(record, ensure_ascii=False) + "\n")

    if changed:
        with rollout_path.open("w", encoding="utf-8") as handle:
            handle.writelines(output)
PY

echo "seeded mobile-dev codex sample into $CODEX_HOME"
