#!/bin/bash

echo "🔨 Building Claude Monitor..."

# 构建前端
echo "📦 Building frontend..."
cd ui && npm run build && cd ..

# 构建 Tauri 应用
echo "🦀 Building Tauri app..."
cargo tauri build

echo "✅ Build complete! Check src-tauri/target/release/bundle/"
