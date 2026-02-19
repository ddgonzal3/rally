# Known Pitfalls — Claude Workbench

This file is a living document of mistakes and corrections accumulated during development. Read this before starting work and add new entries when mistakes are discovered.

---

## Tauri / Window Management

### Window Drag Requires Both Permission and Programmatic Call

`data-tauri-drag-region` attribute alone does NOT work in Tauri v2 on macOS. You need:

1. `core:window:allow-start-dragging` in `capabilities/default.json`
2. Programmatic `appWindow.startDragging()` on mousedown
3. Guard against buttons: `if ((e.target as HTMLElement).closest("button")) return;`

**DON'T:**
```tsx
// Just the attribute — doesn't work
<div data-tauri-drag-region>Titlebar</div>
```

**DO:**
```tsx
const handleDrag = (e: React.MouseEvent) => {
  if ((e.target as HTMLElement).closest("button")) return;
  appWindow.startDragging();
};
<div data-tauri-drag-region onMouseDown={handleDrag}>Titlebar</div>
```

**Why:** Tauri v2 permissions system requires explicit grants. The attribute is necessary but not sufficient without the permission. The programmatic call is the reliable path.

### Native Titlebar Overlay vs Custom Decorations

Use `decorations: true` + `titleBarStyle: "Overlay"` + `hiddenTitle: true` for native macOS look (rounded corners, traffic lights, shadow). Don't use `decorations: false` — it gives you full control but loses all native window chrome.

### DMG Build Opens Finder Windows During Dev

`cargo tauri build` with DMG target mounts the DMG and shows Finder. For dev iteration, always use `--bundles app` to skip DMG.

---

## PTY / Terminal

### portable-pty Reads Are Blocking — Use std::thread, Not Tokio

`portable-pty`'s reader does blocking I/O. If you spawn the reader on a tokio task, it blocks the entire tokio runtime.

**DON'T:**
```rust
tokio::spawn(async move {
    reader.read(&mut buf); // Blocks the tokio worker thread
});
```

**DO:**
```rust
std::thread::spawn(move || {
    loop {
        match reader.read(&mut buf) { ... }
    }
});
```

### PTY Environment May Not Include User's Full PATH

The PTY inherits the app's environment, which may not include paths from the user's `.zshrc` (e.g., `nodenv`, `cargo`, `claude`). The current fix is spawning with `-l` (login shell) and copying `std::env::vars()`, but this may not cover everything.

If a command isn't found in the PTY, check if it needs explicit PATH setup.

### Terminal Cleanup on Unmount

Always kill the PTY and unlisten events on component unmount. Orphaned PTYs will keep running and emitting events after the terminal is gone.

---

## React / Frontend

### Zustand Store — Don't Set State During Render

`getPanes()` in the workspace store returns default panes if none exist. Don't call `set()` inside this getter — it causes infinite re-renders. Return the defaults directly and let the component handle initialization.

### xterm.js Resize — Fit After Container Is Visible

`fitAddon.fit()` returns wrong dimensions if the container has zero size (e.g., during initial render before layout). Use a ResizeObserver to fit after the container is actually visible.

### Monaco Editor Loads from CDN

`@monaco-editor/react` fetches Monaco from CDN by default. This works online but fails offline. For offline support, bundle Monaco locally via `monaco-editor` package + Vite plugin.

---

## Git Operations

### git_cmd() Is Public — Used by Both git_ops.rs and commands.rs

`git_cmd()` in `git_ops.rs` is `pub` because `commands.rs` calls it for `detect_git_info`. If you rename or change its signature, update both callers.

### Rebase Can Leave Repo in Conflict State

The `rebase()` function in `git_ops.rs` doesn't auto-resolve conflicts. If rebase fails, it returns an error but the repo is left in a mid-rebase state. The user needs to resolve manually via terminal (`git rebase --abort` or fix conflicts).

---

## Build

### Frontend Must Build Before Tauri

Tauri's `beforeBuildCommand` runs `npm run build` automatically, but if you're doing manual steps, always build the frontend first. Tauri reads from `dist/` — if it's stale or missing, the app will show a blank screen or old UI.

### Cargo Release Build Is Slow (~30s)

The Rust release build compiles with optimizations. For faster iteration during dev, consider using `cargo tauri dev` (debug mode, ~5s incremental).

---

## Adding This Section

When you make a mistake or discover a gotcha, add it here using this format:

```markdown
### [Short descriptive title]

**DON'T:**
```code
// The incorrect pattern
```

**DO:**
```code
// The correct pattern
```

**Why:** [Concrete explanation]
```
