# Git Workflow Overhaul

**Date:** 2026-02-22
**Status:** Approved

## Summary

Replace Rally's button-driven git UI with a terminal-first workflow powered by standalone shell scripts and Claude Code slash commands. Rally becomes a viewer (diffs, staging, status) while all git actions happen via CLI scripts or Claude Code sessions.

## Motivation

- Git action buttons in Rally duplicate what's faster in the terminal
- Ship/merge/review workflows should be composable CLI scripts, not UI-only
- Scripts must be callable from any context: user terminal, Claude Code shell, Rally PTY
- Claude Code should handle review + merge autonomously for low-risk changes

## Architecture

### Script Installation

Rally installs scripts to `~/.rally/bin/` on startup using an **install-once** strategy:
- If the script doesn't exist, write it
- If it already exists, leave it alone (user may have customized)
- Scripts are embedded in the Rally binary via `include_str!()` from `src-tauri/resources/scripts/`

This differs from slash commands (ship.md, review-pr.md) which use **version-marker** updates because they're Claude prompts tightly coupled to Rally's signal protocol.

User adds `export PATH="$HOME/.rally/bin:$PATH"` to their `~/.zshrc` once.

### Scripts

All scripts live in `src-tauri/resources/scripts/` and get installed to `~/.rally/bin/`.

#### `gship` — Launch Claude Code to ship

```bash
#!/bin/bash
# Guard: not on main
branch=$(git symbolic-ref --short HEAD 2>/dev/null)
if [ -z "$branch" ]; then echo "Not in a git repo"; exit 1; fi
if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
  echo "Cannot ship from $branch. Switch to a feature branch first."
  exit 1
fi

# Guard: must have commits ahead of main
main_branch="main"
ahead=$(git rev-list --count "$main_branch".."$branch" 2>/dev/null)
if [ "$ahead" = "0" ] || [ -z "$ahead" ]; then
  echo "No commits ahead of $main_branch. Nothing to ship."
  exit 1
fi

claude --dangerously-skip-permissions -p "/ship"
```

#### `gpr` — Push + create PR

```bash
#!/bin/bash
branch=$(git symbolic-ref --short HEAD 2>/dev/null)
if [ -z "$branch" ]; then echo "Not in a git repo"; exit 1; fi
if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
  echo "Cannot create PR from $branch. Switch to a feature branch first."
  exit 1
fi

echo "Pushing $branch..."
git push --set-upstream origin "$branch" 2>/dev/null || git push

echo "Creating PR..."
gh pr create --fill
```

#### `gmerge` — Squash merge PR + sync local branch

```bash
#!/bin/bash
branch=$(git symbolic-ref --short HEAD 2>/dev/null)
main_branch="main"

# Guard: not on main
if [ "$branch" = "$main_branch" ] || [ "$branch" = "master" ]; then
  echo "Cannot merge from $main_branch. Switch to a feature branch."
  exit 1
fi

# Ensure local is up to date with remote
echo "Fetching remote..."
git fetch origin

local_head=$(git rev-parse HEAD)
remote_head=$(git rev-parse "origin/$branch" 2>/dev/null)

if [ -n "$remote_head" ] && [ "$local_head" != "$remote_head" ]; then
  local_count=$(git rev-list --count "origin/$branch".."$branch" 2>/dev/null)
  remote_count=$(git rev-list --count "$branch".."origin/$branch" 2>/dev/null)
  if [ "$remote_count" -gt 0 ]; then
    echo "Local branch is behind remote by $remote_count commit(s). Pull first:"
    echo "  git pull --rebase"
    exit 1
  fi
fi

# Check PR exists and is mergeable
pr_state=$(gh pr view --json state,mergeable --jq '.state + ":" + .mergeable' 2>/dev/null)
if [ -z "$pr_state" ]; then
  echo "No PR found for branch $branch."
  exit 1
fi

state=$(echo "$pr_state" | cut -d: -f1)
mergeable=$(echo "$pr_state" | cut -d: -f2)

if [ "$state" != "OPEN" ]; then
  echo "PR is not open (state: $state)."
  exit 1
fi

if [ "$mergeable" = "CONFLICTING" ]; then
  echo "PR has merge conflicts. Resolve them first."
  exit 1
fi

# Squash merge
echo "Squash merging PR..."
gh pr merge --squash || { echo "Merge failed."; exit 1; }

# Sync local branch with main
echo "Syncing local branch with $main_branch..."
git checkout "$main_branch"
git pull

git checkout "$branch"
ahead=$(git rev-list --count "$main_branch".."$branch")
if [ "$ahead" -gt 0 ]; then
  git reset --hard "HEAD~$ahead"
  git rebase "$main_branch"
fi

git push --force-with-lease

echo "Merged and synced. $branch is now up to date with $main_branch."
```

