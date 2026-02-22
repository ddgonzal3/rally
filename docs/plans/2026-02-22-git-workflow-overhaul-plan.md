# Git Workflow Overhaul Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Rally's button-driven git UI with terminal-first shell scripts and Claude Code slash commands, keeping Rally as a viewer (diffs, staging, status).

**Architecture:** Shell scripts in `src-tauri/resources/scripts/` are embedded in the Rally binary and installed to `~/.rally/bin/` on startup. Ship/review slash commands are rewritten to use the new scripts. Rally UI strips all git action buttons, keeping only status display and file staging.

**Tech Stack:** Bash scripts, Rust (Tauri commands, `include_str!()`), React/TypeScript (UI cleanup), Claude Code slash commands (Markdown)

**Design doc:** `docs/plans/2026-02-22-git-workflow-overhaul-design.md`

---

## Task 1: Create shell scripts

**Files:**
- Create: `src-tauri/resources/scripts/gship`
- Create: `src-tauri/resources/scripts/gpr`
- Create: `src-tauri/resources/scripts/gmerge`
- Create: `src-tauri/resources/scripts/gfinish`
- Create: `src-tauri/resources/scripts/gsync`
- Create: `src-tauri/resources/scripts/grb`

**Step 1: Create the scripts directory**

```bash
mkdir -p src-tauri/resources/scripts
```

**Step 2: Create `gship`**

Create `src-tauri/resources/scripts/gship`:

```bash
#!/bin/bash
# gship — Launch Claude Code to run /ship
# Installed to ~/.rally/bin/ by Rally on startup

branch=$(git symbolic-ref --short HEAD 2>/dev/null)
if [ -z "$branch" ]; then echo "Not in a git repo"; exit 1; fi
if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
  echo "Cannot ship from $branch. Switch to a feature branch first."
  exit 1
fi

main_branch="main"
ahead=$(git rev-list --count "$main_branch".."$branch" 2>/dev/null)
if [ "$ahead" = "0" ] || [ -z "$ahead" ]; then
  echo "No commits ahead of $main_branch. Nothing to ship."
  exit 1
fi

echo "Shipping $branch ($ahead commit(s) ahead of $main_branch)..."
claude --dangerously-skip-permissions -p "/ship"
```

**Step 3: Create `gpr`**

Create `src-tauri/resources/scripts/gpr`:

```bash
#!/bin/bash
# gpr — Push and create PR into main
# Installed to ~/.rally/bin/ by Rally on startup

branch=$(git symbolic-ref --short HEAD 2>/dev/null)
if [ -z "$branch" ]; then echo "Not in a git repo"; exit 1; fi
if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
  echo "Cannot create PR from $branch. Switch to a feature branch first."
  exit 1
fi

echo "Pushing $branch..."
git push 2>/dev/null || git push --set-upstream origin "$branch"

echo "Creating PR..."
gh pr create --fill
```

**Step 4: Create `gmerge`**

Create `src-tauri/resources/scripts/gmerge`:

