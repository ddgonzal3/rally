# Flight Grid Redesign — Column-Per-Repo Layout

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the free-form spatial canvas in flight mode with a structured column-per-repo grid where columns = repos, rows = Claude Code sessions, and each terminal cell has its own per-repo script footer with shared script terminals within a column.

**Architecture:** The new `FlightGrid` component replaces `FlightCanvas` (which we delete). Each workspace's repos map to equal-width columns. Within each column, rows are independent Claude Code terminals. Each row has a compact footer showing that repo's `rally.json` statusBar scripts. Script terminals (watcher, build, run) are shared per-column — clicking a script in any row's footer opens the same PTY, rendered as a drawer below that specific cell (mutually exclusive within a column). Column headers show repo name + branch + "+" button for adding rows.

**Tech Stack:** React, Zustand, xterm.js, Tauri IPC (existing stack — no new deps)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lib/types.ts` | Modify | Add `FlightGrid`, `FlightColumn`, `FlightRow` types. Remove old `FlightPod*`, `FlightLayout`, `FlightLayoutPreset`, `FlightViewport` types and constants. |
| `src/components/FlightGrid.tsx` | Create | New top-level grid component: renders columns side-by-side, each with header + rows + per-cell footers. Replaces `FlightCanvas`. |
| `src/components/FlightColumnHeader.tsx` | Create | Column header: repo name, branch badge, "+" button to add row. ~50 lines. |
| `src/components/FlightCell.tsx` | Create | Single grid cell: terminal + footer + optional script drawer. Manages drawer open/close state. |
| `src/components/FlightCellFooter.tsx` | Create | Per-cell script footer: renders ScriptDots for that column's repo. Reuses existing `ScriptDot`-style logic from `BuildStatusBar`. |
| `src/components/FlightCellDrawer.tsx` | Create | Script drawer that slides up from bottom of a cell. Reuses xterm attachment logic from `BuildStatusDrawer`. |
| `src/stores/workspaceStore.ts` | Modify | Replace `flightLayouts` with `flightGrids: Record<string, FlightGrid>`. Add actions: `getOrCreateFlightGrid`, `addFlightRow`, `removeFlightRow`, `setFlightGridDrawer`, `setFlightRowPtyId`. Remove old flight pod/layout/preset/viewport actions. |
| `src/App.tsx` | Modify | Replace `<FlightCanvas />` with `<FlightGrid />`. Remove `<BuildStatusDrawer />` from flight mode section (drawers are now per-cell). Keep `<BuildStatusBar />` for dev mode only. |
| `src/components/FlightCanvas.tsx` | Delete | Replaced by `FlightGrid`. |
| `src/components/FlightPod.tsx` | Delete | Replaced by `FlightCell`. |
| `src/components/FlightHUD.tsx` | Delete | No longer needed (no zoom/pan/focus toggle). |
| `src/lib/focusScroll.ts` | Delete | No longer needed (no focus mode scroll snapping). |
| `src/lib/focusScroll.test.ts` | Delete | Test for deleted module. |

## Data Model

```typescript
// New types in types.ts

interface FlightGrid {
  columns: FlightColumn[];
}

interface FlightColumn {
  id: string;
  repoPath: string;
  rows: FlightRow[];
  /** Which cell currently has the script drawer open (null = none) */
  activeDrawer: {
    rowId: string;
    repoPath: string;
    scriptName: string;
  } | null;
}

interface FlightRow {
  id: string;
  ptyId?: string;  // Claude Code terminal
}
```

Script terminals remain managed by the existing `scriptRuns` / `scriptOutputBuffers` system keyed by `"repoPath:scriptName"`. No changes needed to that infrastructure — the drawer just attaches to the existing PTY.

## Important Design Decisions

1. **Shared script terminals**: Within a column, all rows share the same script PTYs. The `scriptRuns` map is already keyed by `repoPath:scriptName`, not by row — so this is naturally shared. The drawer just shows whichever script's output is selected.

2. **Mutually exclusive drawer per column**: Only one drawer open per column at a time. Opening a drawer in row 2 closes it in row 1. The `activeDrawer` field on `FlightColumn` tracks this.

3. **Equal-width columns**: All columns get `flex: 1`. With many repos this may get narrow — acceptable for now, user can fullscreen the window.

4. **Column auto-creation**: `getOrCreateFlightGrid(wsId)` reads `workspace.paths` and creates one column per repo path. If paths change (repo added/removed from workspace), columns sync on next access.

5. **Row removal**: Closing the last row in a column keeps the column (header stays, empty state shown). User can add a new row via the "+" button.

6. **No persistence of drawer state**: Drawer state (`activeDrawer`) is ephemeral — not persisted across app restarts. Grid structure (columns + rows with PTY IDs stripped) is persisted.

---

## Task 1: Define New Data Types

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Add new FlightGrid types**

Add after the existing flight types (which we'll remove in a later task):

```typescript
// --- Flight Grid Types (column-per-repo layout) ---

export interface FlightGrid {
  columns: FlightColumn[];
}

