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

## Tauri v2: `Emitter` Trait Must Be Imported

In Tauri v2, calling `window.emit()` requires `use tauri::Emitter;` in scope. The compiler error is not obvious — it says "no method named `emit` found" rather than mentioning the missing trait import.

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

## xterm.js Selection Drift with CSS Zoom

The app uses CSS `zoom` on the body container (`App.tsx`) for UI scaling. xterm.js computes selection coordinates as `(event.clientX - rect.left) / css.cell.width`, but `clientX` and `rect` are in viewport pixels (zoomed) while `css.cell.width` is in CSS pixels (unzoomed, from OffscreenCanvas). At zoom ≠ 1.0, selection drifts by a factor of the zoom level. Monkey-patching `mouseService.getCoords()` doesn't fully fix it because `SelectionService._getMouseEventScrollAmount` calls `getCoordsRelativeToElement` directly, bypassing any patches.

**Fix:** `Terminal.tsx` applies `zoom: 1/Z` on the `.xterm` element itself, neutralizing the body zoom at the terminal level (effective zoom = Z × 1/Z = 1.0). This makes ALL of xterm's coordinate math correct without patching individual methods. Font size is scaled to `BASE_FONT_SIZE * Z` so text appears at the intended visual size. The `.xterm` element uses `position: absolute` when zoom ≠ 1 to avoid flex layout conflicts with the percentage-based sizing.

**Important layout details:**
- Do NOT set explicit `width`/`height` on the `.xterm` element — let xterm size itself from its content. Forcing `width: Z*100%` / `height: Z*100%` creates an element larger than the canvas, and the unfilled area renders as black (canvas clear color).
- The container div must have `background: var(--terminal-bg)` to cover the small row-quantization gap between the canvas edge and the container edge.
- The ResizeObserver detects zoom changes (body zoom triggers container resize) and re-applies styles automatically — no extra event listeners needed.

## Terminal Typing Lag: Background Polling Must Defer During Typing

xterm.js captures keyboard events and calls `stopPropagation()`, so `document.addEventListener("keydown", ...)` in the **bubble** phase never fires during terminal typing. If background work (git polling, etc.) checks a "last interaction" timestamp to defer, that timestamp never updates during typing — causing background Tauri invokes to fire and congest the IPC channel.

**Fix:** Use `capture: true` on the document keydown listener so it fires before xterm can stop propagation. See `App.tsx` `markInteraction`.

## Terminal Resize During Split Drag: Skip PTY IPC, Not xterm Fit

During split-panel drag, the ResizeObserver fires on every pixel. Two expensive things happen: (1) xterm `safeFit()` recalculates dimensions and re-renders content, and (2) `api.resizePty()` sends a blocking IPC call to Rust.

**Don't skip xterm fitting** — users need to see terminal content reflow in real-time. **Do skip the PTY resize IPC** — it's blocking and causes lag. The `term.onResize` handler checks `data-rally-split-drag` and skips `api.resizePty()`. A `rally:split-resize-end` event listener sends the final resize after drag completes.

Also: PTY writes go through a per-session `mpsc::channel` with a dedicated writer thread, so `write_pty` never holds the global `PtyState` mutex during blocking I/O. This prevents write operations from contending with resize or other PTY operations.

## SVG Button Jitter on Hover-Reveal Under CSS Zoom

When revealing hidden SVG buttons (e.g. fade-in on hover) inside a container with CSS `zoom`, the icons micro-shift 1-2px after appearing. Root causes:

1. **Inline SVGs have baseline gaps** — `<svg>` is an inline-replaced element, so the browser reserves space for text baseline alignment. During opacity transitions this alignment can settle differently. **Fix:** Add `display: "block"` on the SVG element.
2. **Browser default button chrome** — Buttons have user-agent padding, margin, and `appearance` that add invisible offsets. **Fix:** Explicitly set `lineHeight: 0`, `appearance: "none"`, `margin: 0` on the button.
3. **Mid-transition layer promotion** — Without compositor hints, the browser lazily promotes elements to GPU layers during transitions, causing a repaint that shifts sub-pixel positions. **Fix:** Add `transform: "translateZ(0)"` and `willChange: "opacity, max-width"` on the animated container.

