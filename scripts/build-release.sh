#!/bin/bash
set -e
cd "$(dirname "$0")/.."
echo "Installing sidecar dependencies..."
(cd sidecar && npm install --production)

echo "Building frontend..."
npm run build
echo "Building Rust + bundling .app + .dmg..."
cargo tauri build --bundles app,dmg
echo "Done:"
echo "  .app: src-tauri/target/release/bundle/macos/Rally.app"
echo "  .dmg: src-tauri/target/release/bundle/dmg/"