#### `gfinish` — Commit + push + merge (post manual review)

```bash
#!/bin/bash
branch=$(git symbolic-ref --short HEAD 2>/dev/null)
if [ -z "$branch" ]; then echo "Not in a git repo"; exit 1; fi
if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
  echo "Cannot finish from $branch."
  exit 1
fi

# Commit
msg="${1:-Review fixes}"
git add -u
git commit -m "$msg" || { echo "Nothing to commit."; exit 1; }

# Push (smart: try normal, fall back to set-upstream)
echo "Pushing..."
git push 2>/dev/null || git push --set-upstream origin "$branch"

# Merge + sync
echo "Merging..."
exec gmerge
```

#### `gsync` — Hard reset + rebase (nuke & sync)

```bash
#!/bin/bash
branch=$(git symbolic-ref --short HEAD 2>/dev/null)
main_branch="main"

if [ -z "$branch" ]; then echo "Not in a git repo"; exit 1; fi
if [ "$branch" = "$main_branch" ]; then echo "Already on $main_branch"; exit 1; fi

ahead=$(git rev-list --count "$main_branch".."$branch")
echo "Syncing $branch (resetting $ahead commit(s), rebasing onto $main_branch)..."

git checkout "$branch"
if [ "$ahead" -gt 0 ]; then
  git reset --hard "HEAD~$ahead"
fi
git checkout "$main_branch"
git pull
git rebase "$main_branch" "$branch"

echo "$branch synced with $main_branch."
```

#### `grb` — Safe rebase with stash

```bash
#!/bin/bash
branch=$(git symbolic-ref --short HEAD 2>/dev/null)
main_branch="main"

if [ -z "$branch" ]; then echo "Not in a git repo"; exit 1; fi
if [ "$branch" = "$main_branch" ]; then echo "Already on $main_branch"; exit 1; fi

echo "Rebasing $branch onto $main_branch..."

git checkout "$branch" || { echo "Failed to checkout $branch"; exit 1; }

# Stash if dirty
stash_count=$(git stash list | wc -l)
git stash
new_stash_count=$(git stash list | wc -l)
did_stash=false
[ "$new_stash_count" -gt "$stash_count" ] && did_stash=true

# Update main
git checkout "$main_branch" || { echo "Failed to checkout $main_branch"; exit 1; }
git pull || { echo "Failed to pull $main_branch"; git checkout "$branch"; exit 1; }

# Rebase
git checkout "$branch" || { echo "Failed to checkout $branch"; exit 1; }
git rebase "$main_branch" || {
  echo "Rebase failed. Resolve conflicts or run 'git rebase --abort'"
  exit 1
}

# Restore stash
if $did_stash; then
  git stash pop || echo "Stash pop had conflicts - resolve manually"
fi

echo "$branch rebased onto $main_branch."
```

### ship.md Rewrite

**Current flow:** detect → commit → push → PR → review → verdict → merge
**New flow:** detect → guard → sync → push → PR → review → verdict → auto-merge or flag

Key changes:
- **No committing.** If working tree is dirty, abort: "Commit your changes first."
- **Guards:** Must be on feature branch. Must have commits ahead of main.
- **Sync first:** Rebase onto main before pushing (clean PR base).
- **Review verdict paths:**
  - **Low-risk (auto_merge):** Commit review fixes → push → run `gmerge` → write signal → done.
  - **Flagged (manual_review):** Stage changes only (`git add -u`). Tell user: "Changes staged. Review them, then run `gfinish` when ready." Write signal → done.
- Signal file protocol unchanged. Rally watches as before.

### review-pr.md Updates

The delegation-to-subagents pattern stays. Two changes to the post-review behavior:

- **Low-risk findings:** After fixing issues, `git add -u && git commit -m "Review fixes" && git push`. Short commit message unless specifics warranted.
- **Flagged findings:** `git add -u` only. Print: "Changes staged for review. Run `gfinish \"message\"` when ready."

### Rally UI Changes

#### Remove from GitActions.tsx

- All action buttons: Sync, Rebase, Commit, Push, PR, Merge
- Commit message input
- Related store action wiring (`syncPath`, `rebasePath`, `commitPath`, `pushPath`, `createPrForPath`, `mergePrForPath`)

#### Keep in GitActions.tsx

- Status bar: branch name, ahead/behind count, dirty file count
- PR status bar: PR number, mergeable state, review decision, checks status
- Refresh button (or auto-poll only)

#### Keep in FileExplorer.tsx (unchanged)

- Stage / Unstage / Discard file actions
- Diff viewer (file-at-HEAD comparison)

#### Keep (unchanged)

- Ship signal watching (`pollShipSignals` in workspaceStore)
- `ShipStatusPill` component (shows ship progress from any context)

### Rust Backend Changes

#### New: Script installation

In `ship_ops.rs`, extend `ensure_default_commands()` to also install scripts:
- Embed scripts via `include_str!("../resources/scripts/gship")` etc.
- Install to `~/.rally/bin/` using install-once strategy (skip if file exists)
- Make executable (chmod 755)

#### Keep

- All `git_ops.rs` functions (used by `post_merge_sync`, signal handling)
- Ship signal protocol (`check_ship_signal`, `clear_ship_signal`, `check_ship_trigger`)
- `post_merge_sync` command

#### Remove (or leave as dead code)

- Tauri command registrations for git operations no longer called from frontend
- Related store actions that only existed for the button UI

### zshrc Changes

**Remove:**
- `gsync()` function (replaced by `~/.rally/bin/gsync`)
- `grb()` function (replaced by `~/.rally/bin/grb`)
- `alias gpr="gp && gh pr create --fill"` (replaced by `~/.rally/bin/gpr`)

**Add:**
- `export PATH="$HOME/.rally/bin:$PATH"`

**Keep (unchanged):**
- All simple aliases: `gs`, `ga`, `gc`, `gca`, `gco`, `gb`, `gl`, `gp`, `gpf`, `gu`, `gcp`, `gg`

## Flow Diagrams

### Happy Path: gship

```
gship
  └─ claude --dangerously-skip-permissions -p "/ship"
       ├─ Guard: feature branch? commits ahead?
       ├─ Sync: rebase onto main
       ├─ Push
       ├─ Create PR (if needed)
       ├─ Review PR (delegate to subagents)
       │   ├─ Low-risk fixes found:
       │   │   commit → push → gmerge → done
       │   └─ Flagged issues found:
       │       stage only → tell user → gfinish when ready
       └─ Write ship signal (Rally watches)
```

### Happy Path: Manual workflow

```
gc -m "my changes"     # commit
gpr                     # push + create PR
# ... wait for CI, get reviews ...
gmerge                  # squash merge + sync local branch
```

### Post-flag recovery

```
# Ship flagged items for review
# User reviews staged changes in Rally or terminal
# Makes adjustments if needed
gfinish "addressed review feedback"   # commit + push + merge + sync
```

## Files to Modify

| File | Change |
|------|--------|
| `src-tauri/resources/scripts/gship` | New file |
| `src-tauri/resources/scripts/gpr` | New file |
| `src-tauri/resources/scripts/gmerge` | New file |
| `src-tauri/resources/scripts/gfinish` | New file |
| `src-tauri/resources/scripts/gsync` | New file |
| `src-tauri/resources/scripts/grb` | New file |
| `src-tauri/resources/commands/ship.md` | Rewrite (no commit, guards, sync-first, review verdict paths) |
| `src-tauri/resources/commands/review-pr.md` | Update post-review behavior (auto-push vs stage-only) |
| `src-tauri/src/ship_ops.rs` | Add script installation in `ensure_default_commands()` |
| `src/components/GitActions.tsx` | Remove all action buttons, keep status bars only |
| `src/stores/workspaceStore.ts` | Remove dead store actions for removed buttons |
| `src/lib/tauri.ts` | Remove dead API wrappers (optional cleanup) |
| `~/.zshrc` | Remove gsync/grb/gpr, add PATH |
