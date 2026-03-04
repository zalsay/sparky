#!/bin/bash

# Exit on error
set -e

echo "🔨 Building Sparky..."

# Build frontend
echo "📦 Building frontend..."
cd ui
npm install
npm run build
cd ..

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
        if [ "$1" == "--all" ]; then
            echo "🍎 Detected macOS. Building for ALL targets (x64 and ARM)..."
            build_target "x86_64-apple-darwin" "dmg"
            build_target "aarch64-apple-darwin" "dmg"
        else
            ARCH=$(uname -m)
            if [ "$ARCH" == "arm64" ]; then
                 echo "🍎 Detected macOS (Apple Silicon). Building for ARM..."
                 build_target "aarch64-apple-darwin" "dmg"
            else
                 echo "🍎 Detected macOS (Intel). Building for x64..."
                 build_target "x86_64-apple-darwin" "dmg"
            fi
        fi
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

# Export artifacts to release directory
echo "📂 Exporting artifacts to release directory..."
mkdir -p release
rm -rf release/*

# Copy bundles (DMG, MSI, EXE, DEB, RPM, etc.)
if [ -d "src-tauri/target" ]; then
    find src-tauri/target -name "*.dmg" -o -name "*.msi" -o -name "*.exe" -o -name "*.deb" -o -name "*.rpm" -o -name "*.AppImage" | xargs -I {} cp -f {} release/
    # Copy app binaries (sparky-app or sparky-app.exe)
    find src-tauri/target -name "sparky-app" -exec cp -f {} release/ \;
    find src-tauri/target -name "sparky-app.exe" -exec cp -f {} release/ \;
fi

# Copy CLI binary (sparky-server or sparky-server.exe)
if [ -f "target/release/sparky-server" ]; then
    cp -f target/release/sparky-server release/
fi
if [ -f "target/release/sparky-server.exe" ]; then
    cp -f target/release/sparky-server.exe release/
fi

echo "✨ Artifacts exported to $(pwd)/release:"
ls -lh release/
open "$(pwd)/release"