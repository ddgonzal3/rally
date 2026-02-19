#!/bin/bash
set -e
cd "$(dirname "$0")/.."
echo "Type-checking frontend..."
npx tsc --noEmit
echo "Checking Rust..."
cd src-tauri && cargo check
echo "All checks passed."
