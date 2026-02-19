# Workbench

A macOS app for orchestrating Claude Code sessions, git workflows, and dev processes across multiple repo workspaces.

## Problem

Using Claude Code effectively on a team project requires juggling:
- Multiple terminal windows (Claude sessions, watchers, shells)
- Git state across multiple repo copies (sync, rebase, push, PR)
- Build processes and dev servers per workspace
- Onboarding (clone, tokens, deps, env)

Power users solve this with shell aliases and muscle memory. Everyone else is locked out.

## Core Concept

**Workspaces** are full repo clones, each pinned to a branch. The app manages their lifecycle, git state, running processes, and Claude Code sessions — all in one window.

```
┌─────────────────────────────────────────────────────────────────┐
│  Workbench                                               │
├────────┬────────────────────────────────────────────────────────┤
│        │  ┌─────────────────────┐  ┌─────────────────────────┐ │
│  Side  │  │  Claude Code (PTY)  │  │  Claude Code (PTY)      │ │
│  bar   │  │                     │  │                          │ │
│        │  │  Workspace A        │  │  Workspace B             │ │
│  -----─│  │  danny/dev          │  │  danny/main              │ │
│  Work  │  └─────────────────────┘  └─────────────────────────┘ │
│  spaces│  ┌─────────────────────┐  ┌─────────────────────────┐ │
│        │  │  Frontend Watcher   │  │  Terminal                │ │
│  -----─│  │  (auto-started)     │  │  (general purpose)      │ │
│  Git   │  │                     │  │                          │ │
│  Status│  └─────────────────────┘  └─────────────────────────┘ │
│        │                                                        │
│  -----─│  ┌─────────────────────────────────────────────────┐  │
│  Procs │  │  Git Actions Bar                                │  │
│        │  │  [Sync] [Rebase] [Commit] [Push] [PR] [Review]  │  │
│        │  └─────────────────────────────────────────────────┘  │
├────────┴────────────────────────────────────────────────────────┤
│  Status: Workspace A: watching (3s ago) | Workspace B: idle    │
└─────────────────────────────────────────────────────────────────┘
```

## Features

### P0 — Core (MVP)

#### 1. Workspace Management
- **Create workspace**: Clone a repo to a named directory, checkout a branch
- **List workspaces**: Show all managed clones with branch, dirty state, ahead/behind main
- **Remove workspace**: Delete clone from disk (with confirmation)
- **Workspace config**: Each workspace stores its settings (branch, processes to auto-start, repo URL)

#### 2. Embedded Terminals (PTY)
- Full terminal emulator per pane (xterm.js)
- Spawn Claude Code sessions (`claude --dangerously-skip-permissions` or normal mode)
- Spawn arbitrary shell sessions
- Split/tab layout — user arranges panes per workspace
- Terminal output is searchable

#### 3. Git Workflow Actions
One-click operations, scoped to the active workspace:

| Action | What it does |
|--------|-------------|
| **Sync** | `git checkout main && git pull && git rebase main <branch>` (their `gsync`) |
| **Rebase** | Stash, pull main, rebase, pop stash (their `grb`) |
| **Commit** | Stage changes, show diff, write message, commit |
| **Push** | Push with upstream tracking if needed |
| **Create PR** | Push + `gh pr create --fill` (or with custom title/body) |
| **Review PR** | Kick off a Claude Code PR review session |
| **Merge PR** | Merge via `gh pr merge` after checks pass |

Each action shows a **preview** of what it will do before executing (e.g., "Will rebase `danny/dev` onto `main` (3 commits ahead, 12 behind)").

#### 4. Process Manager
- Define processes per workspace (e.g., "Frontend Watcher": `./helpers/watch-frontend.sh`)
- Auto-start configured processes when workspace is opened
- Status indicators: running, stopped, error
- One-click restart
- Log output captured and viewable

### P1 — Quality of Life

#### 5. Git State Dashboard
- Visual branch graph (simplified)
- Uncommitted changes indicator
- PR status (open, checks passing, review state)
- Merge conflict detection with guided resolution

#### 6. Onboarding Flow
- "New Workspace" wizard:
  1. Enter repo URL
  2. App checks for git credentials, prompts setup if missing
  3. Clone repo
  4. Detect project type (Node, Python, Rust, etc.)
  5. Run dependency install (`npm install`, etc.)
  6. Detect and suggest processes (find `watch` scripts in package.json, etc.)
  7. Ready to go

#### 7. Claude Code Integration
- Detect Claude Code config (CLAUDE.md, .claude/ directory)
- Show session cost/token usage if available
- Quick-launch with project-specific flags

### P2 — Team Features

#### 8. Workspace Templates
- Save a workspace setup as a template (repo, branch naming convention, processes, layout)
- Share templates with team ("Playground Dev Setup")

