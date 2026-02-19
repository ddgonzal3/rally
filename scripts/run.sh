#!/bin/bash
set -e
cd "$(dirname "$0")/.."
echo "Building..."
npm run build
cargo tauri build --bundles app
echo "Launching..."
open "src-tauri/target/release/bundle/macos/Workbench.app"