```bash
#!/bin/bash
# gmerge — Squash merge PR + sync local branch with main
# Installed to ~/.rally/bin/ by Rally on startup

branch=$(git symbolic-ref --short HEAD 2>/dev/null)
main_branch="main"

if [ -z "$branch" ]; then echo "Not in a git repo"; exit 1; fi
if [ "$branch" = "$main_branch" ] || [ "$branch" = "master" ]; then
  echo "Cannot merge from $main_branch. Switch to a feature branch."
  exit 1
fi

# Ensure local is up to date with remote
echo "Fetching remote..."
git fetch origin

remote_head=$(git rev-parse "origin/$branch" 2>/dev/null)

if [ -n "$remote_head" ]; then
  local_head=$(git rev-parse HEAD)
  if [ "$local_head" != "$remote_head" ]; then
    remote_count=$(git rev-list --count "$branch".."origin/$branch" 2>/dev/null || echo "0")
    if [ "$remote_count" -gt 0 ]; then
      echo "Local branch is behind remote by $remote_count commit(s). Pull first:"
      echo "  git pull --rebase"
      exit 1
    fi
  fi
fi

# Check PR exists and is mergeable
pr_json=$(gh pr view --json state,mergeable 2>/dev/null)
if [ -z "$pr_json" ]; then
  echo "No PR found for branch $branch."
  exit 1
fi

state=$(echo "$pr_json" | grep -o '"state":"[^"]*"' | cut -d'"' -f4)
mergeable=$(echo "$pr_json" | grep -o '"mergeable":"[^"]*"' | cut -d'"' -f4)

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
echo "Syncing $branch with $main_branch..."
git checkout "$main_branch"
git pull

git checkout "$branch"
ahead=$(git rev-list --count "$main_branch".."$branch" 2>/dev/null || echo "0")
if [ "$ahead" -gt 0 ]; then
  git reset --hard "HEAD~$ahead"
  git rebase "$main_branch"
fi

git push --force-with-lease

echo "Merged and synced. $branch is now up to date with $main_branch."
```

**Step 5: Create `gfinish`**

Create `src-tauri/resources/scripts/gfinish`:

```bash
#!/bin/bash
# gfinish — Commit + push + merge (after manual review)
# Installed to ~/.rally/bin/ by Rally on startup

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

**Step 6: Create `gsync`**

Create `src-tauri/resources/scripts/gsync`:

```bash
#!/bin/bash
# gsync — Hard reset + rebase onto main (nuke & sync)
# Installed to ~/.rally/bin/ by Rally on startup

branch=$(git symbolic-ref --short HEAD 2>/dev/null)
main_branch="main"

if [ -z "$branch" ]; then echo "Not in a git repo"; exit 1; fi
if [ "$branch" = "$main_branch" ]; then echo "Already on $main_branch"; exit 1; fi

ahead=$(git rev-list --count "$main_branch".."$branch" 2>/dev/null || echo "0")
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

**Step 7: Create `grb`**

Create `src-tauri/resources/scripts/grb`:

```bash
#!/bin/bash
# grb — Safe rebase onto main with stash/pop
# Installed to ~/.rally/bin/ by Rally on startup

branch=$(git symbolic-ref --short HEAD 2>/dev/null)
main_branch="main"

if [ -z "$branch" ]; then echo "Not in a git repo"; exit 1; fi
if [ "$branch" = "$main_branch" ]; then echo "Already on $main_branch"; exit 1; fi

echo "Rebasing $branch onto $main_branch..."

git checkout "$branch" || { echo "Failed to checkout $branch"; exit 1; }

# Stash if dirty
stash_count=$(git stash list | wc -l | tr -d ' ')
git stash
new_stash_count=$(git stash list | wc -l | tr -d ' ')
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
  git stash pop || echo "Stash pop had conflicts — resolve manually"
fi

echo "$branch rebased onto $main_branch."
```

---

## Task 2: Add script installation to Rust backend

**Files:**
- Modify: `src-tauri/src/ship_ops.rs`

**Step 1: Add script constants**

At the top of `ship_ops.rs`, after the existing `include_str!()` constants (around line 9), add constants for each script:

```rust
const GSHIP_SCRIPT: &str = include_str!("../resources/scripts/gship");
const GPR_SCRIPT: &str = include_str!("../resources/scripts/gpr");
const GMERGE_SCRIPT: &str = include_str!("../resources/scripts/gmerge");
const GFINISH_SCRIPT: &str = include_str!("../resources/scripts/gfinish");
const GSYNC_SCRIPT: &str = include_str!("../resources/scripts/gsync");
const GRB_SCRIPT: &str = include_str!("../resources/scripts/grb");
```

**Step 2: Add `install_script()` helper function**

Add this function after the existing `install_ship_script()` function (around line 157):

