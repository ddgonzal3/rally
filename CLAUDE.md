# CLAUDE.md — Playbench

## What Is This?

Playbench is a **Tauri v2 macOS app** (Rust backend + React frontend) for orchestrating multiple Claude Code sessions, git workflows, and dev processes across repo workspaces.

## Build Commands

```bash
./scripts/check.sh         # Type-check TS + cargo check Rust (fast, no build)
./scripts/build.sh         # Full build → .app bundle
./scripts/run.sh           # Kill running app → build → relaunch
./scripts/build-release.sh # Build + .app + .dmg
```

**Never run `cargo tauri build` without `--bundles app`** unless you want a DMG (slow, opens Finder windows).

## IMPORTANT: After Making Changes

**Always run `./scripts/run.sh` after any code change.** This kills the running app, rebuilds, and relaunches automatically. The user should never have to manually close and reopen the app — the script handles it.

```bash
./scripts/run.sh
```

This is the standard development loop: edit → run.sh → test in app → repeat.

## Architecture

### Layers

```
React Frontend (src/)
  ├── Components render UI, call Tauri commands via invoke()
  ├── Zustand store manages workspace + git + pane state
  └── xterm.js terminals connect to PTY via Tauri events

Tauri IPC Layer
  ├── Commands: invoke("command_name", { params }) → Result
  └── Events: listen("event-name", callback) for streaming data (PTY output)

Rust Backend (src-tauri/src/)
  ├── pty_manager.rs — PTY lifecycle (spawn, write, resize, kill)
  ├── git_ops.rs — Git CLI wrapper
  ├── commands.rs — Workspace CRUD, file listing
  ├── config_ops.rs — CLAUDE.md/skills file read/write
  └── workspace.rs — Data model + JSON persistence
```

### Key Patterns

**PTY Communication**: Uses `portable-pty` crate. Reader runs on a dedicated `std::thread` (not tokio) because `portable-pty` does blocking reads. Data flows via Tauri events (`pty-output-{id}`) to keep the IPC non-blocking.

**Git Operations**: All shell out to `git` and `gh` CLI via `std::process::Command`. No libgit2. This ensures identical behavior to manual terminal usage.

**State**: Workspaces persist to `~/.playbench/workspaces.json`. Pane state is in-memory only (Zustand). Git status polls every 10 seconds.

**Window**: Uses native macOS decorations (`titleBarStyle: "Overlay"`, `hiddenTitle: true`) with programmatic `startDragging()` for the drag region. This gives native traffic lights and rounded corners.

## File Map

### Rust Backend

| File | Responsibility |
|------|---------------|
| `src-tauri/src/main.rs` | Entry point, plugin registration, managed state |
| `src-tauri/src/pty_manager.rs` | PTY spawn/write/resize/kill + event emission |
| `src-tauri/src/git_ops.rs` | `git_cmd()` helper + status/sync/rebase/commit/push/PR |
| `src-tauri/src/commands.rs` | Tauri command handlers for workspace CRUD + file listing + git info detection |
| `src-tauri/src/config_ops.rs` | Read/write CLAUDE.md files, list configs + skills |
| `src-tauri/src/workspace.rs` | Workspace/ProcessConfig/GitStatus structs + JSON persistence |
| `src-tauri/tauri.conf.json` | Window config, bundle targets, plugin permissions |
| `src-tauri/capabilities/default.json` | Tauri v2 permission grants |

### React Frontend

| File | Responsibility |
|------|---------------|
| `src/App.tsx` | Root layout: native titlebar drag region + sidebar + main |
| `src/components/Terminal.tsx` | xterm.js wired to PTY (spawn on mount, stream I/O, kill on unmount) |
| `src/components/PaneLayout.tsx` | Dynamic pane grid from Zustand state, add/close terminals |
| `src/components/Sidebar.tsx` | Workspace list + status badges + Add/Settings buttons |
| `src/components/GitActions.tsx` | Git operation buttons with result display |
| `src/components/FileExplorer.tsx` | Lazy-loading directory tree |
| `src/components/AddWorkspaceModal.tsx` | New workspace form with folder picker + git auto-detect |
| `src/components/SettingsPanel.tsx` | Monaco editor for CLAUDE.md/skills files |
| `src/stores/workspaceStore.ts` | Zustand store: workspaces, git statuses, panes, all actions |
| `src/lib/tauri.ts` | Typed wrappers for all Tauri invoke() calls |
| `src/lib/types.ts` | Workspace, GitStatus, Pane, ProcessConfig types |

## Adding New Tauri Commands

1. Write the function in the appropriate `.rs` file with `#[tauri::command]`
2. If it's a new module, add `pub mod module_name;` to `lib.rs`
3. Register in `main.rs` → `generate_handler![...]`
4. If it needs permissions, add to `capabilities/default.json`
5. Add typed wrapper in `src/lib/tauri.ts`
6. Call from React via `api.newCommand(params)`

## Adding New PTY Event Types

PTY events use the pattern `pty-{eventtype}-{ptyid}`. To add a new event:
1. Define payload struct in `pty_manager.rs` with `#[derive(Serialize, Clone)]`
2. Emit from the reader thread via `app_handle.emit(&format!("pty-eventtype-{}", id), payload)`
3. Listen in `Terminal.tsx` via `listen<PayloadType>("pty-eventtype-" + ptyId, callback)`

## Known Constraints

- **macOS only** for now (Tauri supports Windows/Linux but untested)
- **Monaco loads from CDN** by default — offline use needs bundled Monaco
- **PTY environment** may not inherit full user shell config — if commands aren't found, the shell profile may need explicit sourcing
- **Workspace data is local** — no cloud sync, no team sharing (yet)

## Development Workflow

1. Make changes to `.tsx`/`.ts` files
2. Run `./scripts/check.sh` to verify types
3. Run `./scripts/run.sh` to build and launch
4. Test in the app
5. Use `/review-pr` command before opening PRs

## Dependencies

### Rust Crates
- `tauri` v2, `tauri-plugin-shell` v2, `tauri-plugin-dialog` v2
- `portable-pty` v0.8 — cross-platform PTY
- `serde` + `serde_json` — serialization
- `tokio` — async runtime
- `uuid` — ID generation

### NPM Packages
- `react` 19, `react-dom` 19
- `@xterm/xterm` v6, `@xterm/addon-fit`, `@xterm/addon-web-links`
- `zustand` v5
- `@monaco-editor/react`
- `@tauri-apps/api` v2, `@tauri-apps/plugin-dialog`
- `vite` v7, `typescript` v5
