#!/bin/bash

# Exit on error
set -e

echo "🔨 Building Sparky..."

# Build frontend
echo "📦 Building frontend..."
cd ui && npm install && npm run build && cd ..

# Function to build for a specific target
build_target() {
    local target=$1
    local bundle_format=$2
    echo "🦀 Building for target: $target..."
    
    # Ensure target is installed
    rustup target add $target
    
    # Run tauri build
    if [ "$bundle_format" != "" ]; then
        cargo tauri build --target $target --bundles $bundle_format
    else
        cargo tauri build --target $target
    fi
}

# Native build based on OS
OS="$(uname)"
case "$OS" in
    Darwin*)
        echo "🍎 Detected macOS. Building for x64 and ARM..."
        build_target "x86_64-apple-darwin" "dmg"
        build_target "aarch64-apple-darwin" "dmg"
        ;;
    Linux*)
        echo "🐧 Detected Linux. Building for x64 deb/rpm..."
        build_target "x86_64-unknown-linux-gnu" "deb"
        ;;
    CYGWIN*|MINGW32*|MSYS*|MINGW*)
        echo "🪟 Detected Windows. Building for x64 exe..."
        build_target "x86_64-pc-windows-msvc" "nsis"
        ;;
    *)
        echo "❓ Unknown OS: $OS. Running default build..."
        cargo tauri build
        ;;
esac

echo "✅ Build process complete!"
echo "Check src-tauri/target/ for bundles."
