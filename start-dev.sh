#!/bin/bash

set -o pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

LOG_DIR="${SPARKY_LOG_DIR:-$ROOT_DIR/logs}"
mkdir -p "$LOG_DIR"
RUN_ID="$(date '+%Y%m%d-%H%M%S')"
LOG_FILE="$LOG_DIR/start-dev-$RUN_ID.log"

# Keep the terminal output and a complete copy for WebView diagnostics.
exec > >(tee -a "$LOG_FILE") 2>&1

export RUST_BACKTRACE="${RUST_BACKTRACE:-1}"
export RUST_LOG="${RUST_LOG:-debug}"
export SPARKY_DEV_LOG_FILE="$LOG_FILE"

printf '[start-dev] root=%s\n' "$ROOT_DIR"
printf '[start-dev] log=%s\n' "$LOG_FILE"
printf '[start-dev] RUST_LOG=%s RUST_BACKTRACE=%s\n' "$RUST_LOG" "$RUST_BACKTRACE"
printf '[start-dev] started_at=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"

# 检查是否安装了 code-server
CODE_SERVER_PATH="$HOME/sparky/code-server/bin/code-server"
if [ ! -x "$CODE_SERVER_PATH" ]; then
    echo "⚠️  code-server not found at $CODE_SERVER_PATH"
    exit 1
fi

# 检查是否安装了依赖
if [ ! -d "ui/node_modules" ]; then
    echo "📦 Installing frontend dependencies..."
    cd ui && npm install && cd ..
fi

# 确保 sidecar binary 存在
echo "🔨 Building Sparky sidecar..."
cargo build --release --bin sparky-server --manifest-path Cargo.toml
cp -f target/release/sparky-server target/release/sparky-server-aarch64-apple-darwin
cp -f target/release/sparky-server target/release/sparky-server-x86_64-apple-darwin

# 启动 Tauri 开发模式
echo "🎯 Starting Tauri app..."
cargo tauri dev --verbose
STATUS=$?
printf '[start-dev] exited_at=%s status=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$STATUS"
exit "$STATUS"
