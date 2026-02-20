# Rally

A macOS app for orchestrating multiple Claude Code sessions, git workflows, and dev processes across repo workspaces.

## What It Does

- **Workspace Management** — Create/manage full repo clones, each pinned to a branch
- **Embedded Terminals** — Real PTY-backed terminal sessions (xterm.js + portable-pty)
- **Git Workflow** — One-click sync, rebase, commit, push, PR creation
- **File Explorer** — Browse workspace files with lazy-loading tree
- **Claude Code Integration** — Auto-launch Claude Code sessions per workspace
- **CLAUDE.md Editor** — View/edit global and project CLAUDE.md files with Monaco editor
- **Process Manager** — Auto-start dev processes (watchers, servers) per workspace

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| App Shell | **Tauri v2** | Native macOS window, IPC, bundling (.app/.dmg) |
| Frontend | **React 19** + **TypeScript** | UI components, state management |
| Terminal | **xterm.js v6** + **portable-pty** | Real terminal emulation with PTY backend |
| State | **Zustand** | Lightweight reactive state management |
| Editor | **Monaco Editor** | VS Code-quality editing for CLAUDE.md/skills |
| Backend | **Rust** | PTY management, git operations, file system |
| Git | **git CLI** + **gh CLI** | All git operations via subprocess |
| Build | **Vite** + **Cargo** | Frontend bundling + Rust compilation |

## Architecture

```
┌──────────────────────────────────────┐
│         React Frontend               │
│  ┌──────────┐  ┌──────────────────┐  │
│  │ xterm.js │  │ Workspace UI     │  │
│  │ terminals│  │ Git actions      │  │
│  │          │  │ File explorer    │  │
│  │          │  │ Settings (Monaco)│  │
│  └────┬─────┘  └──────┬───────────┘  │
│       │ PTY data       │ commands    │
├───────┼────────────────┼─────────────┤
│       │   Tauri IPC    │             │
├───────┼────────────────┼─────────────┤
│       ▼                ▼             │
│  ┌──────────┐  ┌──────────────────┐  │
│  │ PTY      │  │ Git / Config /   │  │
│  │ Manager  │  │ Workspace Mgr    │  │
│  │ (Rust)   │  │ (Rust)           │  │
│  └──────────┘  └──────────────────┘  │
│         Rust Backend                 │
└──────────────────────────────────────┘
```

### How PTY Works

1. Frontend calls `spawn_pty(cwd, command, cols, rows)` → Rust spawns a real shell process
2. Rust reads PTY stdout on a dedicated thread, emits `pty-output-{id}` events
3. Frontend listens for events, writes raw bytes to xterm.js
4. User keystrokes go from xterm → `write_pty(id, data)` → Rust writes to PTY stdin
5. Resize events forwarded via `resize_pty(id, cols, rows)`

### How Git Operations Work

All git operations shell out to `git` and `gh` CLI. No libgit2, no custom git implementation — just structured wrappers around the real tools. This means:
- Identical behavior to what you'd do in a terminal
- Full compatibility with git hooks, configs, credentials
- `gh` handles GitHub auth via its own credential store

## Project Structure

```
rally/
├── scripts/                    # Build & run scripts
│   ├── build.sh                # Build .app bundle
│   ├── run.sh                  # Build + launch app
│   ├── build-release.sh        # Build .app + .dmg for distribution
│   └── check.sh                # Type-check frontend + cargo check
├── src/                        # React frontend
│   ├── App.tsx                 # Root layout with native titlebar
│   ├── main.tsx                # React entry point
│   ├── components/
│   │   ├── Sidebar.tsx         # Workspace list, git status, settings access
│   │   ├── Terminal.tsx        # xterm.js terminal wired to PTY backend
│   │   ├── PaneLayout.tsx      # Dynamic split-pane terminal grid
│   │   ├── GitActions.tsx      # Sync, rebase, commit, push, PR buttons
│   │   ├── FileExplorer.tsx    # Lazy-loading file tree
│   │   ├── AddWorkspaceModal.tsx  # New workspace form with git auto-detect
│   │   └── SettingsPanel.tsx   # CLAUDE.md/skills editor with Monaco
│   ├── stores/
│   │   └── workspaceStore.ts   # Zustand store (workspaces, git, panes)
│   └── lib/
│       ├── tauri.ts            # Typed Tauri API wrappers
│       └── types.ts            # Shared TypeScript types
├── src-tauri/                  # Rust backend
│   ├── src/
│   │   ├── main.rs             # Tauri entry point, command registration
│   │   ├── lib.rs              # Module re-exports
│   │   ├── pty_manager.rs      # PTY lifecycle (spawn, write, resize, kill)
│   │   ├── git_ops.rs          # Git CLI wrapper (status, sync, rebase, push, PR)
│   │   ├── commands.rs         # Workspace CRUD, file listing, git info detection
│   │   ├── config_ops.rs       # CLAUDE.md/skills read/write
│   │   └── workspace.rs        # Workspace data model + JSON persistence
│   ├── Cargo.toml
│   ├── tauri.conf.json         # Tauri window + bundle config
│   └── capabilities/
│       └── default.json        # Tauri v2 permissions
├── .claude/
│   ├── commands/
│   │   └── review-pr.md        # PR review skill for Claude Code
│   └── settings.local.json
├── CLAUDE.md                   # Agent instructions for this project
├── KNOWN-PITFALLS.md           # Accumulated mistake patterns
├── SPEC.md                     # Original feature spec
├── index.html                  # HTML entry point
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## Prerequisites

- **macOS** (primary target)
- **Node.js 22+** (via nodenv)
- **Rust** (stable, via rustup)
- **Tauri CLI v2**: `cargo install tauri-cli --version "^2"`
- **gh CLI**: `brew install gh` (for PR operations)

## Quick Start

```bash
# Install dependencies
npm install

# Type-check + build + launch
./scripts/run.sh

# Or step by step:
./scripts/check.sh    # Verify everything compiles
./scripts/build.sh    # Build .app bundle
open src-tauri/target/release/bundle/macos/Rally.app
```

## NPM Scripts

| Script | What it does |
|--------|-------------|
| `npm run app` | Build frontend + Rust + .app bundle |
| `npm run app:run` | Build + auto-launch the .app |
| `npm run app:dmg` | Build + create .dmg for distribution |
| `npm run dev` | Vite dev server only (for frontend iteration) |
| `npm run build` | Frontend build only (tsc + vite) |

## Workspace Data

Workspace configs persist at `~/.rally/workspaces.json`. Each workspace stores:
- Name, path, repo URL, branch, main branch
- Process configs (auto-start commands)

## Status

**MVP — functional but early.** Working features:
- [x] Native macOS .app with draggable titlebar
- [x] Add/remove workspaces with git auto-detection
- [x] Real PTY terminals (shell + Claude Code)
- [x] Git operations (sync, rebase, commit, push, PR)
- [x] File explorer
- [x] Dynamic pane layout (add/close terminals)
- [x] CLAUDE.md editor with Monaco
- [ ] Process manager (auto-start watchers)
- [ ] Workspace templates
- [ ] Multi-workspace dashboard
- [ ] Onboarding wizard