```rust
/// Install a script to ~/.rally/bin/ if it doesn't already exist.
/// Uses install-once strategy: never overwrites existing scripts.
fn install_script(bin_dir: &PathBuf, name: &str, content: &str) -> Result<(), String> {
    let script_path = bin_dir.join(name);
    if script_path.exists() {
        return Ok(()); // User may have customized — don't overwrite
    }
    fs::write(&script_path, content)
        .map_err(|e| format!("Failed to write {}: {}", name, e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o755);
        fs::set_permissions(&script_path, perms)
            .map_err(|e| format!("Failed to chmod {}: {}", name, e))?;
    }
    Ok(())
}
```

**Step 3: Add script installation to `ensure_default_commands()`**

In the `ensure_default_commands()` function (around line 101-126), after the existing symlink code and before the `install_ship_script()` call, add:

```rust
// Install CLI scripts to ~/.rally/bin/
let bin_dir = PathBuf::from(&home).join(".rally").join("bin");
fs::create_dir_all(&bin_dir)
    .map_err(|e| format!("Failed to create ~/.rally/bin: {}", e))?;

for (name, content) in &[
    ("gship", GSHIP_SCRIPT),
    ("gpr", GPR_SCRIPT),
    ("gmerge", GMERGE_SCRIPT),
    ("gfinish", GFINISH_SCRIPT),
    ("gsync", GSYNC_SCRIPT),
    ("grb", GRB_SCRIPT),
] {
    install_script(&bin_dir, name, content)?;
}
```

**Step 4: Remove old `install_ship_script()` call**

The old `install_ship_script()` function at the end of `ensure_default_commands()` installs a different `ship` trigger script. This can stay — it's a separate thing (the `ship` command that writes trigger files for Rally). But verify it doesn't conflict with `gship`. They have different names (`ship` vs `gship`) so they coexist fine.

**Step 5: Verify the build compiles**

Run: `cd /Users/splice/splice/rally && ./scripts/check.sh`

Expected: No Rust compilation errors. The new `include_str!()` paths must match the files created in Task 1.

---

## Task 3: Rewrite ship.md

**Files:**
- Modify: `src-tauri/resources/commands/ship.md`

**Step 1: Rewrite ship.md**

Replace the entire contents of `src-tauri/resources/commands/ship.md` with the new version. Key differences from the current v7:

1. **Version bump:** `<!-- rally-ship-v8 -->`
2. **No committing:** If dirty, abort with "Commit your changes first."
3. **Guards:** Must be on feature branch. Must have commits ahead of main.
4. **Sync first:** Rebase onto main before pushing.
5. **Review verdict — low-risk:** Commit review fixes, push, run `gmerge` to auto-merge and sync.
6. **Review verdict — flagged:** Stage changes only. Tell user to run `gfinish`.
7. **Signal phases updated:** Remove `committing` phase. Add `syncing` phase. Phases are now: `detecting`, `syncing`, `pushing`, `creating_pr`, `checking`, `reviewing`, `writing_verdict`, `merging`, `complete`.

The full rewritten file:

```markdown
<!-- rally-ship-v8 -->
# Ship: Sync, Push, PR, Review, Merge

You are automating the ship lifecycle for the current branch. Follow each step exactly. This command does NOT commit — the user must have already committed their work.

## Progress Tracking via Signal File

Rally tracks ship progress by reading the signal file. Before starting each major step, update the signal file with the current phase.

**First, run this setup once at the very beginning:**

\```bash
REPO_PATH=$(git rev-parse --show-toplevel)
SANITIZED=$(echo "$REPO_PATH" | sed 's|^/||; s|/|--|g')
SIGNAL_DIR="$HOME/.rally/ship-signals"
mkdir -p "$SIGNAL_DIR"
SIGNAL_FILE="$SIGNAL_DIR/$SANITIZED.json"
SHIP_BRANCH=$(git symbolic-ref --short HEAD)
SHIP_PR_NUM=0
SHIP_PR_URL=""
\```

**Then, before each step, write the phase signal.** Use this exact pattern (replacing `PHASE_NAME` with the phase):

\```bash
cat > "$SIGNAL_FILE" << SIGNAL_EOF
{
  "version": 1,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "repo_path": "$REPO_PATH",
  "branch": "$SHIP_BRANCH",
  "verdict": "shipping",
  "phase": "PHASE_NAME",
  "pr_number": $SHIP_PR_NUM,
  "pr_url": "$SHIP_PR_URL",
  "summary": "",
  "flagged_items": []
}
SIGNAL_EOF
\```

Phases: `detecting`, `syncing`, `pushing`, `creating_pr`, `checking`, `reviewing`, `writing_verdict`, `merging`, `complete`.

**Important:** After Step 3 discovers the PR number and URL, update `SHIP_PR_NUM` and `SHIP_PR_URL` so subsequent phase signals include them.

## Step 1: Detect & Guard

Write the phase signal with `"phase": "detecting"`, then:

\```bash
BRANCH=$(git symbolic-ref --short HEAD)
MAIN_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
[ -z "$MAIN_BRANCH" ] && MAIN_BRANCH="main"
IS_DIRTY=$([ -n "$(git status --porcelain)" ] && echo "true" || echo "false")
AHEAD=$(git rev-list --count "$MAIN_BRANCH".."$BRANCH" 2>/dev/null || echo "0")
echo "BRANCH=$BRANCH MAIN=$MAIN_BRANCH DIRTY=$IS_DIRTY AHEAD=$AHEAD"
SHIP_BRANCH="$BRANCH"
\```

**Guard rails — STOP if any of these fail:**
- If `BRANCH` equals `MAIN_BRANCH`: "Cannot ship from main. Switch to a feature branch first."
- If `IS_DIRTY=true`: "Working tree is dirty. Commit your changes first, then run /ship again."
- If `AHEAD=0`: "No commits ahead of $MAIN_BRANCH. Nothing to ship."

## Step 2: Sync Branch

Write the phase signal with `"phase": "syncing"`, then rebase onto main:

\```bash
git checkout "$MAIN_BRANCH"
git pull
git rebase "$MAIN_BRANCH" "$BRANCH"
\```

If the rebase fails due to conflicts:
- Write signal with `verdict: "manual_review"` and summary explaining the conflict.
- Tell the user: "Rebase onto $MAIN_BRANCH has conflicts. Resolve them, then run /ship again."
- STOP.

## Step 3: Push & Create PR

Write the phase signal with `"phase": "pushing"`, then:

\```bash
git push 2>/dev/null || git push --set-upstream origin "$BRANCH"
\```

If push is rejected (diverged), use `git push --force-with-lease`.

Write the phase signal with `"phase": "creating_pr"`, then:

\```bash
PR_NUM=$(gh pr view --json number,state -q 'select(.state=="OPEN") | .number' 2>/dev/null)
if [ -z "$PR_NUM" ]; then
  gh pr create --fill
  PR_NUM=$(gh pr view --json number -q '.number')
fi
PR_URL=$(gh pr view "$PR_NUM" --json url -q '.url')
echo "PR_NUMBER=$PR_NUM PR_URL=$PR_URL"
SHIP_PR_NUM=$PR_NUM
SHIP_PR_URL="$PR_URL"
\```

## Step 4: Check Conflicts

Write the phase signal with `"phase": "checking"`, then:

\```bash
MERGEABLE=$(gh pr view "$PR_NUM" --json mergeable -q '.mergeable')
echo "MERGEABLE=$MERGEABLE"
\```

If `MERGEABLE=CONFLICTING`:
- Write signal with `verdict: "manual_review"` and summary explaining the conflict.
- STOP.

**Sanity check:** Run `gh pr diff "$PR_NUM" --stat`. If the PR contains only trivial/empty changes, write signal with `verdict: "manual_review"` and summary explaining why. STOP.

## Step 5: Review

Write the phase signal with `"phase": "reviewing"`, then:

Read `~/.rally/commands/review-pr.md` and follow its full review process for the current branch.

**After the review completes, determine the verdict based on findings.**

## Step 6: Apply Verdict

### If low-risk (no flagged items requiring user attention):

1. If the review made any changes:
   \```bash
   git add -u
   git commit -m "Review fixes"
   git push
   \```

2. Write the phase signal with `"phase": "merging"`, then auto-merge and sync:
   \```bash
   gmerge
   \```

3. Write the final signal file with `verdict: "auto_merge"`, `phase: "complete"`, and a summary.

4. Print summary: what was reviewed, what was fixed, PR merged and branch synced.

### If flagged (issues requiring user attention):

1. Stage the review changes (do NOT commit or push):
   \```bash
   git add -u
   \```

2. Write the final signal file with `verdict: "manual_review"`, `phase: "complete"`, summary, and flagged_items.

3. Print the review report with flagged items. Then:
   "Changes staged. Review them, then run `gfinish \"your message\"` when ready."

