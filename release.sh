#!/bin/bash
set -euo pipefail

# 版本号/Tag 优先级：
# 1) 命令行第一个参数
# 2) 环境变量 TAG
# 3) Cargo.toml 中的 version（前面加 v）

# 项目根目录
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELEASE_DIR="$PROJECT_DIR/release"

# 解析版本/Tag
INPUT_TAG="${1:-}"  # 可选：第一个参数
if [ -n "$INPUT_TAG" ]; then
  TAG="$INPUT_TAG"
elif [ -n "${TAG:-}" ]; then
  # 已在环境变量中设置 TAG
  TAG="$TAG"
else
  # 从 Cargo.toml 读取版本并生成 tag
  CARGO_VERSION=$(grep '^version' "$PROJECT_DIR/Cargo.toml" | head -n 1 | cut -d '"' -f 2)
  if [ -z "$CARGO_VERSION" ]; then
    echo "❌ 无法从 Cargo.toml 读取版本号"
    exit 1
  fi
  TAG="v$CARGO_VERSION"
fi

TITLE="$TAG"
NOTES="Sparky release $TAG"

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
