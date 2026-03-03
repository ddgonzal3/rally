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

## File Explorer Change Items: Use `display: none` Not `visibility: hidden` for Hover Actions

The M/D/U action buttons (Stage, Unstage, Discard) on change file rows must use `display: none` / `display: inline-flex` toggled via CSS hover — NOT `visibility: hidden` / `visibility: visible`. `visibility: hidden` reserves layout space even when the buttons are invisible, which truncates the file path text unnecessarily. The path should extend fully to the status letter (M, D, U) when not hovered, and only abbreviate when hover reveals the action buttons. The CSS lives in `index.html` under `.change-item .change-action-btn`.

## PaneLayout: Don't Return New Arrays from Zustand Selectors

Zustand uses `Object.is` for selector equality. A selector that returns `Array.from(...)`, `Object.keys(...)`, or `[...spread]` creates a new reference on every store change, causing the subscribing component to re-render on every store update (git polls, PTY output, etc.). If that component also triggers a store mutation during render (e.g. `getOrCreateLayout`), you get a render loop — the UI flashes for ~100ms then goes blank/dark.

**Fix:** Either return a primitive/stable reference, or use `useRef` to stabilize the array and only update the ref when contents actually change. Alternatively, move the filtering logic outside the selector and use `useMemo`.

## Zustand Selectors: Use a Module-Level Empty Constant for Fallbacks

When a zustand selector returns a fallback empty array (`[]`) for missing data, every render creates a new reference. Zustand sees new `[]` !== old `[]` via `Object.is`, triggers a re-render, which creates another `[]` — infinite loop → blank screen. **Always use a module-level constant:** `const EMPTY: T[] = [];` and return that instead of a fresh `[]` literal. This is a specific case of the broader "Don't Return New Arrays from Zustand Selectors" pitfall.

## Dropdowns/Menus: Use Native Context Menus, Not Custom HTML

Rally uses native macOS context menus via Tauri's `showContextMenu()` for all right-click and dropdown interactions. Never build custom HTML dropdown menus with manual hover styling — they look different from native menus and break UI consistency. Use `showContextMenu()` from `src/lib/contextMenu.ts`. The only exception is when you need inline input (e.g. a text field for naming) — in that case, show a minimal frosted popover just for the input, and use native menus for the action list.

## Mode Switching: Use `display: none`, Never Unmount Terminal Components

When toggling between product mode and dev mode, **never use a conditional ternary** that unmounts one view and mounts the other. Unmounting a Terminal component destroys its xterm.js instance. When remounting, the Terminal must replay the PTY output buffer into a fresh xterm — but TUI apps like Claude Code use the alternate screen buffer, cursor positioning, and other stateful escape sequences. The replayed buffer either causes doubled content (full replay + SIGWINCH redraw) or garbled output (cleared buffer loses terminal state).

**Fix:** Keep both `ProductChatPanel` and `PaneLayout` always mounted, toggling `display: none` / `display: flex`. This matches the pattern that already works for workspace switching (PaneLayout uses `display: none` for inactive workspaces). The ResizeObserver fires when the container goes from 0 to real dimensions, triggering SIGWINCH → TUI redraws correctly.

## xterm.js Instances: Never Hardcode Theme Colors

Any new xterm.js `Terminal` instance must read its theme from CSS variables (`--terminal-bg`, `--terminal-fg`, `--terminal-cursor`, `--terminal-selection`) via `getComputedStyle`, and use the per-theme ANSI color map from `Terminal.tsx`. Never hardcode hex values like `background: "#1e1e1e"` — this breaks light/dimmed themes. Also subscribe to theme changes (via the Zustand `theme` selector) and update `term.options.theme` when the theme changes, matching the pattern in `Terminal.tsx`. The terminal container's CSS `background` should also use `var(--terminal-bg)` so the flash before xterm initializes matches the theme.

## Context Menu: Always `stopPropagation()` in Nested Handlers

When a component tree has `onContextMenu` handlers at multiple levels (e.g. a tree node AND its container), the child handler **must** call `e.stopPropagation()` in addition to `e.preventDefault()`. Without it, the event bubbles to the parent, which fires a second `showContextMenu()` call. That second call clears the ghost-event suppression flag, so when the user clicks elsewhere to dismiss, macOS dispatches a ghost `contextmenu` event that opens yet another menu. Symptom: dismissing a right-click menu by clicking elsewhere opens a new menu at the click location.
