# Known Pitfalls

Hard-won lessons. Read before starting work. Add new entries when you discover them.

## Tauri Config Changes Require Full Rebuild

Changes to `src-tauri/capabilities/default.json`, `tauri.conf.json`, or **any Rust code** (`.rs` files) are NOT picked up by the Vite watcher / hot-reload. After making such changes, always run `./scripts/run.sh` (kill → rebuild → relaunch). Only pure frontend changes (TSX/CSS/TS) hot-reload via the watcher.

## macOS Cmd+Q Bypasses ALL Tauri Event Handlers

On macOS, Cmd+Q triggers the native application quit through the app menu system. This goes directly to `RunEvent::Exit` — it bypasses BOTH the webview's JavaScript `onCloseRequested` AND Rust's `WindowEvent::CloseRequested` AND `RunEvent::ExitRequested`. None of them fire. There is **no way to prevent it** through event handlers.

The only solution is to **replace the default Quit menu item** with a custom one bound to `CmdOrCtrl+Q` that routes through `on_menu_event`. The red close button (X) still goes through `WindowEvent::CloseRequested` and can be intercepted via `on_window_event`. See `main.rs` for the current implementation.

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

## Ship Signal: `phase` Field Uses `#[serde(default)]`

The `ShipSignal` struct in `ship_ops.rs` has `phase: Option<String>` with `#[serde(default)]`. This means older signal files (from ship.md v5 and earlier) that don't include a `phase` field will deserialize successfully with `phase: None`. If you add new required fields to the signal file format, always use `#[serde(default)]` for backward compatibility with in-flight ship runs.

## Ship Sessions: Always Guard `ptyId` Before PTY Operations

`ShipSession.ptyId` is optional — headless sessions (created from external `/ship` runs) have no PTY. Always check `session.ptyId` before calling `killPty`, `resizePty`, `writePty`, or docking the session. The `dismissShipSession` and `dockShipSession` store actions already guard this.

## Context Menu: Always `stopPropagation()` in Nested Handlers

When a component tree has `onContextMenu` handlers at multiple levels (e.g. a tree node AND its container), the child handler **must** call `e.stopPropagation()` in addition to `e.preventDefault()`. Without it, the event bubbles to the parent, which fires a second `showContextMenu()` call. That second call clears the ghost-event suppression flag, so when the user clicks elsewhere to dismiss, macOS dispatches a ghost `contextmenu` event that opens yet another menu. Symptom: dismissing a right-click menu by clicking elsewhere opens a new menu at the click location.
