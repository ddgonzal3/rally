#!/bin/bash
set -e
cd "$(dirname "$0")/.."

APP_BUNDLE="src-tauri/target/release/bundle/macos/Rally.app"
# The binary is named after the crate ("rally"), not the product ("Rally").
# pgrep -f is case-sensitive, so match on the directory and let the name vary.
APP_BINARY_DIR="$APP_BUNDLE/Contents/MacOS"

# Only kill the instance launched from THIS build directory's app bundle.
# This avoids nuking other running Rally instances (e.g. a release install).
if [ -d "$APP_BINARY_DIR" ]; then
  PIDS=$(pgrep -f "$(pwd)/$APP_BINARY_DIR/" 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    echo "Stopping previous dev build instance..."
    kill $PIDS 2>/dev/null || true
    sleep 0.5
    # Force kill if still running
    kill -9 $PIDS 2>/dev/null || true
    sleep 0.3
  fi
fi

echo "Building..."
cargo tauri build --bundles app

# WKWebView caches index.html (unhashed) from the previous bundle, so a
# frontend-only rebuild can launch with the OLD UI. Drop the cache so the
# app always loads what was just built.
rm -rf "$HOME/Library/Caches/com.rally.app/WebKit" 2>/dev/null || true

if [ "$1" = "--no-launch" ]; then
  echo "Build complete (skipping launch)."
else
  echo "Launching..."
  open "$APP_BUNDLE"
fi
