# Git Diff Overlay — Design

## Summary

A full-screen overlay that replaces the main pane area with a beautiful, Codex-inspired git diff view. Shows all staged/unstaged changes with syntax-highlighted hunks, per-file actions (stage/unstage/discard), and a commit workflow that flows into the existing Ship pipeline.

## UX Decisions

- **View mode:** Full overlay on top of PaneLayout (panes stay mounted underneath, no state loss)
- **Diff rendering:** Custom syntax-highlighted HTML (not Monaco per-file) — lightweight, scrollable, handles many files
- **Diff format:** Hunks only with ~3 lines of context (like GitHub PRs), not full file content
- **Actions:** Full git workflow — per-file stage/unstage/discard, global Stage All/Revert All, commit with message input
- **Post-commit:** Ship button appears after successful commit, kicks off ship pipeline and closes overlay
- **Animation:** Slide up from bottom, ~200ms ease-out
- **Exit:** Back button or Escape key

## Data Layer

### New Rust Command

`git_diff(cwd: String, staged: bool) -> String` — runs `git diff` or `git diff --cached` with `--unified=3`. Returns raw unified diff string.

### Frontend Diff Parser (`src/lib/diffParser.ts`)

```ts
interface DiffFile {
  oldPath: string
  newPath: string
  additions: number
  deletions: number
  hunks: DiffHunk[]
  isNew: boolean
  isDeleted: boolean
  isRenamed: boolean
}

interface DiffHunk {
  header: string
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

interface DiffLine {
  type: 'add' | 'delete' | 'context'
  content: string
  oldLineNumber?: number
  newLineNumber?: number
}
```

### Data Flow

1. User opens overlay → fetch `git_changes(cwd)` for file counts
2. Fetch `git_diff(cwd, staged=false)` and `git_diff(cwd, staged=true)`
3. Parse into `DiffFile[]` → render
4. Refresh after actions and on `rally:git-changes-refresh` events

## UI Structure

```
┌─────────────────────────────────────────────────┐
│ ← Back to workspace          branch-name    ⟳   │  Header bar
│─────────────────────────────────────────────────│
│  [Unstaged · 3]    [Staged · 1]                 │  Tab switcher
│─────────────────────────────────────────────────│
│                                                 │
│  ▼ src/components/App.tsx      +12 -3   [↩] [+] │  File header (collapsible)
│  ┌─────────────────────────────────────────────┐│
│  │ @@ -7,4 +7,6 @@                             ││
│  │  7 │ import { useState }                     ││  Colored hunk lines
│  │  8 │+import { useGitDiff }                   ││
│  └─────────────────────────────────────────────┘│
│                                                 │
│  ▶ README.md                    +1 -0   [↩] [+] │  Collapsed file
│─────────────────────────────────────────────────│
│  [↩ Revert All]  [+ Stage All]                  │  Action bar
│  Commit: [________________________]  [Commit]   │  Commit section
└─────────────────────────────────────────────────┘
```

### Per-File Actions by Tab

| Tab      | Actions                              |
|----------|--------------------------------------|
| Unstaged | Stage (+), Discard (✕ with confirm)  |
| Staged   | Unstage (−)                          |

### Collapse Behavior

- ≤5 files: all expanded by default
- >5 files: all collapsed by default
- Click header to toggle

### Post-Commit Flow

1. Success flash: "Committed!"
2. Ship button appears
3. Click Ship → `startShipSession()` → close overlay → ShipStatusPill takes over

## State Management

### Store additions (`workspaceStore.ts`)

```ts
gitDiffOverlayOpen: boolean
gitDiffOverlayPath: string | null
gitDiffActiveTab: 'unstaged' | 'staged'

openGitDiffOverlay(workspaceId: string, rootPath: string): void
closeGitDiffOverlay(): void
```

Diff data (parsed `DiffFile[]`) lives as local state in `GitDiffOverlay.tsx` — transient, refetched on open/action.

### Entry Point

Git status badge ("N changed") in the repo header becomes clickable. Keyboard shortcut: Cmd+Shift+G.

### Refresh Strategy

- After stage/unstage/discard/commit: re-fetch active tab's diff + file counts
- On `rally:git-changes-refresh`: refetch if overlay open
- After commit with no remaining changes: auto-close after brief success flash

## Syntax Highlighting

Lightweight token-based coloring in `src/lib/syntaxHighlight.ts`. Maps file extensions to regex rules for: keywords, strings, comments, numbers. ~10 language groups (JS/TS, Rust, Python, Go, JSON, CSS, HTML, shell, Ruby, YAML).

Line backgrounds: green-tinted for additions, red-tinted for deletions, neutral for context.

## New Files

- `src/components/GitDiffOverlay.tsx` — main overlay
- `src/components/DiffFileSection.tsx` — file header + hunks
- `src/components/DiffHunkView.tsx` — hunk line rendering
- `src/lib/diffParser.ts` — unified diff parser
- `src/lib/syntaxHighlight.ts` — token coloring

## Modified Files

- `src-tauri/src/git_ops.rs` — add `diff()` function
- `src-tauri/src/commands.rs` — register `git_diff` command
- `src-tauri/src/main.rs` — add to `generate_handler![]`
- `src/lib/tauri.ts` — add `api.gitDiff()` wrapper
- `src/stores/workspaceStore.ts` — overlay state + actions
- `src/App.tsx` — render `GitDiffOverlay` conditionally + Escape handler
- `src/components/FileExplorer.tsx` or sidebar — make status badge clickable
