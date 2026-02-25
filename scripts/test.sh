#!/bin/bash
set -e
cd "$(dirname "$0")/.."

# Rally Test Runner
# Usage:
#   ./scripts/test.sh                              # Run all tests
#   ./scripts/test.sh tests/e2e/smoke.test.ts      # Run specific test
#   ./scripts/test.sh --visual                     # Run visual tests only
#   ./scripts/test.sh --skip-build                 # Skip build, use existing binary
#   ./scripts/test.sh --skip-build tests/e2e/smoke.test.ts  # Combine flags

SKIP_BUILD=false
TEST_ARGS=()

for arg in "$@"; do
  if [ "$arg" = "--skip-build" ]; then
    SKIP_BUILD=true
  else
    TEST_ARGS+=("$arg")
  fi
done

export RALLY_TEST_MODE=1

# --- Build ---
if [ "$SKIP_BUILD" = false ]; then
  echo "Building Rally with test-bridge feature (debug mode)..."
  cargo tauri build --debug --features test-bridge --bundles app
  echo "Build complete."
fi

APP_PATH="src-tauri/target/debug/bundle/macos/Rally.app"
if [ ! -d "$APP_PATH" ]; then
  echo "ERROR: App not found at $APP_PATH"
  echo "Run without --skip-build to build first."
  exit 1
fi

# --- Kill any existing Rally ---
pkill -f "Rally.app" 2>/dev/null || true
sleep 0.5

# --- Launch ---
echo "Launching Rally in test mode..."
open "$APP_PATH"

# --- Wait for health ---
echo "Waiting for app to be ready..."
MAX_WAIT=60
WAITED=0
until curl -s http://127.0.0.1:9876/health 2>/dev/null | grep -q '"ready":true'; do
  sleep 0.5
  WAITED=$((WAITED + 1))
  if [ $WAITED -ge $((MAX_WAIT * 2)) ]; then
    echo "ERROR: App did not become ready within ${MAX_WAIT}s"
    pkill -f "Rally.app" 2>/dev/null || true
    exit 1
  fi
done
echo "App is ready."

# --- Run tests ---
echo "Running tests..."
npx tsx tests/framework/runner.ts "${TEST_ARGS[@]}"
TEST_EXIT=$?

# --- Cleanup ---
echo "Shutting down Rally..."
pkill -f "Rally.app" 2>/dev/null || true

exit $TEST_EXIT