All three must be addressed together — any one alone is insufficient under CSS zoom.

## Multi-Window: Never Kill All PTYs from Secondary Windows

All Tauri windows share a single `PtyManager` instance. If `killAllPtys()` runs on mount (to clean up orphaned PTYs from a previous session), it must **only run in the main/primary window**. Secondary windows (opened via "Open in New Window" with `workspaceId` or `blankWorkspace` URL params) must skip this call — otherwise they kill PTYs belonging to the primary window and every other open window.

Detect secondary windows by checking URL search params: `initialWorkspaceId` or `forceNoWorkspaceSelection`.

## Context Menu: Always `stopPropagation()` in Nested Handlers

When a component tree has `onContextMenu` handlers at multiple levels (e.g. a tree node AND its container), the child handler **must** call `e.stopPropagation()` in addition to `e.preventDefault()`. Without it, the event bubbles to the parent, which fires a second `showContextMenu()` call. That second call clears the ghost-event suppression flag, so when the user clicks elsewhere to dismiss, macOS dispatches a ghost `contextmenu` event that opens yet another menu. Symptom: dismissing a right-click menu by clicking elsewhere opens a new menu at the click location.

## Boolean In-Flight Guards Latch Forever When an Invoke Never Settles

Never guard a poll loop with a bare boolean (`if (inFlight) return; inFlight = true; try { await work() } finally { inFlight = false }`). A Tauri `invoke()` whose Rust future parks forever (e.g. an unbounded semaphore acquire, or a panicked command) means the `finally` never runs — the guard latches `true` and **every future poll silently no-ops until app restart**. This bricked PR-badge polling: one hung `git_pr_status` at startup killed the 30s interval, the focus handler, the visibilitychange handler, AND the manual refresh button, with zero errors anywhere. Use `src/lib/singleFlight.ts`, which races the work against a deadline and always settles.

Corollary on the Rust side: any `await` inside a `#[tauri::command]` must be bounded. `gh()` originally acquired the per-repo semaphore *outside* its 30s process timeout — an unbounded wait. And `tokio::time::timeout` around a `Command` does NOT kill the child when it fires; without `.kill_on_drop(true)` the process leaks as an orphan (and for git, keeps holding `.git` locks).

## `zsh -lc` Does NOT Source `.zshrc` — Homebrew Tools Vanish in .app Builds

A *login, non-interactive* shell (`zsh -lc`) sources `.zprofile`/`.zlogin` but **never `.zshrc`** — and `.zshrc` is where Homebrew's `/opt/homebrew/bin` normally lands (`eval "$(brew shellenv)"`). Rally's `full_path()` used `$SHELL -lc 'echo $PATH'`, so when launched from Finder/Dock/Spotlight it resolved a PATH with **no Homebrew**.

The failure was nearly undetectable:
- `git` still worked — `/usr/bin/git` ships with macOS and is in the minimal PATH.
- `gh` did not resolve, `resolve_bin()` fell back to the bare name, and the spawn failed with a generic ENOENT. **No process, no network, no log** — PR badges silently stayed empty forever while every other Rally feature worked.
- Launching from a terminal masked it entirely: the child shell inherited an already-correct PATH, so `./scripts/run.sh` builds behaved perfectly. Same binary, different launcher, different behavior.
- In-app terminals were never affected — PTYs spawn `zsh -l` **interactively**, which does read `.zshrc`.

Fix: `src-tauri/src/shell_env.rs` probes `zsh -ilc` with sentinel-delimited output (rc-file banners can't corrupt the parse), falls back to `-lc` then the process PATH, and unions in well-known dirs (`/opt/homebrew/bin`, `~/.local/bin`, `~/.cargo/bin`, …) that exist on disk. `resolve_bin()` now returns `Err` naming the binary and the resolved PATH instead of degrading to a bare-name spawn.

Rules:
- Never probe user PATH with `-lc`. Use `-ilc` plus sentinels plus a timeout (interactive rc files can hang or be slow).
- Never let a binary-resolution miss degrade into a bare-name spawn — the resulting ENOENT is indistinguishable from a hundred other failures.
- Never swallow a poll error with a bare `catch {}`. The PR poll's silent `catch` is the reason this survived months of debugging.