## Final Signal File Format

\```bash
cat > "$SIGNAL_FILE" << 'SIGNAL_EOF'
{
  "version": 1,
  "timestamp": "<ISO 8601>",
  "repo_path": "<repo path>",
  "branch": "<branch>",
  "verdict": "<auto_merge or manual_review>",
  "phase": "complete",
  "pr_number": <number>,
  "pr_url": "<url>",
  "summary": "<one paragraph>",
  "flagged_items": []
}
SIGNAL_EOF
\```

For flagged_items:
\```json
{ "file": "src/foo.ts", "line": 42, "severity": "suggestion", "description": "Consider extracting..." }
\```
```

**Step 2: Update the version constant in `ship_ops.rs`**

In `src-tauri/src/ship_ops.rs`, change line 8:

```rust
// Old:
const SHIP_COMMAND_VERSION: &str = "<!-- rally-ship-v7 -->";
// New:
const SHIP_COMMAND_VERSION: &str = "<!-- rally-ship-v8 -->";
```

This ensures Rally auto-updates the installed ship.md to v8 on next launch.

---

## Task 4: Update review-pr.md

**Files:**
- Modify: `src-tauri/resources/commands/review-pr.md`

**Step 1: Update Step 5 (Stage Changes)**

Replace the current Step 5 in `review-pr.md` (around line 206-212) which says "DO NOT COMMIT" with two paths:

Replace:
```markdown
## Step 5: Stage Changes (Main Agent)

\```bash
git add -u  # or specific files
\```

**DO NOT COMMIT.** The user will commit when ready.
```

With:
```markdown
## Step 5: Stage or Push Changes (Main Agent)

Behavior depends on context:

### When called from /ship (default):
The /ship command handles committing and pushing after review. Just stage:
\```bash
git add -u
\```

### When called standalone (/review-pr):
Stage changes only. The user decides what to do next:
\```bash
git add -u
\```
Print: "Changes staged. Review them, then commit and push when ready."
```

**Step 2: Update the version marker**

Change line 1 from `<!-- rally-review-pr-v2 -->` to `<!-- rally-review-pr-v3 -->`.

**Step 3: Update the version constant in `ship_ops.rs`**

In `src-tauri/src/ship_ops.rs`, change:
```rust
const REVIEW_COMMAND_VERSION: &str = "<!-- rally-review-pr-v3 -->";
```

---

## Task 5: Strip GitActions buttons from Rally UI

**Files:**
- Modify: `src/components/GitActions.tsx`
- Modify: `src/stores/workspaceStore.ts`

**Step 1: Simplify GitActions.tsx**

