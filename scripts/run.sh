#!/bin/bash
set -e
cd "$(dirname "$0")/.."

# Gracefully quit running instance so window state saves
osascript -e 'quit app "Rally"' 2>/dev/null || true
sleep 0.5

# Force kill if still running
pkill -f "Rally" 2>/dev/null || true
sleep 0.3

echo "Building..."
npm run build
cargo tauri build --bundles app

echo "Launching..."
open "src-tauri/target/release/bundle/macos/Rally.app"
