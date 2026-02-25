# Git Power Workflow — Phase Tracker

## Phase 1: Smart Push + PR Status + Merge Button **[DONE]**

- [x] **1A** Smart push with force-with-lease fallback
- [x] **1B** PR status polling via `gh pr view --json` (20s interval)
- [x] **1C** PR status in sidebar (color-coded badge) + GitActions bar (mergeable/review/checks)
- [x] **1D** Merge PR button (squash default, appears when PR is mergeable)
- [x] **1E** Fix ahead/behind to use configured `main_branch` instead of hardcoded `origin/main`

---

## Phase 2: Ship It Pipeline + Sync Indicators

- [ ] **2A** Ship It pipeline — one button that chains:
  1. Sync (rebase onto main)
  2. Push (smart, force-with-lease if needed)
  3. Create PR if none exists (`gh pr create --fill`)
  4. Automated Claude review (`claude -p` subprocess)
  5. If Claude made changes → commit + push
  6. Check for merge conflicts / checks
  7. Auto-approve (`gh pr review --approve`)
  8. Merge (`gh pr merge --squash --delete-branch`)
  9. Notify other copies "sync needed" (yellow dots)
  - Progress events via Tauri events for live UI feedback
  - Pipeline stops + reports on any failure

- [ ] **2B** Post-merge sync indicators
  - Yellow dot on all workspaces sharing same `repo_url` after a merge
  - One-click Sync button per workspace
  - Smart sync: stash+rebase if dirty, rebase if clean, checkout main if branch was merged

- [ ] **2C** Keyboard shortcuts
  - `Cmd+Shift+S` → Sync
  - `Cmd+Shift+P` → Smart Push
  - `Cmd+Shift+M` → Merge PR
  - `Cmd+Shift+A` → Sync All
  - `Cmd+Shift+Enter` → Ship It
  - New `src/hooks/useGitShortcuts.ts`, wired into `App.tsx`

---

## Phase 3: Workspace Grouping + Sync All

- [ ] **3A** Group model — `group_id` field on Workspace, migration for existing workspaces
- [ ] **3B** Sidebar grouping — workspaces with same `group_id` shown under a collapsible repo header
- [ ] **3C** Add Copy flow — point to existing clone or create new clone, assigns `group_id`
- [ ] **3D** Sync All — button in group header, syncs all copies in parallel
