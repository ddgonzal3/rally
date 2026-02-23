# Unified Git Panel Design

**Date**: 2026-02-23
**Status**: Approved

## Problem

Git functionality is scattered across 4+ UI surfaces:
- GitActions bar (read-only status)
- GitDiffOverlay (staging/committing)
- PrReviewOverlay (PR details/merge)
- CommitModal (commit message + next-step)
- 4 sidebar icons (status, merge, PR, create PR)

This creates cognitive overhead — users must open different panels for related tasks.

## Solution

Replace all git-related icons and overlays with a **single sidebar icon** that opens a **unified git panel** with three tabs: Overview, Changes, and Pull Request.

## Entry Point

One sidebar icon replaces the 4 current git icons. The icon shows badge indicators for:
- Dirty state (local changes exist)
- Active PR on current branch
- Branch behind main

Clicking opens a full-content-area overlay (same pattern as current GitDiffOverlay).

## Tab Structure

```
[ Overview ]  [ Changes (3) ]  [ Pull Request #42 ]
```

- **Changes tab** shows file count badge
- **PR tab** shows PR number, or "No PR" when none exists
- **PR tab disabled state**: Visible but grayed when no PR. Shows empty state with "Create PR" button.
- **Default tab**: Always opens to Overview

## Overview Tab (Dashboard)

### Status Bar
- Branch name
- Ahead/behind badges (↑N ↓N)
- Changed files count
- PR status badges (if PR exists): mergeable, review decision, checks

### Quick Actions Row
- **Push** — push current branch (disabled if nothing to push)
- **Create PR** — create PR (hidden if PR already exists)
- **Ship** — launch `/ship` workflow
- **Fetch** — fetch from remote
- **Rebase** — rebase on main

Neutral-styled buttons matching existing UI patterns.

### Branch Commits
- Header: "Branch Commits" with count ("3 commits ahead of main")
- List of commits on this branch not on main
- Each row: short hash, message (truncated), relative time
- Empty state: "No commits ahead of main"
- Read-only for v1 (no click-to-diff yet)

## Changes Tab

Relocated content from GitDiffOverlay:

- **Sub-tabs**: Unstaged | Staged
- **File list** with expandable per-file diffs
- **Per-file actions**: Stage, Unstage, Discard
- **Per-hunk actions**: Revert individual hunks
- **Diff stats**: Total additions/deletions at top
- **Commit button** → commit flow with:
  - Commit message textarea
  - Next-step options:
    - "Commit only"
    - "Commit & Push"
    - "Commit & Create PR" — **hidden/disabled if PR already exists**
    - "Commit, Push & Ship"

## Pull Request Tab

Relocated content from PrReviewOverlay:

- **PR header**: Editable title, PR number, author, created date
- **Status badges**: Mergeable, review decision, checks
- **Sub-tabs**: Changes | Conversation | Commits
  - **Changes**: PR diff files (read-only, expandable)
  - **Conversation**: PR body, comments, reviews in timeline
  - **Commits**: List of commits in PR
- **Merge button**: Two-click confirm, squash merge
- **Refresh button**: Re-fetch PR details
- **GitHub link**: Clickable PR URL
- **Empty state** (no PR): "No pull request on this branch" + "Create PR" button

## What Gets Removed

| Component | Fate |
|-----------|------|
| GitActions bar (sidebar) | Removed — status info moves to Overview tab |
| GitDiffOverlay | Removed — content moves to Changes tab |
| PrReviewOverlay | Removed — content moves to PR tab |
| CommitModal | Removed — integrated into Changes tab commit flow |
| 4 sidebar icons | Replaced by 1 unified git icon |

## What Stays

| Component | Reason |
|-----------|--------|
| DiffView pane | Different use case (deep single-file Monaco editing) — opened from Changes tab |
| ShipStatusPill | Independent floating indicator — works regardless of panel state |

## Data Flow

No new Tauri commands needed. The unified panel consumes the same data sources:
- `gitStatuses[path]` — branch, dirty, ahead/behind, modified/untracked files
- `prStatuses[path]` — PR number, title, state, mergeable, review decision, checks
- Same API calls: `api.gitDiff`, `api.gitChanges`, `api.gitPrDetails`, `api.gitPrDiff`, etc.

## Commit Flow Change

When a PR already exists on the current branch:
- "Commit & Create PR" option is hidden/disabled in the commit flow
- "Commit, Push & Ship" remains available (ship handles existing PRs)
