#!/bin/bash
set -e
cd "$(dirname "$0")/.."
echo "Installing sidecar dependencies..."
(cd sidecar && npm install --production)

echo "Building frontend..."
npm run build
echo "Building Rust + bundling .app..."
cargo tauri build --bundles app
echo "Done: src-tauri/target/release/bundle/macos/Rally.app"
