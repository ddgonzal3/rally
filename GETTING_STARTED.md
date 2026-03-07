# Getting Started with Rally

Rally is a native macOS app for orchestrating multiple Claude Code sessions, git workflows, and dev processes across repo workspaces.

---

## 1. Creating Workspaces

A workspace groups one or more repo folders together with their own terminals, git state, and pane layout.

**To create a workspace:**

1. Click the **+** button at the bottom of the sidebar (or use **File > New Workspace**)
2. Click **Add Directory** to pick a folder (a git repo, typically)
3. Rally auto-fills the workspace name from the folder name -- edit if you want
4. Click **Create**

Your workspace appears in the sidebar. Click it to switch to it.

**Sidebar actions:**
- **Click** a workspace to select it
- **Right-click** for options: Rename, Reveal in Finder, Remove
- **Drag** workspaces to reorder them

---

## 2. Dev Mode vs Product Mode

Rally has two modes per workspace, toggled with `Cmd+Shift+M` or **View > Toggle Dev/Product Mode**.

**Dev mode** is the default -- full control with terminals, split panes, editors, diff views, and file explorer. This is where you do hands-on development work.

**Product mode** is a simplified chat interface for Claude Code. Type a prompt, get a response. Useful when you want to direct Claude without managing terminals and panes yourself -- think of it as a focused "just talk to Claude" view.

Both modes share the same workspace state. Switch between them freely without losing anything.

---

## 3. Multiple Checkouts (Worktrees)

Rally supports multiple folders per workspace. This is useful for:
- **Git worktrees** -- work on multiple branches simultaneously
- **Related repos** -- group a frontend and backend repo together
- **Split checkouts** -- different copies of the same repo

**To add more folders to a workspace:**

1. Select the workspace
2. **File > Add Folder to Workspace** (`Cmd+Shift+O`)
3. Pick the additional folder

The first folder is the "primary" path (used for git operations by default). You can switch active paths via the file explorer.

---

## 4. Panes and Terminals

Rally uses a flexible pane system. Each workspace has its own layout of terminals, editors, and more.

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+C` | Open a new Claude Code tab |
| `Cmd+Shift+M` | Toggle Dev/Product mode |
| `Cmd+/` | Split active pane right (new terminal) |
| `` Ctrl+` `` | Toggle bottom panel |
| `Cmd+W` | Close the active tab |
| `Cmd+Shift+[` / `]` | Cycle tabs left/right in active group |
| `Shift+Arrow` | Navigate between pane groups (left/right/up/down) |
| `Cmd+Shift+F` | Toggle search panel (workspace-wide find/replace) |
| `Cmd+P` | Quick open (file picker) |
| `Cmd+E` | Toggle file explorer |
| `Cmd+N` | New file |
| `Cmd+Shift+O` | Add folder to workspace |

### Pane Types

- **Terminal** -- Real PTY-backed shell, same as your regular terminal
- **Claude Code** -- Claude Code session running inside Rally
- **Editor** -- Monaco-powered code editor
- **Diff View** -- Git diff with stage/unstage controls
- **PR Review** -- Pull request viewer

### Splitting and Navigating