export interface FlightColumn {
  id: string;
  repoPath: string;
  rows: FlightRow[];
  /** Which cell currently has the script drawer open */
  activeDrawer: {
    rowId: string;
    repoPath: string;
    scriptName: string;
  } | null;
}

export interface FlightRow {
  id: string;
  ptyId?: string;
}
```

- [ ] **Step 2: Verify types compile**

Run: `./scripts/check.sh`
Expected: PASS (new types are additive, old types still present)

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(flight): add FlightGrid/FlightColumn/FlightRow types for column-per-repo layout"
```

---

## Task 2: Add Store Actions for Flight Grid

**Files:**
- Modify: `src/stores/workspaceStore.ts`

- [ ] **Step 1: Add flightGrids state and action signatures**

In the store state interface, add:
```typescript
flightGrids: Record<string, FlightGrid>;
```

Add action signatures:
```typescript
getOrCreateFlightGrid: (workspaceId: string) => FlightGrid;
addFlightRow: (workspaceId: string, columnId: string) => void;
removeFlightRow: (workspaceId: string, columnId: string, rowId: string) => void;
setFlightGridDrawer: (workspaceId: string, columnId: string, drawer: FlightColumn["activeDrawer"]) => void;
setFlightRowPtyId: (workspaceId: string, columnId: string, rowId: string, ptyId: string) => void;
```

- [ ] **Step 2: Initialize flightGrids in default state**

```typescript
flightGrids: {},
```

- [ ] **Step 3: Implement getOrCreateFlightGrid**

This creates a grid from `workspace.paths`. Each path becomes a column with one initial row.

```typescript
getOrCreateFlightGrid: (workspaceId: string): FlightGrid => {
  const existing = get().flightGrids[workspaceId];
  const ws = get().workspaces.find((w) => w.id === workspaceId);
  const paths = ws?.paths ?? [];

  if (existing) {
    // Sync columns if workspace paths changed
    const existingPaths = new Set(existing.columns.map((c) => c.repoPath));
    const currentPaths = new Set(paths);
    const needsSync = paths.length !== existing.columns.length ||
      paths.some((p) => !existingPaths.has(p));

    if (!needsSync) return existing;

    // Keep existing columns for paths that still exist, add new ones
    const columns: FlightColumn[] = paths.map((p) => {
      const existingCol = existing.columns.find((c) => c.repoPath === p);
      if (existingCol) return existingCol;
      return {
        id: crypto.randomUUID(),
        repoPath: p,
        rows: [{ id: crypto.randomUUID() }],
        activeDrawer: null,
      };
    });

    const grid = { columns };
    set((s) => ({
      flightGrids: { ...s.flightGrids, [workspaceId]: grid },
    }));
    return grid;
  }

  // Create fresh grid
  const columns: FlightColumn[] = paths.map((p) => ({
    id: crypto.randomUUID(),
    repoPath: p,
    rows: [{ id: crypto.randomUUID() }],
    activeDrawer: null,
  }));
  const grid = { columns };
  set((s) => ({
    flightGrids: { ...s.flightGrids, [workspaceId]: grid },
  }));
  return grid;
},
```

- [ ] **Step 4: Implement addFlightRow**

```typescript
addFlightRow: (workspaceId: string, columnId: string) => {
  const grid = get().flightGrids[workspaceId];
  if (!grid) return;
  const newRow: FlightRow = { id: crypto.randomUUID() };
  set((s) => ({
    flightGrids: {
      ...s.flightGrids,
      [workspaceId]: {
        columns: grid.columns.map((c) =>
          c.id === columnId
            ? { ...c, rows: [...c.rows, newRow] }
            : c
        ),
      },
    },
  }));
},
```

- [ ] **Step 5: Implement removeFlightRow**

```typescript
removeFlightRow: (workspaceId: string, columnId: string, rowId: string) => {
  const grid = get().flightGrids[workspaceId];
  if (!grid) return;
  const col = grid.columns.find((c) => c.id === columnId);
  if (!col) return;
  const row = col.rows.find((r) => r.id === rowId);
  // Kill PTY if it exists
  if (row?.ptyId) {
    api.killPty(row.ptyId).catch(() => {});
  }
  set((s) => ({
    flightGrids: {
      ...s.flightGrids,
      [workspaceId]: {
        columns: grid.columns.map((c) =>
          c.id === columnId
            ? { ...c, rows: c.rows.filter((r) => r.id !== rowId) }
            : c
        ),
      },
    },
  }));
},
```

- [ ] **Step 6: Implement setFlightGridDrawer**

```typescript
setFlightGridDrawer: (workspaceId: string, columnId: string, drawer: FlightColumn["activeDrawer"]) => {
  const grid = get().flightGrids[workspaceId];
  if (!grid) return;
  set((s) => ({
    flightGrids: {
      ...s.flightGrids,
      [workspaceId]: {
        columns: grid.columns.map((c) =>
          c.id === columnId
            ? { ...c, activeDrawer: drawer }
            : c
        ),
      },
    },
  }));
},
```

- [ ] **Step 7: Implement setFlightRowPtyId**

