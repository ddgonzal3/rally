#!/bin/bash
set -e
cd "$(dirname "$0")/.."

# Kill any existing Rally and dev server
osascript -e 'quit app "Rally"' 2>/dev/null || true
sleep 0.5
pkill -f "Rally" 2>/dev/null || true
sleep 0.3

echo "Starting Tauri dev mode (frontend hot-reload)..."
cargo tauri dev
