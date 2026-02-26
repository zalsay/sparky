#!/bin/bash
set -euo pipefail

# 可改为你的版本号
TAG="1.1.0"
TITLE="1.1.0"
NOTES="Sparky release 1.1.0"

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELEASE_DIR="$PROJECT_DIR/release"

cd "$PROJECT_DIR"

# 基本检查
command -v gh >/dev/null 2>&1 || { echo "❌ 未安装 gh"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "❌ 未登录 gh，请先执行: gh auth login"; exit 1; }

[ -d "$RELEASE_DIR" ] || { echo "❌ 未找到 release 目录"; exit 1; }

# 打 tag 并推送
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "ℹ️ tag 已存在: $TAG"
else
  git tag "$TAG"
  git push origin "$TAG"
fi

# 创建 Release 并上传产物
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "ℹ️ release 已存在: $TAG"
else
  gh release create "$TAG" "$RELEASE_DIR"/* --title "$TITLE" --notes "$NOTES"
fi

echo "✅ Release 处理完成：$TAG"
