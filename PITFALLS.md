# Known Pitfalls

Hard-won lessons. Read before starting work. Add new entries when you discover them.

## Tauri Config Changes Require Full Rebuild

Changes to `src-tauri/capabilities/default.json`, `tauri.conf.json`, or **any Rust code** (`.rs` files) are NOT picked up by the Vite watcher / hot-reload. After making such changes, always run `./scripts/run.sh` (kill → rebuild → relaunch). Only pure frontend changes (TSX/CSS/TS) hot-reload via the watcher.

## macOS Cmd+Q Bypasses Frontend Event Handlers

On macOS, Cmd+Q triggers the native application quit through the app menu system. This bypasses the webview's JavaScript `onCloseRequested` handler entirely. To intercept quit/close, you **must** handle it on the Rust side via `on_window_event` with `WindowEvent::CloseRequested` + `api.prevent_close()`, then emit an event to the frontend for the confirmation dialog. See `main.rs` for the current implementation.

## PTY Output to xterm.js: Always Write Raw Bytes

Never round-trip PTY output through `TextDecoder` → string manipulation → `TextEncoder` before writing to xterm.js. This corrupts multi-byte UTF-8 characters (box-drawing `─`, bullets `●`, spinners `⠋`) that are split across 4096-byte PTY read boundaries, producing `?` replacement characters and garbled cursor positioning. Always write raw `Uint8Array` via `term.write(rawBytes)`.

## WebKit Text Selection on Component Remount

When Tauri (WebKit) unmounts and remounts a component, the browser can flash a blue text selection overlay. Inline React `userSelect: "none"` isn't reliable because React must render first. Fix: use a CSS class (`.no-select`) in the global stylesheet with `-webkit-user-select: none`, a `*` descendant selector, and `::selection { background: transparent }` as a fallback.

## Ship Terminal: Use Persistent Hidden xterm

The ship terminal uses a persistent hidden xterm (offscreen via `position: fixed; left: -9999`) that processes PTY output incrementally via polling the store buffer. This avoids:
1. Buffer replay garble from rich TUI apps (Claude Code / Ink)
2. Missed terminal setup sequences from listener registration gaps

## Tauri v2: `Emitter` Trait Must Be Imported

In Tauri v2, calling `window.emit()` requires `use tauri::Emitter;` in scope. The compiler error is not obvious — it says "no method named `emit` found" rather than mentioning the missing trait import.
