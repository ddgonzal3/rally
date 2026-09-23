#!/bin/bash
# Every Rally bundle build goes through here: `cargo tauri build` with this
# machine's signing identity. The identity is never committed to
# tauri.conf.json, because a certificate lives in one person's keychain and
# builds fail everywhere else.
#
# Order: $APPLE_SIGNING_IDENTITY if already set, else the first valid
# "Apple Development" identity in the keychain, else no signing (Tauri's
# default). Unsigned works, but macOS forgets Accessibility / Screen
# Recording grants on every rebuild (see PITFALLS.md).
set -e
cd "$(dirname "$0")/.."

if [ -z "$APPLE_SIGNING_IDENTITY" ]; then
  IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/^ *[0-9]*) [0-9A-F]* "\(Apple Development: .*\)"$/\1/p' \
    | head -n 1)
  if [ -n "$IDENTITY" ]; then
    export APPLE_SIGNING_IDENTITY="$IDENTITY"
  else
    echo "No Apple Development signing identity found; building unsigned."
    echo "macOS permission grants (Accessibility, Screen Recording) will reset on each rebuild."
  fi
fi

if [ -n "$APPLE_SIGNING_IDENTITY" ]; then
  echo "Signing with: $APPLE_SIGNING_IDENTITY"
fi

exec cargo tauri build "$@"