Called by `FlightCell` via `onPtySpawned` to persist the PTY ID on the row after Terminal spawns it:

```typescript
setFlightRowPtyId: (workspaceId: string, columnId: string, rowId: string, ptyId: string) => {
  const grid = get().flightGrids[workspaceId];
  if (!grid) return;
  set((s) => ({
    flightGrids: {
      ...s.flightGrids,
      [workspaceId]: {
        columns: grid.columns.map((c) =>
          c.id === columnId
            ? { ...c, rows: c.rows.map((r) => r.id === rowId ? { ...r, ptyId } : r) }
            : c
        ),
      },
    },
  }));
},
```

- [ ] **Step 8: Add flightGrids to persistence**

In the persist config's `partialize`, add `flightGrids`. In the `merge` function, handle hydration:
```typescript
flightGrids: (() => {
  const raw = (p?.flightGrids && typeof p.flightGrids === "object")
    ? p.flightGrids as Record<string, FlightGrid>
    : {};
  const cleaned: Record<string, FlightGrid> = {};
  for (const [wsId, grid] of Object.entries(raw)) {
    if (!grid?.columns) continue;
    cleaned[wsId] = {
      columns: grid.columns.map((col) => ({
        ...col,
        activeDrawer: null,  // Reset ephemeral drawer state
        rows: col.rows.map((row) => ({ ...row, ptyId: undefined })),  // Strip PTY IDs
      })),
    };
  }
  return cleaned;
})(),
```

- [ ] **Step 9: Verify types compile**

Run: `./scripts/check.sh`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/stores/workspaceStore.ts
git commit -m "feat(flight): add flightGrids store state and CRUD actions"
```

---

## Task 3: Build FlightColumnHeader Component

**Files:**
- Create: `src/components/FlightColumnHeader.tsx`

- [ ] **Step 1: Create the component**

```typescript
import React from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";

