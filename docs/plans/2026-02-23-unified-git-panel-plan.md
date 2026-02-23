# Unified Git Panel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace scattered git UI (GitDiffOverlay, PrReviewOverlay, CommitModal, FileExplorer git icons) with a single unified git panel opened from one activity bar icon.

**Architecture:** A new `UnifiedGitPanel` component renders as a full-content-area overlay (same pattern as current `GitDiffOverlay`). It has 3 tabs: Overview, Changes, Pull Request. The Changes tab reuses `GitDiffOverlay`'s internal logic (lifted into the tab). The PR tab reuses `PrReviewOverlay`'s logic (lifted into the tab). The `CommitModal` is inlined into the Changes tab with PR-existence awareness. A new activity bar icon replaces the per-repo git icons in the FileExplorer.

**Tech Stack:** React 19, Zustand 5, Tauri v2 IPC, existing `api.*` wrappers in `src/lib/tauri.ts`

---

## Task 1: Create the UnifiedGitPanel shell with tab navigation

**Files:**
- Create: `src/components/UnifiedGitPanel.tsx`
- Modify: `src/App.tsx:580-665` (add activity bar icon + mount overlay)
- Modify: `src/stores/workspaceStore.ts:139-167,248-256` (add unified panel state)

**Step 1: Add store state for unified git panel**

In `src/stores/workspaceStore.ts`, add to the `WorkspaceState` interface (after line 167):

```typescript
/** Unified git panel state */
unifiedGitPanelOpen: boolean;
unifiedGitPanelPath: string | null;
unifiedGitPanelTab: "overview" | "changes" | "pr";
openUnifiedGitPanel: (rootPath: string, tab?: "overview" | "changes" | "pr") => void;
closeUnifiedGitPanel: () => void;
setUnifiedGitPanelTab: (tab: "overview" | "changes" | "pr") => void;
```

Add initial state values in the store creation (near the existing `gitDiffOverlayOpen: false` initializers):

```typescript
unifiedGitPanelOpen: false,
unifiedGitPanelPath: null,
unifiedGitPanelTab: "overview",
```

Add action implementations (near the existing `openGitDiffOverlay` actions around line 1642):

```typescript
openUnifiedGitPanel: (rootPath, tab) => set({
  unifiedGitPanelOpen: true,
  unifiedGitPanelPath: rootPath,
  unifiedGitPanelTab: tab ?? "overview",
  // Close old overlays if open
  gitDiffOverlayOpen: false,
  prReviewOverlayOpen: false,
}),
closeUnifiedGitPanel: () => set({
  unifiedGitPanelOpen: false,
  unifiedGitPanelPath: null,
}),
setUnifiedGitPanelTab: (tab) => set({ unifiedGitPanelTab: tab }),
```

Also add to the `PersistedWorkspaceState` type (line 65):

```typescript
unifiedGitPanelOpen: boolean;
unifiedGitPanelPath: string | null;
unifiedGitPanelTab: "overview" | "changes" | "pr";
```

And include them in the persist config where the other git overlay state is persisted.

**Step 2: Create the UnifiedGitPanel component shell**

Create `src/components/UnifiedGitPanel.tsx`:

```tsx
import React, { useState, useEffect, useCallback, useRef } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { api } from "../lib/tauri";
import type { GitStatus, PrStatus } from "../lib/types";

export function UnifiedGitPanel() {
  const open = useWorkspaceStore((s) => s.unifiedGitPanelOpen);
  const rootPath = useWorkspaceStore((s) => s.unifiedGitPanelPath);
  const activeTab = useWorkspaceStore((s) => s.unifiedGitPanelTab);
  const setTab = useWorkspaceStore((s) => s.setUnifiedGitPanelTab);
  const close = useWorkspaceStore((s) => s.closeUnifiedGitPanel);
  const gitStatus = useWorkspaceStore((s) => rootPath ? s.gitStatuses[rootPath] : undefined);
  const prStatus = useWorkspaceStore((s) => rootPath ? s.prStatuses[rootPath] : undefined);

  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (open) requestAnimationFrame(() => setMounted(true));
    else setMounted(false);
  }, [open]);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { close(); }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, close]);

  if (!open || !rootPath) return null;

  const changeCount = (gitStatus?.modified_files.length ?? 0) + (gitStatus?.untracked_files.length ?? 0);
  const hasPr = prStatus && prStatus.state === "OPEN";

  const tabs = [
    { id: "overview" as const, label: "Overview" },
    { id: "changes" as const, label: `Changes${changeCount > 0 ? ` (${changeCount})` : ""}` },
    { id: "pr" as const, label: hasPr ? `Pull Request #${prStatus.number}` : "Pull Request" },
  ];

  return (
    <div className="git-diff-overlay" style={{
      ...styles.overlay,
      opacity: mounted ? 1 : 0,
      transform: mounted ? "translateY(0)" : "translateY(8px)",
    }}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.tabRow}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setTab(tab.id)}
              style={{
                ...styles.tab,
                ...(activeTab === tab.id ? styles.tabActive : {}),
                ...(tab.id === "pr" && !hasPr ? styles.tabDisabled : {}),
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <button onClick={close} style={styles.closeBtn}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M5 5l8 8M13 5l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      {/* Tab content */}
      <div style={styles.content}>
        {activeTab === "overview" && (
          <OverviewTab rootPath={rootPath} gitStatus={gitStatus} prStatus={prStatus} />
        )}
        {activeTab === "changes" && (
          <div style={{ padding: 40, color: "#888" }}>Changes tab — coming in Task 3</div>
        )}
        {activeTab === "pr" && (
          <div style={{ padding: 40, color: "#888" }}>PR tab — coming in Task 4</div>
        )}
      </div>
    </div>
  );
}

// Placeholder — will be expanded in Task 2
function OverviewTab({ rootPath, gitStatus, prStatus }: {
  rootPath: string;
  gitStatus?: GitStatus;
  prStatus?: PrStatus | null;
}) {
  return <div style={{ padding: 40, color: "#888" }}>Overview tab — coming in Task 2</div>;
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "absolute",
    inset: 0,
    background: "#1e1e1e",
    zIndex: 10,
    display: "flex",
    flexDirection: "column",
    transition: "opacity 150ms ease, transform 150ms ease",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 16px",
    borderBottom: "1px solid #2a2a2a",
    minHeight: 44,
    flexShrink: 0,
  },
  tabRow: {
    display: "flex",
    gap: 0,
  },
  tab: {
    padding: "10px 16px",
    background: "none",
    border: "none",
    borderBottom: "2px solid transparent",
    color: "#888",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    transition: "color 150ms, border-color 150ms",
  },
  tabActive: {
    color: "#e0e0e0",
    borderBottomColor: "#e0e0e0",
  },
  tabDisabled: {
    opacity: 0.4,
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "#888",
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    borderRadius: 6,
  },
  content: {
    flex: 1,
    overflow: "auto",
    minHeight: 0,
  },
};
```

**Step 3: Add activity bar icon and mount the panel**

In `src/App.tsx`, add a git icon to the activity bar array (after the "scripts" entry, before the closing `] as const`). The icon should be a git branch icon matching the existing icon style (18x18, stroke-based, `#bbb`/`#ddd` colors).

Add a "git" view entry to the activity bar array. When clicked, instead of toggling a sidebar view, it calls `openUnifiedGitPanel(activePath)` where `activePath` is the first path of the active workspace.

Mount `<UnifiedGitPanel />` in the main content area alongside the existing overlays (line 662-663):

```tsx
<div style={styles.main}>
  <PaneLayout />
  <GitDiffOverlay />
  <PrReviewOverlayWrapper />
  <UnifiedGitPanel />
</div>
```

**Step 4: Verify the shell works**

Run: `./scripts/reload.sh`
Expected: New git icon in activity bar. Clicking it opens a panel with 3 tabs. Tabs switch. Escape closes. Placeholder content shows in each tab.

---

## Task 2: Build the Overview tab

**Files:**
- Modify: `src/components/UnifiedGitPanel.tsx` (replace OverviewTab placeholder)

**Step 1: Implement the OverviewTab component**

Replace the placeholder `OverviewTab` with the full implementation:

**Status section:**
- Branch name with git branch icon (reuse the existing SVG from FileExplorer's `GitStatusIcon`)
- Ahead/behind badges: `↑N` (green-ish) / `↓N` (amber-ish) using existing color patterns
- Changed files count
- PR status row (if PR exists): PR number as link, mergeable badge, review decision badge, checks badge — copy the badge rendering logic from `GitActions.tsx:PrStatusBar` (lines 5-48)

**Quick actions row:**
- Buttons: Push, Create PR (hidden if PR exists), Ship, Fetch, Rebase
- Each button: neutral style, icon + label, disabled state when not applicable
- Push: calls `api.gitPush(rootPath)`, disabled if `ahead === 0`
- Create PR: calls `api.gitCreatePr(rootPath)`, hidden if `prStatus?.state === "OPEN"`
- Ship: calls `startShipSession(rootPath)` from store
- Fetch: calls `api.gitFetch(rootPath)`
- Rebase: calls `rebaseOnMain(rootPath, mainBranch)` from store

**Branch commits section:**
- Header: "Branch Commits" with count
- Fetch commits using `api.gitCommitLog(rootPath, mainBranch)` on mount
- The existing `commit_log` Rust function already uses `origin/{main_branch}..HEAD` range, so it returns only branch-specific commits
- Each row: short SHA (first 7 chars, monospace, blue `#58a6ff`), message (truncated), relative time
- Empty state: "No commits ahead of main"

**Step 2: Wire up quick actions**

Each button needs:
- Loading state (spinner/opacity while running)
- Toast notification on success/failure (use existing `addToast`)
- Refresh git/PR status after action completes

Get `mainBranch` from the workspace store:
```typescript
const mainBranch = useWorkspaceStore((s) => {
  const ws = s.workspaces.find((w) => w.paths.includes(rootPath));
  return ws?.main_branch ?? "main";
});
```

**Step 3: Verify**

Run: `./scripts/reload.sh`
Expected: Overview tab shows branch name, ahead/behind, changed count, PR badges (if PR exists), quick action buttons, branch commit list.

---

## Task 3: Move GitDiffOverlay content into the Changes tab

**Files:**
- Modify: `src/components/UnifiedGitPanel.tsx` (add Changes tab)
- Modify: `src/components/GitDiffOverlay.tsx` (extract reusable inner content)

**Step 1: Extract GitDiffOverlay inner content**

The current `GitDiffOverlay` (649 lines) is a self-contained overlay with its own open/close state, escape handler, and overlay wrapper. We need to extract the inner content (the diff file list, staging actions, commit button) into a reusable component.

Option A (recommended): Refactor `GitDiffOverlay` to export an inner `GitDiffContent` component that takes `rootPath` as a prop and handles all the diff logic, file listing, staging, and commit flow. The outer `GitDiffOverlay` component becomes a thin wrapper that provides the overlay chrome (background, positioning, escape handler) and renders `<GitDiffContent />`.

In `GitDiffOverlay.tsx`:
- Rename the main function body logic into `export function GitDiffContent({ rootPath }: { rootPath: string })` — this contains all the state (unstagedFiles, stagedFiles, activeTab, etc.), the `fetchDiffs` logic, the file sections, and the commit button.
- Keep `GitDiffOverlay` as a wrapper that reads `gitDiffOverlayOpen`/`gitDiffOverlayPath` from the store and renders `<GitDiffContent rootPath={rootPath} />` inside the overlay chrome.

**Step 2: Use GitDiffContent in the Changes tab**

In `UnifiedGitPanel.tsx`, replace the Changes tab placeholder:

```tsx
{activeTab === "changes" && (
  <GitDiffContent rootPath={rootPath} />
)}
```

Import `GitDiffContent` from `./GitDiffOverlay`.

**Step 3: Add PR-existence awareness to CommitModal**

In `CommitModal.tsx`, add a `hasPr` prop:

```typescript
interface CommitModalProps {
  // ... existing props
  hasPr?: boolean;  // NEW — hides "Commit & Create PR" when true
}
```

In the `radioOptions` array (line 146), conditionally filter out the `commit-pr` option:

```typescript
const radioOptions = [
  { value: "commit", /* ... */ },
  { value: "commit-push", /* ... */ },
  ...(!hasPr ? [{ value: "commit-pr", /* ... */ }] : []),
  { value: "commit-ship", /* ... */ },
];
```

Pass `hasPr` from `GitDiffContent` using the store's `prStatuses[rootPath]`:

```typescript
const prStatus = useWorkspaceStore((s) => s.prStatuses[rootPath]);
const hasPr = prStatus && prStatus.state === "OPEN";
// ... in JSX:
<CommitModal hasPr={!!hasPr} /* ...other props */ />
```

**Step 4: Verify**

Run: `./scripts/reload.sh`
Expected: Changes tab shows the full diff overlay content (staged/unstaged files, diffs, commit button). Commit modal hides "Create PR" option when a PR exists. The standalone GitDiffOverlay still works for backwards compatibility until we remove it.

---

## Task 4: Move PrReviewOverlay content into the PR tab

**Files:**
- Modify: `src/components/UnifiedGitPanel.tsx` (add PR tab)
- Modify: `src/components/PrReviewOverlay.tsx` (extract reusable inner content)

**Step 1: Extract PrReviewOverlay inner content**

Same pattern as Task 3. The current `PrReviewOverlay` (1028 lines) is a self-contained overlay.

Refactor to export `PrReviewContent`:
- `export function PrReviewContent({ rootPath, onClose }: { rootPath: string; onClose: () => void })` — contains all the PR detail fetching, tab switching (Changes/Conversation/Commits), merge logic, title editing.
- `PrReviewOverlay` becomes a thin wrapper.

The `PrReviewContent` should also accept an optional `scrollToFile` prop for the file-scroll functionality.

**Step 2: Use PrReviewContent in the PR tab**

In `UnifiedGitPanel.tsx`, replace the PR tab placeholder:

```tsx
{activeTab === "pr" && (
  hasPr ? (
    <PrReviewContent rootPath={rootPath} onClose={close} />
  ) : (
    <PrEmptyState rootPath={rootPath} />
  )
)}
```

Create a simple `PrEmptyState` component inline:

```tsx
function PrEmptyState({ rootPath }: { rootPath: string }) {
  const [creating, setCreating] = useState(false);
  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const url = await api.gitCreatePr(rootPath);
      addToast({ type: "success", title: "PR Created", message: url });
      useWorkspaceStore.getState().refreshPrStatusForPath(rootPath);
    } catch (e) {
      addToast({ type: "warning", title: "Create PR failed", message: String(e instanceof Error ? e.message : e) });
    } finally {
      setCreating(false);
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 16, color: "#888" }}>
      <span style={{ fontSize: 14 }}>No pull request on this branch</span>
      <button onClick={handleCreate} disabled={creating} style={{ /* neutral button style */ }}>
        {creating ? "Creating..." : "Create Pull Request"}
      </button>
    </div>
  );
}
```

**Step 3: Verify**

Run: `./scripts/reload.sh`
Expected: PR tab shows full PR details when PR exists (changes, conversation, commits, merge button). Shows empty state with "Create PR" button when no PR. The standalone PrReviewOverlay still works.

---

## Task 5: Wire up FileExplorer icons to open the unified panel

**Files:**
- Modify: `src/components/FileExplorer.tsx:1029-1076` (redirect git icon clicks)
- Modify: `src/components/FileExplorer.tsx:1656-1667` (update store selectors)
- Modify: `src/components/FileExplorer.tsx:1798-1838` (update handlers)

**Step 1: Redirect GitStatusIcon click to unified panel**

In `FileExplorer.tsx`, the `RootSection` component (line 738) has `handleToggleChanges` (line 940) which calls `openGitDiffOverlay(rootPath)`. Change this to call `openUnifiedGitPanel(rootPath, "changes")`.

Similarly, the `PrBadge` click (line 1070) calls `openPrReviewOverlay(rootPath)`. Change to `openUnifiedGitPanel(rootPath, "pr")`.

The `handleCreatePr` (line 948) stays as-is — it creates a PR directly, which is fine.

**Step 2: Update FileExplorer selectors**

In the main `FileExplorer` component (line 1656), update the store selectors:
- Replace `openGitDiffOverlay` with `openUnifiedGitPanel`
- Replace `gitDiffOverlayOpen` / `gitDiffOverlayPath` with `unifiedGitPanelOpen` / `unifiedGitPanelPath`
- Replace `prReviewOverlayOpen` / `prReviewOverlayPath` with unified panel equivalents
- Update `handleSelectFile` (line 1819) to open unified panel's Changes tab
- Update `handleSelectPrFile` (line 1835) to open unified panel's PR tab

The `showChanges` and `showPrFiles` props on `RootSection` need to derive from the unified panel state:
- `showChanges` is true when `unifiedGitPanelOpen && unifiedGitPanelPath === p && unifiedGitPanelTab === "changes"`
- `showPrFiles` is true when `unifiedGitPanelOpen && unifiedGitPanelPath === p && unifiedGitPanelTab === "pr"`

**Step 3: Update handleGitIconClick**

The `handleGitIconClick` function (line 1798) currently toggles local `changesOpen` state AND opens the git diff overlay. Update it to open/toggle the unified panel instead:

```typescript
function handleGitIconClick(rootPath: string) {
  if (ws) {
    const idx = ws.paths.indexOf(rootPath);
    if (idx >= 0) setActivePathIndex(ws.id, idx);
  }
  const state = useWorkspaceStore.getState();
  if (state.unifiedGitPanelOpen && state.unifiedGitPanelPath === rootPath) {
    state.closeUnifiedGitPanel();
  } else {
    state.openUnifiedGitPanel(rootPath, "changes");
  }
}
```

**Step 4: Verify**

Run: `./scripts/reload.sh`
Expected: Clicking the git status icon in file explorer opens the unified panel's Changes tab. Clicking PR badge opens the PR tab. Inline changes/PR file panels in the file explorer still show correctly.

---

## Task 6: Add activity bar git icon

**Files:**
- Modify: `src/App.tsx:581-621` (add git icon to activity bar)

**Step 1: Add git icon button to activity bar**

The current activity bar has 3 sidebar view buttons + 1 file explorer toggle. Add a git button that works differently from the sidebar view buttons — it doesn't toggle a sidebar view, it opens the unified git panel overlay.

Add the button after the existing 3 sidebar view buttons (after line 620, before the file explorer button at line 622):

```tsx
{/* Git panel button */}
<button
  className="activity-btn"
  style={styles.activityBtn}
  onClick={() => {
    const state = useWorkspaceStore.getState();
    const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
    const path = ws?.paths[state.activePathIndex[ws?.id ?? ""] ?? 0] ?? ws?.paths[0];
    if (!path) return;
    if (state.unifiedGitPanelOpen) {
      state.closeUnifiedGitPanel();
    } else {
      state.openUnifiedGitPanel(path);
    }
  }}
  title={unifiedGitPanelOpen ? "Close git panel" : "Open git panel"}
>
  <svg width="18" height="18" viewBox="0 0 24 24" fill={unifiedGitPanelOpen ? "#ddd" : "#bbb"}>
    <path d="M21.007 8.222A3.738 3.738 0 0 0 15.045 5.2a3.737 3.737 0 0 0 1.156 6.583 2.988 2.988 0 0 1-2.668 1.67h-2.99a4.456 4.456 0 0 0-2.989 1.165V7.4a3.737 3.737 0 1 0-1.494 0v9.117a3.776 3.776 0 1 0 1.816.099 2.99 2.99 0 0 1 2.668-1.667h2.99a4.484 4.484 0 0 0 4.223-3.039 3.736 3.736 0 0 0 3.25-3.687z" />
  </svg>
</button>
```

Read `unifiedGitPanelOpen` from the store to control the icon's active state.

Add a badge indicator on the icon when:
- `gitStatus?.dirty` (local changes exist) — small blue dot
- This uses the same pattern as `GitStatusIcon`'s change count badge

**Step 2: Verify**

Run: `./scripts/reload.sh`
Expected: Git icon appears in activity bar between scripts and file explorer. Clicking toggles the unified panel. Icon shows active state when panel is open. Badge shows when there are local changes.

---

## Task 7: Clean up — remove old components and dead code

**Files:**
- Modify: `src/App.tsx:662-663` (remove old overlay mounts)
- Delete: `src/components/GitActions.tsx` (dead code — never imported)
- Modify: `src/components/GitDiffOverlay.tsx` (keep for now as `GitDiffContent` export, remove overlay wrapper)
- Modify: `src/components/PrReviewOverlay.tsx` (keep for now as `PrReviewContent` export, remove overlay wrapper)
- Modify: `src/stores/workspaceStore.ts` (remove old overlay state if no longer used)
- Modify: `src/components/FileExplorer.tsx` (remove old overlay references)

**Step 1: Remove old overlay mounts from App.tsx**

Remove these lines from `App.tsx` (around line 662-663):
```tsx
<GitDiffOverlay />
<PrReviewOverlayWrapper />
```

And remove the `PrReviewOverlayWrapper` function (lines 688-696).

Remove the imports for `GitDiffOverlay` and `PrReviewOverlay`.

**Step 2: Delete GitActions.tsx**

`src/components/GitActions.tsx` is never imported anywhere — it's dead code. Delete it.

**Step 3: Simplify GitDiffOverlay.tsx**

The `GitDiffOverlay` wrapper is no longer needed since `GitDiffContent` is used directly. Options:
- A) Keep the file and just export `GitDiffContent` (rename file later)
- B) Rename file to reflect it's now `GitDiffContent`

