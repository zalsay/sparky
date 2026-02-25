#!/bin/bash

echo "🚀 Starting Claude Monitor Development..."

# 检查是否安装了依赖
if [ ! -d "ui/node_modules" ]; then
    echo "📦 Installing frontend dependencies..."
    cd ui && npm install && cd ..
fi

# 确保 sidecar binary 存在
echo "🔨 Building Sparky sidecar..."
cargo build --release --bin sparky --manifest-path Cargo.toml
cp -f target/release/sparky target/release/sparky-aarch64-apple-darwin
cp -f target/release/sparky target/release/sparky-x86_64-apple-darwin

# 启动 Tauri 开发模式
echo "🎯 Starting Tauri app..."
cargo tauri dev