export function FlightColumnHeader({
  workspaceId,
  columnId,
  repoPath,
}: {
  workspaceId: string;
  columnId: string;
  repoPath: string;
}) {
  const addFlightRow = useWorkspaceStore((s) => s.addFlightRow);
  const gitStatus = useWorkspaceStore((s) => s.gitStatuses[repoPath]);
  const repoName = repoPath.split("/").pop() ?? repoPath;
  const branch = gitStatus?.branch ?? "";

  return (
    <div
      style={{
        height: 28,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0 8px",
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
        userSelect: "none",
      }}
    >
      <span
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "var(--text-primary)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {repoName}
      </span>
      {branch && (
        <span
          style={{
            fontSize: 11,
            color: "var(--text-dim)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {branch}
        </span>
      )}
      <div style={{ flex: 1 }} />
      <button
        className="tab-action"
        onClick={() => addFlightRow(workspaceId, columnId)}
        title="Add Claude session"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 18,
          height: 18,
          padding: 0,
          background: "none",
          border: "none",
          color: "var(--text-secondary)",
          cursor: "pointer",
          borderRadius: 3,
          fontSize: 16,
          lineHeight: 1,
        }}
      >
        +
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Verify types compile**

Run: `./scripts/check.sh`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/components/FlightColumnHeader.tsx
git commit -m "feat(flight): add FlightColumnHeader with repo name, branch, and add-row button"
```

---

## Task 4: Build FlightCellFooter Component

**Files:**
- Create: `src/components/FlightCellFooter.tsx`

This is a simplified version of `BuildStatusBar`'s per-repo section, rendered inline below each terminal cell. It reuses the `ScriptDot` pattern but scoped to a single repo.

- [ ] **Step 1: Create the component**

Extract the per-repo script rendering logic. The footer shows the statusBar scripts for its column's repo. Clicking a script either starts it (if idle) or opens the drawer (if running). The footer delegates drawer management to the parent via `onOpenDrawer`.

```typescript
import React, { useState, useEffect, useMemo } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { api } from "../lib/tauri";
import type { ScriptEntry } from "../lib/types";
import {
  isWatcherScript,
  getWatcherDisplayStatus,
  getDisplayName,
  clearWatcherStatusCache,
} from "../lib/watcherStatus";

export function FlightCellFooter({
  repoPath,
  columnId,
  rowId,
  workspaceId,
}: {
  repoPath: string;
  columnId: string;
  rowId: string;
  workspaceId: string;
}) {
  const rallyConfig = useWorkspaceStore((s) => s.rallyConfigs[repoPath]);
  const scriptRuns = useWorkspaceStore((s) => s.scriptRuns);
  const runScript = useWorkspaceStore((s) => s.runScript);
  const stopScript = useWorkspaceStore((s) => s.stopScript);
  const clearScript = useWorkspaceStore((s) => s.clearScript);
  const setFlightGridDrawer = useWorkspaceStore((s) => s.setFlightGridDrawer);
  const activeDrawer = useWorkspaceStore(
    (s) => s.flightGrids[workspaceId]?.columns.find((c) => c.id === columnId)?.activeDrawer
  );
  const loadRallyConfig = useWorkspaceStore((s) => s.loadRallyConfig);

  const [scriptCache, setScriptCache] = useState<ScriptEntry[]>([]);

  useEffect(() => {
    if (!rallyConfig) loadRallyConfig(repoPath);
    api.listScripts(repoPath).then(setScriptCache).catch(() => {});
  }, [repoPath, loadRallyConfig, rallyConfig]);

  const scripts = rallyConfig?.statusBar ?? [];
  if (scripts.length === 0) return null;

  return (
    <div
      style={{
        height: 24,
        display: "flex",
        alignItems: "center",
        gap: 0,
        paddingLeft: 8,
        paddingRight: 8,
        borderTop: "1px solid var(--border)",
        flexShrink: 0,
        userSelect: "none",
        overflow: "hidden",
      }}
    >
      {scripts.map((scriptName) => {
        const key = `${repoPath}:${scriptName}`;
        const run = scriptRuns[key];
        const isRunning = run?.status === "running";
        const entry = scriptCache.find((e) => e.name === scriptName);
        const command = entry?.command ?? scriptName;
        const displayName = getDisplayName(scriptName);
        const isDrawerOpen =
          activeDrawer?.rowId === rowId &&
          activeDrawer?.scriptName === scriptName;

        const isWatcher = isWatcherScript(scriptName);
        let dotColor = "var(--text-dim)";
        let dotOpacity = 0.6;
        if (isRunning && isWatcher) {
          dotColor = "var(--status-green)";
          dotOpacity = 0.7;
        } else if (isRunning) {
          dotColor = "var(--status-amber)";
          dotOpacity = 1;
        } else if (run?.status === "error") {
          dotColor = "var(--status-red)";
          dotOpacity = 1;
        }

        return (
          <div
            key={scriptName}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              if (isRunning || run?.status === "error") {
                // Toggle drawer: if already open on this row for this script, close it
                if (isDrawerOpen) {
                  setFlightGridDrawer(workspaceId, columnId, null);
                } else {
                  setFlightGridDrawer(workspaceId, columnId, {
                    rowId,
                    repoPath,
                    scriptName,
                  });
                }
              } else {
                runScript(repoPath, scriptName, command);
              }
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 4px",
              borderRadius: 3,
              cursor: "pointer",
              background: isDrawerOpen ? "var(--terminal-popup-bg)" : "transparent",
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: dotColor,
                opacity: dotOpacity,
                flexShrink: 0,
              }}
            />
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: "var(--text-primary)",
                opacity: 0.8,
                whiteSpace: "nowrap",
                lineHeight: 1,
              }}
            >
              {displayName}
            </span>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Verify types compile**

Run: `./scripts/check.sh`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/components/FlightCellFooter.tsx
git commit -m "feat(flight): add FlightCellFooter with per-repo script dots"
```

---

## Task 5: Build FlightCellDrawer Component

**Files:**
- Create: `src/components/FlightCellDrawer.tsx`

A simplified version of `BuildStatusDrawer` that renders inline below a cell (not as a window-level overlay). Attaches to the script's existing PTY via `scriptRuns`.

- [ ] **Step 1: Create the component**

```typescript
import React, { useEffect, useRef, useCallback, useState } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useWorkspaceStore, scriptOutputBuffers } from "../stores/workspaceStore";
import { api } from "../lib/tauri";
import { getXtermTheme } from "../lib/xtermTheme";

export function FlightCellDrawer({
  repoPath,
  scriptName,
  columnId,
  workspaceId,
}: {
  repoPath: string;
  scriptName: string;
  columnId: string;
  workspaceId: string;
}) {
  const key = `${repoPath}:${scriptName}`;
  const run = useWorkspaceStore((s) => s.scriptRuns[key]);
  const theme = useWorkspaceStore((s) => s.theme);
  const setFlightGridDrawer = useWorkspaceStore((s) => s.setFlightGridDrawer);
  const stopScript = useWorkspaceStore((s) => s.stopScript);

  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [height, setHeight] = useState(180);

  // Create and attach xterm
  useEffect(() => {
    if (!termRef.current || !run?.ptyId) return;
    const xterm = new XTerminal({
      fontSize: 12,
      fontFamily: "var(--font-mono, 'SF Mono', Menlo, monospace)",
      theme: getXtermTheme(theme),
      convertEol: true,
      scrollback: 5000,
      cursorBlink: false,
      disableStdin: true,
    });
    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(termRef.current);
    fitAddon.fit();
    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    // Wire input to PTY (Ctrl+C, typing, etc.)
    const encoder = new TextEncoder();
    const onDataDisposable = xterm.onData((data) => {
      const currentRun = useWorkspaceStore.getState().scriptRuns[key];
      if (currentRun?.ptyId) {
        api.writePty(currentRun.ptyId, Array.from(encoder.encode(data))).catch(() => {});
      }
    });

    requestAnimationFrame(() => xterm.focus());

    // Replay buffered output
    const buffer = scriptOutputBuffers.get(key);
    if (buffer && buffer.length > 0) {
      for (const chunk of buffer) {
        xterm.write(chunk);
      }
      xterm.scrollToBottom();
    }

    // Listen for new output via the same event BuildStatusDrawer uses
    const handleOutput = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.key === key && detail.chunks) {
        for (const chunk of detail.chunks as Uint8Array[]) {
          xterm.write(chunk);
        }
      }
    };
    document.addEventListener("rally:watcher-output", handleOutput);

    return () => {
      onDataDisposable.dispose();
      document.removeEventListener("rally:watcher-output", handleOutput);
      xterm.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [run?.ptyId, key, theme]);

  // Re-fit on height change
  useEffect(() => {
    fitAddonRef.current?.fit();
  }, [height]);

  // Resize handle
  const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = height;
    const onMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY;
      setHeight(Math.max(80, Math.min(400, startHeight + delta)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [height]);

  if (!run?.ptyId) return null;

  return (
    <div
      style={{
        height,
        borderTop: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        position: "relative",
      }}
    >
      {/* Resize handle */}
      <div
        onMouseDown={onHandleMouseDown}
        style={{
          height: 4,
          cursor: "ns-resize",
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 2,
        }}
      />
      {/* Header bar */}
      <div
        style={{
          height: 22,
          display: "flex",
          alignItems: "center",
          padding: "0 8px",
          gap: 6,
          fontSize: 11,
          color: "var(--text-dim)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontWeight: 500 }}>{scriptName}</span>
        <div style={{ flex: 1 }} />
        <button
          className="tab-action"
          onClick={() => setFlightGridDrawer(workspaceId, columnId, null)}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: 14,
            padding: 0,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>
      {/* Terminal */}
      <div ref={termRef} style={{ flex: 1, padding: "0 4px" }} />
    </div>
  );
}
```

- [ ] **Step 2: Verify types compile**

Run: `./scripts/check.sh`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/components/FlightCellDrawer.tsx
git commit -m "feat(flight): add FlightCellDrawer for per-cell script output"
```

---

## Task 6: Build FlightCell Component

**Files:**
- Create: `src/components/FlightCell.tsx`

Each cell renders a Claude Code terminal + footer + optional drawer. The terminal spawns a PTY on mount (like the existing `Terminal` component pattern).

- [ ] **Step 1: Create the component**

```typescript
import React, { useEffect, useRef } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { Terminal } from "./Terminal";
import { FlightCellFooter } from "./FlightCellFooter";
import { FlightCellDrawer } from "./FlightCellDrawer";

export function FlightCell({
  workspaceId,
  columnId,
  row,
  repoPath,
}: {
  workspaceId: string;
  columnId: string;
  row: { id: string; ptyId?: string };
  repoPath: string;
}) {
  const activeDrawer = useWorkspaceStore(
    (s) => s.flightGrids[workspaceId]?.columns.find((c) => c.id === columnId)?.activeDrawer
  );
  const removeFlightRow = useWorkspaceStore((s) => s.removeFlightRow);
  const setFlightRowPtyId = useWorkspaceStore((s) => s.setFlightRowPtyId);
  const drawerForThisRow =
    activeDrawer?.rowId === row.id ? activeDrawer : null;

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 200,
        borderBottom: "1px solid var(--border)",
      }}
    >
      {/* Terminal area */}
      <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
        <Terminal
          cwd={repoPath}
          command="claude"
          ptyId={row.ptyId}
          workspaceId={workspaceId}
          onPtySpawned={(ptyId) => setFlightRowPtyId(workspaceId, columnId, row.id, ptyId)}
          onKill={() => removeFlightRow(workspaceId, columnId, row.id)}
        />
      </div>
      {/* Footer */}
      <FlightCellFooter
        repoPath={repoPath}
        columnId={columnId}
        rowId={row.id}
        workspaceId={workspaceId}
      />
      {/* Drawer (if open for this row) */}
      {drawerForThisRow && (
        <FlightCellDrawer
          repoPath={drawerForThisRow.repoPath}
          scriptName={drawerForThisRow.scriptName}
          columnId={columnId}
          workspaceId={workspaceId}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify types compile**

Run: `./scripts/check.sh`
Expected: PASS (may need to adjust Terminal props based on actual component signature)

- [ ] **Step 3: Commit**

```bash
git add src/components/FlightCell.tsx
git commit -m "feat(flight): add FlightCell combining terminal + footer + drawer"
```

---

## Task 7: Build FlightGrid Component

**Files:**
- Create: `src/components/FlightGrid.tsx`

The top-level component that replaces `FlightCanvas`. Renders columns side-by-side.

- [ ] **Step 1: Create the component**

```typescript
import React, { useEffect } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { FlightColumnHeader } from "./FlightColumnHeader";
import { FlightCell } from "./FlightCell";

function FlightColumnView({
  workspaceId,
  column,
  isLast,
}: {
  workspaceId: string;
  column: { id: string; repoPath: string; rows: { id: string; ptyId?: string }[] };
  isLast: boolean;
}) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        borderRight: isLast ? "none" : "1px solid var(--border)",
      }}
    >
      <FlightColumnHeader
        workspaceId={workspaceId}
        columnId={column.id}
        repoPath={column.repoPath}
      />
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        {column.rows.length === 0 ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-dim)",
              fontSize: 13,
            }}
          >
            No sessions. Click + to add one.
          </div>
        ) : (
          column.rows.map((row) => (
            <FlightCell
              key={row.id}
              workspaceId={workspaceId}
              columnId={column.id}
              row={row}
              repoPath={column.repoPath}
            />
          ))
        )}
      </div>
    </div>
  );
}