Go with option A for now — less churn. Remove the `GitDiffOverlay` export wrapper function, keep `GitDiffContent`.

**Step 4: Simplify PrReviewOverlay.tsx**

Same as Step 3. Remove the overlay wrapper, keep `PrReviewContent`.

**Step 5: Clean up old store state**

If `gitDiffOverlayOpen`, `gitDiffOverlayPath`, `prReviewOverlayOpen`, `prReviewOverlayPath` are no longer referenced anywhere:
- Remove from `WorkspaceState` interface
- Remove from initial state
- Remove from persisted state type
- Remove action implementations (`openGitDiffOverlay`, `closeGitDiffOverlay`, `openPrReviewOverlay`, `closePrReviewOverlay`)

**Important:** Check if `ChangesPanel` and `PrFilesPanel` in `FileExplorer.tsx` still reference the old overlay state. If they do, update them to use the unified panel state.

Keep `gitDiffActiveTab` and `gitDiffScrollToFile` if they're still used by `GitDiffContent`. If the tab state is now managed inside `GitDiffContent` locally, remove them.

**Step 6: Verify everything works end-to-end**

Run: `./scripts/run.sh` (full rebuild since store changed)
Expected:
- Activity bar git icon opens unified panel
- FileExplorer git icons open unified panel (Changes or PR tab)
- Overview tab shows status, quick actions, branch commits
- Changes tab shows full diff interface with staging
- PR tab shows full PR details when PR exists, empty state when not
- Commit modal hides "Create PR" when PR exists
- Ship still works
- DiffView panes still work
- ShipStatusPill still works
- No console errors
- Old overlays are fully removed

---

## Task 8: Polish and edge cases

**Files:**
- Modify: `src/components/UnifiedGitPanel.tsx` (polish)

**Step 1: Handle multi-path workspaces**

When a workspace has multiple repo paths, the unified panel should show the currently active path. The activity bar icon should use `activePathIndex` to determine which path to open.

When switching between repos in the file explorer, clicking a git icon for a different repo should update the panel to show that repo.

**Step 2: Auto-refresh on git changes**

The unified panel should listen for `rally:git-changes-refresh` events and refresh its content. The Changes tab already does this via `GitDiffContent`. The Overview tab should re-fetch branch commits when the event fires.

**Step 3: Tab badge updates**

Ensure tab badges update reactively:
- Changes tab count updates when `gitStatuses[rootPath]` changes
- PR tab number updates when `prStatuses[rootPath]` changes

**Step 4: Keyboard shortcuts**

Consider adding `Cmd+G` or similar to toggle the unified git panel. This is optional for v1.

**Step 5: Final verify**

Run: `./scripts/run.sh`
Test the full workflow: make changes → stage → commit → push → create PR → view PR → merge. All from the unified panel.
