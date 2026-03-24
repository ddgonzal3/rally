#!/bin/bash
set -e
cd "$(dirname "$0")/.."

APP_BUNDLE="src-tauri/target/release/bundle/macos/Rally.app"
APP_BINARY="$APP_BUNDLE/Contents/MacOS/Rally"

# Only kill the instance launched from THIS build directory's app bundle.
# This avoids nuking other running Rally instances (e.g. a release install).
if [ -f "$APP_BINARY" ]; then
  PIDS=$(pgrep -f "$APP_BINARY" 2>/dev/null || true)
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

if [ "$1" = "--no-launch" ]; then
  echo "Build complete (skipping launch)."
else
  echo "Launching..."
  open "$APP_BUNDLE"
fi