export function FlightGrid() {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const getOrCreateFlightGrid = useWorkspaceStore((s) => s.getOrCreateFlightGrid);
  const grid = useWorkspaceStore((s) =>
    s.activeWorkspaceId ? s.flightGrids[s.activeWorkspaceId] : undefined
  );

  useEffect(() => {
    if (activeWorkspaceId) getOrCreateFlightGrid(activeWorkspaceId);
  }, [activeWorkspaceId, getOrCreateFlightGrid]);

  if (!activeWorkspaceId || !grid) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-dim)",
          fontSize: 14,
        }}
      >
        No workspace selected. Add a workspace from the sidebar.
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      {grid.columns.map((col, i) => (
        <FlightColumnView
          key={col.id}
          workspaceId={activeWorkspaceId}
          column={col}
          isLast={i === grid.columns.length - 1}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Verify types compile**

Run: `./scripts/check.sh`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/components/FlightGrid.tsx
git commit -m "feat(flight): add FlightGrid top-level component with column-per-repo layout"
```

---

## Task 8: Wire FlightGrid into App + Remove Old Flight Components

**Files:**
- Modify: `src/App.tsx`
- Delete: `src/components/FlightCanvas.tsx`
- Delete: `src/components/FlightPod.tsx`
- Delete: `src/components/FlightHUD.tsx`
- Delete: `src/lib/focusScroll.ts`
- Delete: `src/lib/focusScroll.test.ts`

- [ ] **Step 1: Replace FlightCanvas import with FlightGrid in App.tsx**

Change:
```typescript
import { FlightCanvas } from "./components/FlightCanvas";
```
To:
```typescript
import { FlightGrid } from "./components/FlightGrid";
```

In the flight mode section (~line 2114), replace:
```tsx
<FlightCanvas />
<BuildStatusDrawer />
```
With:
```tsx
<FlightGrid />
```

The `<BuildStatusDrawer />` is removed from flight mode (drawers are now per-cell). Keep it in dev mode.

- [ ] **Step 2: Conditionally render BuildStatusBar only in non-flight modes**

The `<BuildStatusBar />` at line ~2132 should not render in flight mode (per-cell footers replace it). Wrap it:
```tsx
{!isFlightMode && <BuildStatusBar />}
```

- [ ] **Step 3: Delete old flight mode files**

```bash
rm src/components/FlightCanvas.tsx
rm src/components/FlightPod.tsx
rm src/components/FlightHUD.tsx
rm src/lib/focusScroll.ts
rm src/lib/focusScroll.test.ts
```

- [ ] **Step 4: Remove dead imports throughout codebase**

Search for any imports of deleted modules (`FlightCanvas`, `FlightPod`, `FlightHUD`, `focusScroll`) in other files and remove them. Check `workspaceStore.ts` for references to old flight types/actions.

- [ ] **Step 5: Verify types compile**

Run: `./scripts/check.sh`
Expected: May have errors from old flight references in the store. Fix them in the next task.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(flight): wire FlightGrid into App, remove old FlightCanvas/FlightPod/FlightHUD"
```

---

## Task 9: Clean Up Store — Remove Old Flight Layout Code

**Files:**
- Modify: `src/stores/workspaceStore.ts`
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Remove old flight types from types.ts**

Delete: `FlightPodBase`, `FlightClaudePod`, `FlightTerminalPod`, `FlightPod`, `FlightViewport`, `FlightLayout`, `FlightLayoutPreset`, and the old flight constants (`FLIGHT_DEFAULT_CLAUDE_WIDTH`, `FLIGHT_DEFAULT_CLAUDE_HEIGHT`, `FLIGHT_DEFAULT_TERMINAL_WIDTH`, `FLIGHT_DEFAULT_TERMINAL_HEIGHT`, `FLIGHT_MIN_CLAUDE_WIDTH`, `FLIGHT_MIN_CLAUDE_HEIGHT`, `FLIGHT_MIN_TERMINAL_WIDTH`, `FLIGHT_MIN_TERMINAL_HEIGHT`, `FLIGHT_DEFAULT_SHELL_HEIGHT`, `FLIGHT_ZOOM_MIN`, `FLIGHT_ZOOM_MAX`).

- [ ] **Step 2: Remove old flight actions from store**

Remove from store state, interface, and implementation:

State fields:
- `flightLayouts: Record<string, FlightLayout>`
- `flightNextZIndex: Record<string, number>`
- `flightLayoutPresets: Record<string, FlightLayoutPreset[]>`
- `activeFlightPresetId: Record<string, string>`

Actions:
- `getOrCreateFlightLayout`
- `addFlightPod`
- `addFlightPodAt`
- `removeFlightPod`
- `updateFlightPod`
- `setFlightViewport`
- `bringPodToFront`
- `togglePodShell`
- `saveFlightPreset`
- `restoreFlightPreset`
- `deleteFlightPreset`
- `reorderFlightPreset` (if it exists)

Update persistence: remove `flightLayouts`, `flightNextZIndex`, `flightLayoutPresets`, `activeFlightPresetId` from `partialize`. The new `flightGrids` should already be in persistence from Task 2.

- [ ] **Step 3: Update mode switching logic**

The dev↔flight mode switching in the store (~line 966-1022) currently converts between pod PTYs and pane PTYs. Rewrite to work with the grid model:

```typescript
// Flight → Dev: collect PTYs from all grid rows, create dev panes
if (newMode === "dev" && currentMode === "flight") {
  const grid = get().flightGrids[workspaceId];
  if (grid) {
    const panes: Pane[] = [];
    for (const col of grid.columns) {
      for (const row of col.rows) {
        if (row.ptyId) {
          panes.push({
            id: crypto.randomUUID(),
            type: "claude",
            title: "Claude Code",
            ptyId: row.ptyId,
            cwd: col.repoPath,
          });
        }
      }
    }
    // Place panes into the first dev group (or create layout with them)
    // ... create WorkspaceLayout from panes
  }
}

// Dev → Flight: collect PTYs from dev panes, place into grid rows matched by CWD
if (newMode === "flight" && currentMode === "dev") {
  const layout = get().layouts[workspaceId];
  if (layout) {
    const allPanes: Pane[] = [];
    // Walk layout tree to collect all panes with ptyIds
    for (const group of Object.values(layout.groups)) {
      allPanes.push(...group.panes.filter((p) => p.ptyId));
    }
    // Match panes to grid columns by CWD
    const grid = get().getOrCreateFlightGrid(workspaceId);
    for (const pane of allPanes) {
      const col = grid.columns.find((c) => c.repoPath === pane.cwd);
      if (col) {
        // Add as a new row with the existing PTY
        // ... add row with ptyId
      }
    }
  }
}
```

Full implementation details depend on the existing mode-switch code shape — adapt accordingly.

- [ ] **Step 4: Remove FlightPod imports from store**

The store may import `snapToNeighbors`, `preventOverlap` from `FlightPod.tsx` — remove these dead imports.

- [ ] **Step 5: Fix Cmd+backtick handler in App.tsx**

The shell toggle handler in App.tsx (~line 1300) references `flightLayouts` and flight pods. Remove the flight-specific branch entirely — the grid cells don't have toggleable shells (each cell is a full Claude Code terminal). Also remove the import of `FLIGHT_DEFAULT_SHELL_HEIGHT` if it exists in App.tsx.

- [ ] **Step 6: Verify types compile**

Run: `./scripts/check.sh`
Expected: PASS — all old flight references removed

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(flight): remove old flight layout/pod/preset code from store and types"
```

---

## Task 10: Cmd+1-9 Column Focus Shortcuts

**Files:**
- Modify: `src/stores/workspaceStore.ts` — add `focusedFlightColumn` state and `focusFlightColumn` action
- Modify: `src/lib/types.ts` — add `focusedColumnIndex` to `FlightGrid`
- Modify: `src/components/FlightGrid.tsx` — render focused column expanded, others collapsed
- Modify: `src/App.tsx` — add keydown listener for Cmd+1-9
- Modify: `src/components/Terminal.tsx` — let Cmd+1-9 bubble up from xterm

Behavior:
- **Cmd+N** (N = 1-9): If column N exists, focus it (expand to full width, collapse others to just the column header). If column N doesn't exist but repo N does in `workspace.paths`, create a new column with one row. If N > number of repos, no-op.
- **Cmd+0** or **Escape**: Return to default view (all columns equal width). This is the "go back to default view" the user wants.
- A focused column shows all its rows at full width. Collapsed columns show only their header (clickable to focus them).

- [ ] **Step 1: Add focusedColumnIndex to FlightGrid type**

```typescript
export interface FlightGrid {
  columns: FlightColumn[];
  /** Index of focused column, or null for default (all visible) */
  focusedColumnIndex: number | null;
}
```

Update `getOrCreateFlightGrid` to initialize `focusedColumnIndex: null`.

- [ ] **Step 2: Add focusFlightColumn store action**

```typescript
focusFlightColumn: (workspaceId: string, columnIndex: number | null) => void;
```

Implementation:
```typescript
focusFlightColumn: (workspaceId: string, columnIndex: number | null) => {
  const grid = get().flightGrids[workspaceId];
  if (!grid) return;

  if (columnIndex === null) {
    // Return to default view
    set((s) => ({
      flightGrids: {
        ...s.flightGrids,
        [workspaceId]: { ...grid, focusedColumnIndex: null },
      },
    }));
    return;
  }

  // If column exists, focus it
  if (columnIndex < grid.columns.length) {
    set((s) => ({
      flightGrids: {
        ...s.flightGrids,
        [workspaceId]: { ...grid, focusedColumnIndex: columnIndex },
      },
    }));
    return;
  }

  // If column doesn't exist but repo does, create column with one row and focus it
  const ws = get().workspaces.find((w) => w.id === workspaceId);
  const paths = ws?.paths ?? [];
  if (columnIndex < paths.length) {
    const newCol: FlightColumn = {
      id: crypto.randomUUID(),
      repoPath: paths[columnIndex],
      rows: [{ id: crypto.randomUUID() }],
      activeDrawer: null,
    };
    set((s) => ({
      flightGrids: {
        ...s.flightGrids,
        [workspaceId]: {
          ...grid,
          columns: [...grid.columns, newCol],
          focusedColumnIndex: columnIndex,
        },
      },
    }));
  }
},
```

- [ ] **Step 3: Add Cmd+1-9 keydown handler in App.tsx**

In the flight mode keydown effect:
```typescript
useEffect(() => {
  if (!isFlightMode || !activeWorkspaceId) return;
  const handler = (e: KeyboardEvent) => {
    if (!e.metaKey) return;
    const digit = parseInt(e.key, 10);
    if (digit >= 1 && digit <= 9) {
      e.preventDefault();
      focusFlightColumn(activeWorkspaceId, digit - 1);  // 0-indexed
    } else if (e.key === "0" || e.key === "Escape") {
      e.preventDefault();
      focusFlightColumn(activeWorkspaceId, null);  // default view
    }
  };
  document.addEventListener("keydown", handler);
  return () => document.removeEventListener("keydown", handler);
}, [isFlightMode, activeWorkspaceId]);
```

- [ ] **Step 4: Let Cmd+1-9 bubble from xterm**

In `Terminal.tsx`'s `customKeyEventHandler`, add alongside the existing Cmd+W and Cmd+/ bubbling:
```typescript
// Let Cmd+1-9 and Cmd+0 bubble for flight grid column focus
if (ev.key >= "0" && ev.key <= "9") {
  return false;
}
```

- [ ] **Step 5: Update FlightGrid rendering for focused column**

In `FlightGrid.tsx`, when `focusedColumnIndex` is set:
- The focused column gets `flex: 1` (full width)
- Other columns render as collapsed headers only (28px wide strip showing repo name vertically, clickable to focus)

```typescript
const focusedIndex = grid.focusedColumnIndex;

return (
  <div style={{ flex: 1, display: "flex", minWidth: 0, minHeight: 0, overflow: "hidden" }}>
    {grid.columns.map((col, i) => {
      if (focusedIndex !== null && i !== focusedIndex) {
        // Collapsed column — just a clickable header strip
        return (
          <div
            key={col.id}
            onClick={() => focusFlightColumn(activeWorkspaceId, i)}
            style={{
              width: 28,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRight: "1px solid var(--border)",
              cursor: "pointer",
              writingMode: "vertical-rl",
              textOrientation: "mixed",
              fontSize: 11,
              color: "var(--text-dim)",
              userSelect: "none",
              flexShrink: 0,
            }}
          >
            {col.repoPath.split("/").pop()}
          </div>
        );
      }
      return (
        <FlightColumnView
          key={col.id}
          workspaceId={activeWorkspaceId}
          column={col}
          isLast={focusedIndex !== null || i === grid.columns.length - 1}
        />
      );
    })}
  </div>
);
```

- [ ] **Step 6: Verify types compile**

Run: `./scripts/check.sh`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(flight): add Cmd+1-9 column focus shortcuts with collapsed sidebar columns"
```

---

## Task 11: Integration Test — Build and Run

- [ ] **Step 1: Full type check**

Run: `./scripts/check.sh`
Expected: PASS

- [ ] **Step 2: Build the app**

Run: `./scripts/build.sh`
Expected: Successful build

- [ ] **Step 3: Launch and test**

Run: `./scripts/run.sh`

Test checklist:
- [ ] Flight mode shows columns equal to number of repos in workspace
- [ ] Column headers show repo name + branch
- [ ] "+" button adds a new Claude session row
- [ ] Each terminal spawns Claude Code in the correct repo directory
- [ ] Footer shows scripts from rally.json for each repo
- [ ] Clicking a script starts it (dot changes color)
- [ ] Clicking a running script opens drawer below that cell
- [ ] Clicking same script in another row's footer moves drawer to that row
- [ ] Drawer shows script output (xterm)
- [ ] Script status dots are synced across all rows in a column
- [ ] Switching to dev mode and back preserves grid state
- [ ] Cmd+1 focuses first column (others collapse to thin strips)
- [ ] Cmd+2 focuses second column
- [ ] Cmd+3 on a 2-repo workspace with 3 paths creates column 3 and focuses it
- [ ] Cmd+0 returns to default view (all columns equal width)
- [ ] Clicking a collapsed column strip focuses it
- [ ] Cmd+1-9 works even when an xterm terminal has focus

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix(flight): integration fixes for flight grid layout"
```