- **`Cmd+/`** splits the active group horizontally, creating a new terminal to the right
- **`` Ctrl+` ``** creates or toggles a bottom panel (useful for a dedicated terminal while coding)
- **`Shift+Arrow`** jumps focus between pane groups -- fast navigation without the mouse
- Drag the dividers between panes to resize them

---

## 5. File Explorer

The file explorer appears in the left panel next to the sidebar. Toggle it with `Cmd+E`.

- **Single-click** a folder to expand/collapse it
- **Double-click** a file to open it in an editor pane
- **Drag a file** into a terminal to paste its path
- **Right-click** for options: Rename, Delete, Reveal in Finder, New File/Folder

Common directories like `node_modules`, `.git`, `dist`, and `target` are hidden by default.

---

## 6. Git Workflow

Rally has a built-in git GUI that wraps `git` and `gh` CLI commands.

### Viewing Changes

- **Right-click** a workspace in the sidebar and select **Git** (or click the git status indicator)
- The **Changes tab** shows staged and unstaged files
- Click a file to see its diff
- Click the stage/unstage buttons to move files between staged and unstaged

### Committing

1. Stage your files
2. Write a commit message
3. Click **Commit**

### Syncing and Rebasing

- **Sync** -- Fetches from remote, checks out main, pulls, then rebases your branch on top
- **Rebase on main** -- Rebases your current branch onto the latest main

### Pull Requests

- **Create PR** -- Pushes your branch and opens a PR on GitHub
- Switch to the **PR tab** to view PR details, comments, reviews, checks status, and merge

### Status Indicators

The sidebar shows at-a-glance git info for each workspace:
- Current branch name
- Dirty indicator (uncommitted changes)
- Ahead/behind counts relative to origin
- PR status

Git status auto-refreshes every 10 seconds.

---

## 7. Task Panel (Scripts & Commands)

The task panel appears in the file explorer sidebar and shows two kinds of entries:

### Auto-discovered Scripts

Rally scans your workspace's `scripts/` directory and lists any executable scripts it finds. You can:

- **Click the play button** to run a script
- **Click the stop button** to kill a running script
- **Click the script name** to open it in the editor
- **Right-click** for more options (Reveal in Finder, Rename)

Scripts named `watch*` (e.g., `watch.sh`, `watch-dev.sh`) are treated as watchers -- they show live build status indicators (idle/building/success/error).

### Built-in Claude Commands

Rally ships with Claude Code commands that appear automatically:

| Command | What It Does |
|---------|-------------|
| `/ship` | Full workflow: commit, push, create PR, review, auto-merge |
| `/review-pr` | Detailed code review with flagged items |
| `/merge-pr` | Merge an existing PR |
| `/create-pr` | Create a PR from the current branch |

Clicking a built-in command opens it in a Claude pane. These commands are symlinked to `~/.claude/commands/` so they work in any Claude Code session, not just Rally.

---

## 8. The Ship Workflow

`/ship` is Rally's flagship automation -- it handles the entire commit-to-merge cycle:

1. **Detect** -- Checks git status, finds existing PRs
2. **Commit** -- Stages and commits your changes
3. **Push** -- Pushes to remote
4. **Create PR** -- Opens a PR on GitHub
5. **Check** -- Waits for CI checks to pass
6. **Review** -- Claude reviews the code, flags issues
7. **Verdict** -- Decides: auto-merge or manual review needed
8. **Merge** -- If approved, merges the PR and syncs branches

### Ship Status Pill

When `/ship` is running, a floating status pill appears showing the current phase. It works two ways:

- **From Rally's Ship button** -- Shows a full terminal with live output (click to expand)
- **From an external terminal** -- Shows phase-only status (no terminal, lightweight)

Verdicts:
- **Auto-merge** (green) -- PR passed review, will merge automatically
- **Manual review** (amber) -- Flagged items need your attention

---

## 9. Search

- **`Cmd+Shift+F`** opens the workspace-wide search panel
- Supports case-sensitive, whole-word, and regex modes
- Results are grouped by file and repo
- Click a result to jump to that line in the editor
- Expand the replace section for bulk find-and-replace

---

## 10. Settings & Configuration

### CLAUDE.md

Click the **settings icon** in the sidebar (or right-click workspace > Settings) to edit your CLAUDE.md files. These files give Claude Code persistent instructions about your project.

Rally lets you edit:
- **Global** `~/.claude/CLAUDE.md` -- applies to all projects
- **Project-level** `CLAUDE.md` -- checked into the repo, applies to that project

### RALLY.json

An optional config file in your repo root. Currently supports:
- `"excludeBuiltins": ["ship"]` -- hide specific built-in commands from the task panel

---

## 11. Common Workflows

### Quick Feature Branch

1. Create a workspace from your repo
2. Open a terminal (`Cmd+/`) or Claude Code tab (`Cmd+Shift+C`)
3. Create and checkout a feature branch
4. Edit files (double-click in file explorer to open editor)
5. View changes (right-click workspace > Git)
6. Stage files and commit
7. Create PR from the PR tab

### Ship It (Automated)

1. Make your changes
2. Click `/ship` in the task panel (or type `/ship` in a Claude pane)
3. Watch the status pill -- it handles commit, push, PR, review, and merge
4. If "manual review" verdict: click the PR link to see what was flagged

### Multi-Repo Development

1. Create a workspace with your first repo
2. Add related repos via **File > Add Folder to Workspace** (`Cmd+Shift+O`)
3. Search (`Cmd+Shift+F`) works across all paths
4. Switch between repos in the file explorer
5. Git operations target the primary path by default

### Using Claude Code Inside Rally

1. Press `Cmd+Shift+C` to open a Claude Code tab (or switch to product mode with `Cmd+Shift+M` for a chat interface)
2. Claude has full context of your workspace -- file tree, git status, etc.
3. Use `/ship`, `/review-pr`, and other commands directly
4. Stay in Rally -- no need to switch to a separate terminal

---

## 12. Tips

- **`Shift+Arrow`** to navigate between panes instead of clicking -- much faster
- **`Cmd+Shift+[` / `]`** to cycle tabs within a group
- **`` Ctrl+` ``** for a quick bottom terminal while you have editors open above
- **Drag files** from the explorer into terminals to paste paths
- **Multiple workspaces** keep projects isolated -- each has its own terminals, git state, and layout
- **Watchers** in the task panel give live build feedback without needing a visible terminal
- **`Cmd+P`** quick-opens files from anywhere in the workspace
- **Product mode** (`Cmd+Shift+M`) when you just want to talk to Claude without managing panes

---

## Prerequisites

- **macOS** (Rally is macOS-only for now)
- **git** and **gh** (GitHub CLI) installed and in your PATH
- **gh auth login** completed (for PR operations)
- **Claude Code** installed (for Claude pane features and `/ship`, `/review-pr` commands)
