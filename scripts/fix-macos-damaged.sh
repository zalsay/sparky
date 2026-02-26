#!/bin/bash

# Fix "app is damaged" error on macOS by removing quarantine attributes
# Usage: ./fix-macos-damaged.sh /path/to/YourApp.app
#    or: ./fix-macos-damaged.sh  (will search current directory)

set -e

APP_PATH="$1"

if [ -z "$APP_PATH" ]; then
  # Try to find .app in current directory
  APP_PATH=$(find . -maxdepth 1 -name "*.app" | head -1)
  if [ -z "$APP_PATH" ]; then
    echo "Usage: $0 /path/to/YourApp.app"
    exit 1
  fi
fi

if [ ! -d "$APP_PATH" ]; then
  echo "Error: '$APP_PATH' not found or is not a directory"
  exit 1
fi

echo "Removing quarantine attributes from: $APP_PATH"
xattr -cr "$APP_PATH"

echo "Done. Try opening the app again."
