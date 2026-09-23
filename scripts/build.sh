#!/bin/bash
set -e
cd "$(dirname "$0")/.."
echo "Building..."
./scripts/tauri-build.sh --bundles app
echo "Done: src-tauri/target/release/bundle/macos/Rally.app"