Remove from the component:
- All store action selectors: `syncPath`, `syncAndPushPath`, `rebasePath`, `commitPath`, `pushPath`, `createPrForPath`, `mergePrForPath` (lines 81-87)
- The `running`, `error`, `commitMsg`, `showCommitInput` state (lines 91-94)
- The `runAction` helper (lines 101-111)
- The `canMerge` computed value (line 113)
- All buttons in the `actions` div (lines 134-215): Refresh, Sync, Rebase, Commit, Push, PR, Merge
- The commit input row (lines 217-235)
- The error bar (lines 237-243)
- Related styles: `actions`, `btn`, `btnActive`, `btnMerge`, `btnSyncNeeded`, `syncDot`, `btnIcon`, `commitRow`, `commitInput`, `errorBar`, `errorDismiss`

Keep:
- The `PrStatusBar` sub-component (lines 12-54) — unchanged
- Status bar showing branch + dirty count + ahead/behind (lines 117-130)
- PR status bar (line 132)
- Selectors needed for status display: `activeWorkspaceId`, `ws`, `activePath`, `status`, `pr`, `needsSync` (for status display only, needsSync drives the status dot in sidebar — keep it)
- The `refreshGitStatusForPath` and `refreshPrStatusForPath` selectors — still needed by polling

The resulting component is just a status display:
```tsx
export function GitActions() {
  const ws = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId)
  );
  const activePath = useWorkspaceStore((s) => {
    const wsId = s.activeWorkspaceId;
    return wsId ? s.getActivePath(wsId) : null;
  });
  const status = useWorkspaceStore((s) => {
    const wsId = s.activeWorkspaceId;
    const path = wsId ? s.getActivePath(wsId) : null;
    return path ? s.gitStatuses[path] : null;
  });
  const pr = useWorkspaceStore((s) => {
    const wsId = s.activeWorkspaceId;
    const path = wsId ? s.getActivePath(wsId) : null;
    return path ? s.prStatuses[path] : null;
  });

  const branch = status?.branch ?? ws?.branch ?? "";

  if (!ws || !activePath) return null;

  return (
    <div style={styles.container}>
      <div style={styles.statusBar}>
        <span style={styles.branch}>{branch}</span>
        {status && (
          <>
            {status.dirty && (
              <span style={styles.tag}>
                {status.modified_files.length + status.untracked_files.length} changed
              </span>
            )}
            {status.ahead > 0 && <span style={styles.tag}>↑{status.ahead}</span>}
            {status.behind > 0 && <span style={styles.tag}>↓{status.behind}</span>}
          </>
        )}
      </div>
      <PrStatusBar pr={pr} />
    </div>
  );
}
```

**Step 2: Remove dead store actions from workspaceStore.ts**

Remove these action declarations from the store type (around lines 170-177):
- `syncPath`
- `syncAndPushPath`
- `rebasePath`
- `commitPath`
- `pushPath`
- `createPrForPath`
- `mergePrForPath`

Remove their implementations (around lines 637-697):
- `syncPath` (lines 637-641)
- `syncAndPushPath` (lines 643-650)
- `rebasePath` (lines 652-656)
- `commitPath` (lines 658-664)
- `pushPath` (lines 666-671)
- `createPrForPath` (lines 673-677)
- `mergePrForPath` (lines 679-697)

Keep `refreshGitStatusForPath`, `refreshPrStatusForPath` — still used by polling.

**Step 3: Remove dead Tauri API wrappers from `src/lib/tauri.ts`**

Remove wrappers that are no longer called from frontend:
- `gitSync`
- `gitRebase`
- `gitCommit`
- `gitPush`
- `gitCreatePr`
- `gitMergePr`
- `gitCreatePrSmart`
- `gitMergePrSmart`

Keep:
- `gitStatus` — used by polling
- `gitPrStatus` — used by polling
- `gitChanges` — used by FileExplorer
- `gitFileAtHead` — used by diff viewer
- `gitStageFile`, `gitUnstageFile`, `gitDiscardFile` — used by FileExplorer
- `checkShipSignal`, `clearShipSignal`, `checkShipTrigger` — used by ship signal polling
- `postMergeSync` — used by `handleAutoMerge`

**Step 4: Remove unused imports from GitActions.tsx**

