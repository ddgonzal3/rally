#!/bin/bash
set -e
cd "$(dirname "$0")/.."

# If Vite dev server is running on 5173, trigger a webview reload.
# Otherwise, fall back to full build + relaunch.
if lsof -i :5173 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "Dev server detected — triggering reload..."
  curl -s http://localhost:5173/__reload >/dev/null
  echo "Reloaded."
else
  echo "No dev server — running full build..."
  exec ./scripts/run.sh
fi
