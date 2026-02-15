#!/bin/bash

echo "🚀 Starting Claude Monitor Development..."

# 检查是否安装了依赖
if [ ! -d "ui/node_modules" ]; then
    echo "📦 Installing frontend dependencies..."
    cd ui && npm install && cd ..
fi

# 启动 Tauri 开发模式
echo "🎯 Starting Tauri app..."
cargo tauri dev