Remove the `invoke` import (line 2) if no longer used. Remove the `useState` import if all state is removed.

**Step 5: Verify the build compiles**

Run: `cd /Users/splice/splice/rally && ./scripts/check.sh`

Expected: No TypeScript or Rust errors.

---

## Task 6: Clean up Rust command registrations

**Files:**
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/commands.rs`

**Step 1: Remove unused Tauri command registrations from `main.rs`**

In `main.rs` `generate_handler![]` (lines 130-174), remove:
- `commands::git_sync`
- `commands::git_rebase`
- `commands::git_commit`
- `commands::git_push`
- `commands::git_create_pr`
- `commands::git_merge_pr`
- `commands::git_create_pr_smart`
- `commands::git_merge_pr_smart`

Keep:
- `commands::git_status` — used by polling
- `commands::git_pr_status` — used by polling
- `commands::git_changes` — used by FileExplorer
- `commands::git_file_at_head` — used by diff viewer
- `commands::git_stage_file`, `git_unstage_file`, `git_discard_file` — used by FileExplorer

**Step 2: Remove the `#[tauri::command]` functions from `commands.rs`**

Remove the Tauri command wrapper functions for:
- `git_sync`
- `git_rebase`
- `git_commit`
- `git_push`
- `git_create_pr`
- `git_merge_pr`
- `git_create_pr_smart`
- `git_merge_pr_smart`

The underlying `git_ops` functions stay (they're used by `post_merge_sync` and `merge_pr_smart` internally).

**Step 3: Remove unused permission grants from `capabilities/default.json`**

Check `src-tauri/capabilities/default.json` for any permissions specific to the removed commands. Tauri v2 capabilities may reference specific command names.

**Step 4: Verify the build compiles**

Run: `cd /Users/splice/splice/rally && ./scripts/check.sh`

Expected: Clean build.

---

## Task 7: Update zshrc

**Files:**
- Modify: `~/.zshrc`

**Step 1: Remove old functions and alias**

Remove the `gsync()` function (lines 36-58 of `~/.zshrc`).
Remove the `grb()` function (lines 60-101).
Remove `alias gpr="gp && gh pr create --fill"` (line 29).

**Step 2: Add `~/.rally/bin` to PATH**

Add this line near the top of `~/.zshrc`, after the brew shellenv line (around line 12):

```bash
# Rally CLI scripts
export PATH="$HOME/.rally/bin:$PATH"
```

---

## Task 8: Build, install, and verify

**Step 1: Build Rally**

Run: `cd /Users/splice/splice/rally && ./scripts/run.sh`

This builds and launches Rally, which triggers `ensure_default_commands()` on startup, installing the new scripts to `~/.rally/bin/`.

**Step 2: Verify scripts are installed**

```bash
ls -la ~/.rally/bin/
```

Expected: `gship`, `gpr`, `gmerge`, `gfinish`, `gsync`, `grb` all present with execute permissions.

**Step 3: Verify ship.md is updated**

```bash
head -1 ~/.rally/commands/ship.md
```

Expected: `<!-- rally-ship-v8 -->`

**Step 4: Source zshrc and verify PATH**

```bash
source ~/.zshrc
which gship gpr gmerge gfinish gsync grb
```

Expected: All resolve to `~/.rally/bin/<name>`.

**Step 5: Verify no alias conflicts**

```bash
type gpr
```

Expected: Shows the script path, not a shell alias.

**Step 6: Smoke test gmerge guards**

```bash
cd /tmp && git init test-repo && cd test-repo
git checkout -b main && git commit --allow-empty -m "init"
gmerge
```

Expected: Error message about not being on a feature branch.

**Step 7: Verify Rally UI**

Open Rally. Confirm:
- GitActions shows branch name, ahead/behind, PR status only
- No Sync/Rebase/Commit/Push/PR/Merge buttons
- FileExplorer still has Stage/Unstage/Discard
- ShipStatusPill still appears when ship signals exist
