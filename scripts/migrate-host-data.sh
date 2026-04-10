#!/usr/bin/env bash
set -euo pipefail

OLD_ROOT="${1:-/home/cc-dev/data}"
NEW_ROOT="${2:-/home/sp-dev/data}"

DIRS=(
  projects
  go
  go-cache
  python-local
  pip-cache
  uv-cache
)

mkdir -p "$OLD_ROOT" "$NEW_ROOT"

for name in "${DIRS[@]}"; do
  old_path="$OLD_ROOT/$name"
  new_path="$NEW_ROOT/$name"

  if [ -L "$old_path" ]; then
    continue
  fi

  if [ -d "$old_path" ] && [ ! -e "$new_path" ]; then
    mv "$old_path" "$new_path"
  elif [ -d "$old_path" ] && [ -d "$new_path" ]; then
    rsync -a "$old_path"/ "$new_path"/
    rm -rf "$old_path"
  elif [ ! -e "$old_path" ] && [ ! -e "$new_path" ]; then
    mkdir -p "$new_path"
  fi

  ln -sfn "$new_path" "$old_path"
done

if [ -d "$NEW_ROOT" ]; then
  chown -R sisu:sisu "$NEW_ROOT" || true
fi

echo "Migrated host data from $OLD_ROOT to $NEW_ROOT"