#### 9. Multi-Workspace Operations
- "Sync All" — rebase all workspaces against main
- "Status All" — dashboard view of all workspace states
- Bulk PR management

## Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| **App shell** | Tauri v2 | Native macOS windows, small binary, Rust backend |
| **Frontend** | React + TypeScript | Large ecosystem, fast iteration, good xterm.js support |
| **Terminal** | xterm.js + node-pty (via Tauri sidecar or Rust PTY) | Industry-standard terminal emulation |
| **Git operations** | `git` CLI + `gh` CLI (spawned from Rust) | Reliable, no need to reimplement git |
| **State** | SQLite (via Tauri plugin) | Persist workspace configs, process definitions |
| **IPC** | Tauri commands + events | Rust backend <-> React frontend communication |

### Architecture

```
┌──────────────────────────────────┐
│         React Frontend           │
│  ┌──────────┐  ┌──────────────┐  │
│  │ xterm.js │  │ Workspace UI │  │
│  │ terminals│  │ Git actions  │  │
│  └────┬─────┘  └──────┬───────┘  │
│       │ PTY data       │ commands │
├───────┼────────────────┼─────────┤
│       │   Tauri IPC    │         │
├───────┼────────────────┼─────────┤
│       ▼                ▼         │
│  ┌──────────┐  ┌──────────────┐  │
│  │ PTY      │  │ Git/Process  │  │
│  │ Manager  │  │ Manager      │  │
│  │ (Rust)   │  │ (Rust)       │  │
│  └──────────┘  └──────────────┘  │
│         Rust Backend             │
└──────────────────────────────────┘
```

### Key Rust Crates

- `portable-pty` — cross-platform PTY spawning
- `tauri` v2 — app framework
- `serde` / `serde_json` — serialization
- `tokio` — async runtime
- `rusqlite` — SQLite for workspace persistence

### Key npm Packages

- `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links` — terminal emulation
- `react` + `react-dom` — UI
- `@tauri-apps/api` — Tauri frontend bindings
- `zustand` or `jotai` — lightweight state management

## Data Model

```
Workspace {
  id: uuid
  name: string              // "playground-dev"
  path: string              // "/Users/splice/splice/playground-dev"
  repo_url: string          // "git@github.com:splice/playground.git"
  branch: string            // "danny/dev"
  main_branch: string       // "main"
  processes: Process[]      // configured processes
  layout: PaneLayout        // saved terminal arrangement
  created_at: timestamp
}

Process {
  id: uuid
  workspace_id: uuid
  name: string              // "Frontend Watcher"
  command: string           // "./helpers/watch-frontend.sh"
  cwd: string               // relative to workspace path
  auto_start: boolean
  env: Record<string, string>
}

Session {
  id: uuid
  workspace_id: uuid
  type: "claude" | "terminal"
  pty_id: string            // reference to running PTY
  started_at: timestamp
}
```

## File Structure (Initial)

```
workbench/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs              # Tauri entry point
│   │   ├── pty_manager.rs       # PTY spawning and management
│   │   ├── git_ops.rs           # Git CLI wrapper
│   │   ├── process_manager.rs   # Process lifecycle
│   │   ├── workspace.rs         # Workspace CRUD
│   │   └── commands.rs          # Tauri IPC command handlers
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/
│   ├── App.tsx
│   ├── components/
│   │   ├── Sidebar.tsx          # Workspace list, git status
│   │   ├── Terminal.tsx         # xterm.js wrapper
│   │   ├── PaneLayout.tsx       # Split pane container
│   │   ├── GitActions.tsx       # Sync, rebase, commit, push, PR buttons
│   │   ├── ProcessPanel.tsx     # Process status and controls
│   │   └── OnboardingWizard.tsx # New workspace setup
│   ├── hooks/
│   │   ├── useWorkspace.ts
│   │   ├── useTerminal.ts
│   │   └── useGitStatus.ts
│   ├── stores/
│   │   └── workspaceStore.ts    # Zustand store
│   └── lib/
│       ├── tauri.ts             # Tauri command wrappers
│       └── types.ts             # Shared types
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
└── SPEC.md
```

## Open Questions

1. **Name** — "Workbench" is a working title. Open to suggestions.
2. **Terminal emulation approach** — `portable-pty` from Rust, or spawn a node sidecar with `node-pty`? Rust-native is cleaner but `node-pty` is battle-tested with xterm.js.
3. **Layout persistence** — save pane arrangements per workspace, or keep it simple with a fixed 2x2 grid?
4. **Scope of git operations** — should the app handle merge conflicts inline, or just detect them and drop the user into a terminal?
5. **Auth** — is this a single-user local app, or will it need any team/cloud features later?
