# Stash Dock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shift+click any Flight Mode pod to stash it into a bottom dock strip; click its chip to restore it.

**Architecture:** Add `stashed?: boolean` to `FlightPodBase` (persists free in the existing JSON). A module-level `ptyLastOutputAt` map timestamps every PTY output chunk — the dock chip polls it for an activity dot. All canvas logic that lays out or iterates pods filters `stashed: true` pods. Two new components (`StashDock`, `StashChip`) render the dock strip; one new store actions pair (`stashPod`/`unstashPod`) wraps `updateFlightPod`.

**Tech Stack:** React 19, Zustand v5, TypeScript, existing Tauri/PTY infrastructure. No Rust changes.

---

## File Map

| File | Change |
|------|--------|
| `src/lib/types.ts` | Add `stashed?: boolean` to `FlightPodBase` (~line 548) |
| `src/stores/workspaceStore.ts` | Export `ptyLastOutputAt` map; update `appendPtyBuffer` to stamp it; add `stashPod`/`unstashPod` to interface (~line 539) and implementation (~line 3293) |
| `src/components/FlightCanvas.tsx` | Filter stashed pods from `podIdList`; add `stashedPodIdList`; adjust `focusPodHeight` for dock; add `dockHeightRef`; adjust `navigateToPod` availH; add shift+click handler in `clickTracker`; render `<StashDock>` |
| `src/components/StashDock.tsx` | **New** — absolute-positioned dock strip, renders chips for stashed pods |
| `src/components/StashChip.tsx` | **New** — individual chip with activity dot + restore/close actions |

---

### Task 1: Add `stashed` to `FlightPodBase`

**Files:**
- Modify: `src/lib/types.ts` (~line 548, after `zIndex`)

- [ ] **Step 1: Add the field**

In `src/lib/types.ts`, add `stashed?: boolean` to `FlightPodBase` after `zIndex`:

```ts
// Before (line ~548):
  zIndex: number;
  /** Tabs for the shell panel (bottom terminal area). */
  shellTabs?: FlightTab[];

// After:
  zIndex: number;
  stashed?: boolean;
  /** Tabs for the shell panel (bottom terminal area). */
  shellTabs?: FlightTab[];
```

- [ ] **Step 2: Type-check**

```bash
./scripts/check.sh
```

Expected: no TS errors (the field is optional, so no consumers break).

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(stash-dock): add stashed field to FlightPodBase"
```

---

### Task 2: Add PTY last-output timestamp tracking

**Files:**
- Modify: `src/stores/workspaceStore.ts` (~lines 77, 90)

The `appendPtyBuffer` function is the single place all PTY output flows through. Stamping it here means every chunk — even from stashed pods — updates the timestamp.

- [ ] **Step 1: Add the exported map and stamp it**

In `src/stores/workspaceStore.ts`, add the map right after `ptyOutputBuffers` declaration (~line 77), and stamp it inside `appendPtyBuffer` (~line 90):

```ts
// After line 77:
export const ptyOutputBuffers = new Map<string, Uint8Array[]>();
// ADD THIS:
export const ptyLastOutputAt = new Map<string, number>();
```

```ts
// In appendPtyBuffer (~line 90), add one line after pushLimitedChunk:
export function appendPtyBuffer(ptyId: string, chunk: Uint8Array) {
  let buf = ptyOutputBuffers.get(ptyId);
  if (!buf) {
    buf = [];
    ptyOutputBuffers.set(ptyId, buf);
  }
  pushLimitedChunk(buf, chunk, MAX_PTY_BUFFER_CHUNKS);
  ptyLastOutputAt.set(ptyId, Date.now()); // ADD THIS LINE
}
```

- [ ] **Step 2: Type-check**

```bash
./scripts/check.sh
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/stores/workspaceStore.ts
git commit -m "feat(stash-dock): track per-PTY last-output timestamp"
```

---

### Task 3: Add stashPod / unstashPod store actions

**Files:**
- Modify: `src/stores/workspaceStore.ts` (~line 539 for interface, ~line 3293 for implementation)

- [ ] **Step 1: Add to the store interface**

In the store interface (~line 539), add two lines after `updateFlightPod`:

```ts
// After line 539:
  updateFlightPod: (workspaceId: string, podId: string, updates: Partial<FlightPod>) => void;
  // ADD THESE:
  stashPod: (workspaceId: string, podId: string) => void;
  unstashPod: (workspaceId: string, podId: string) => void;
  setFlightViewport: (workspaceId: string, viewport: Partial<FlightViewport>) => void;
```

- [ ] **Step 2: Add implementations**

After `updateFlightPod` implementation (~line 3293, right after its closing `},`):

```ts
  stashPod: (workspaceId: string, podId: string) => {
    get().updateFlightPod(workspaceId, podId, { stashed: true } as Partial<FlightPod>);
  },

  unstashPod: (workspaceId: string, podId: string) => {
    get().updateFlightPod(workspaceId, podId, { stashed: false } as Partial<FlightPod>);
  },
```

- [ ] **Step 3: Type-check**

```bash
./scripts/check.sh
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/stores/workspaceStore.ts
git commit -m "feat(stash-dock): add stashPod/unstashPod store actions"
```

---

### Task 4: Create StashChip component

**Files:**
- Create: `src/components/StashChip.tsx`

This component renders one chip in the dock for a stashed pod. It polls `ptyLastOutputAt` every second to derive the activity dot. It reads all PTY IDs that belong to the pod (from the pod's inner layout panes + shellPtyId + shellTabs) so it catches Claude activity, not just shell activity.

- [ ] **Step 1: Create the file**

```tsx
// src/components/StashChip.tsx
import React, { useState, useEffect, useCallback } from "react";
import { useWorkspaceStore, ptyLastOutputAt } from "../stores/workspaceStore";

const ACTIVE_THRESHOLD_MS = 3000;

function getPodPtyIds(podId: string): string[] {
  const state = useWorkspaceStore.getState();
  const ids: string[] = [];
  // Inner layout panes (where Claude Code actually lives)
  const podLayout = state.layouts[`flight:${podId}`];
  if (podLayout?.root) {
    const walk = (node: { type: string; groupId?: string; children?: typeof node[] }) => {
      if (node.type === "group" && node.groupId) {
        const group = podLayout.groups?.[node.groupId];
        group?.panes.forEach((p: { ptyId?: string | null }) => {
          if (p.ptyId) ids.push(p.ptyId);
        });
      } else if (node.type === "split" && node.children) {
        node.children.forEach(walk);
      }
    };
    walk(podLayout.root as Parameters<typeof walk>[0]);
  }
  // Shell PTYs
  const pods = state.flightLayouts;
  for (const layout of Object.values(pods)) {
    const pod = layout?.pods?.find((p) => p.id === podId);
    if (!pod) continue;
    const anyPod = pod as { ptyId?: string; shellPtyId?: string; shellTabs?: { ptyId?: string }[] };
    if (anyPod.ptyId) ids.push(anyPod.ptyId);
    if (anyPod.shellPtyId) ids.push(anyPod.shellPtyId);
    anyPod.shellTabs?.forEach((t) => { if (t.ptyId) ids.push(t.ptyId); });
    break;
  }
  return ids;
}

interface StashChipProps {
  podId: string;
  workspaceId: string;
}

export function StashChip({ podId, workspaceId }: StashChipProps) {
  const unstashPod = useWorkspaceStore((s) => s.unstashPod);
  const removeFlightPod = useWorkspaceStore((s) => s.removeFlightPod);
  const title = useWorkspaceStore((s) => {
    const pod = s.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId);
    if (!pod) return podId;
    return pod.cwd ? pod.cwd.split("/").pop() || pod.cwd : pod.title || podId;
  });

  const [isActive, setIsActive] = useState(false);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    const tick = () => {
      const ids = getPodPtyIds(podId);
      const now = Date.now();
      const active = ids.some((id) => {
        const last = ptyLastOutputAt.get(id);
        return last !== undefined && now - last < ACTIVE_THRESHOLD_MS;
      });
      setIsActive(active);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [podId]);

  const handleRestore = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      unstashPod(workspaceId, podId);
    },
    [unstashPod, workspaceId, podId],
  );

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      removeFlightPod(workspaceId, podId);
    },
    [removeFlightPod, workspaceId, podId],
  );

  return (
    <div
      className="sidebar-btn"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={handleRestore}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        padding: "0 8px",
        height: 24,
        borderRadius: 5,
        cursor: "pointer",
        background: hovered ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.1)",
        flexShrink: 0,
        userSelect: "none",
      }}
    >
      {/* Activity dot */}
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: isActive ? "#ddd" : "#444",
          flexShrink: 0,
          transition: "background 0.4s",
        }}
      />
      {/* Name */}
      <span
        style={{
          fontSize: 11,
          color: "var(--text-primary)",
          fontWeight: 500,
          maxWidth: 80,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {title}
      </span>
      {/* Close button — visible on hover */}
      {hovered && (
        <button
          onClick={handleClose}
          style={{
            marginLeft: 2,
            width: 14,
            height: 14,
            padding: 0,
            background: "none",
            border: "none",
            color: "var(--text-dim)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 3,
            flexShrink: 0,
          }}
          title="Close"
        >
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
            <line x1="1" y1="1" x2="7" y2="7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            <line x1="7" y1="1" x2="1" y2="7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
./scripts/check.sh
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/StashChip.tsx
git commit -m "feat(stash-dock): StashChip component with activity dot"
```

---

### Task 5: Create StashDock component

**Files:**
- Create: `src/components/StashDock.tsx`

Positioned absolutely at the bottom of the flight canvas. Only renders when there are stashed pods. Uses frosted glass style matching the rest of Rally's popovers.

- [ ] **Step 1: Create the file**

```tsx
// src/components/StashDock.tsx
import React, { useMemo } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { StashChip } from "./StashChip";

interface StashDockProps {
  workspaceId: string;
}

export function StashDock({ workspaceId }: StashDockProps) {
  const stashedIds = useWorkspaceStore((s) => {
    const pods = s.flightLayouts[workspaceId]?.pods;
    if (!pods) return "";
    return pods
      .filter((p) => p.stashed)
      .map((p) => p.id)
      .join("\n");
  });

  const stashedPodIds = useMemo(
    () => (stashedIds ? stashedIds.split("\n") : []),
    [stashedIds],
  );

  if (stashedPodIds.length === 0) return null;

  return (
    <div
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        height: 40,
        zIndex: 9000,
        display: "flex",
        alignItems: "center",
        paddingLeft: 12,
        paddingRight: 12,
        gap: 6,
        background: "rgba(36, 36, 36, 0.78)",
        backdropFilter: "blur(20px) saturate(180%)",
        WebkitBackdropFilter: "blur(20px) saturate(180%)",
        borderTop: "1px solid rgba(255, 255, 255, 0.10)",
        overflowX: "auto",
        overflowY: "hidden",
      }}
    >
      <span
        style={{
          fontSize: 10,
          color: "var(--text-dim)",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          flexShrink: 0,
          marginRight: 4,
        }}
      >
        Stashed
      </span>
      {stashedPodIds.map((podId) => (
        <StashChip key={podId} podId={podId} workspaceId={workspaceId} />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
./scripts/check.sh
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/StashDock.tsx
git commit -m "feat(stash-dock): StashDock container component"
```

---

### Task 6: Wire FlightCanvas — filter stashed pods + render dock

**Files:**
- Modify: `src/components/FlightCanvas.tsx`

Four changes in `WorkspaceFlightView`:
1. Filter `stashed` pods from `podIdList` (so they don't render in the viewport)
2. Add `stashedPodIdList` for conditional rendering
3. Add `dockHeightRef` and adjust `focusPodHeight`
4. Render `<StashDock>` at the bottom of the canvas

- [ ] **Step 1: Filter stashed pods from podIdList**

In `WorkspaceFlightView`, find the `podIds` selector (~line 49) and add the stash filter:

```ts
// BEFORE (~line 49):
  const podIds = useWorkspaceStore((s) => {
    const pods = s.flightLayouts[workspaceId]?.pods;
    if (!pods) return "";
    return pods.map((p) => p.id).join("\n");
  });

// AFTER:
  const podIds = useWorkspaceStore((s) => {
    const pods = s.flightLayouts[workspaceId]?.pods;
    if (!pods) return "";
    return pods.filter((p) => !p.stashed).map((p) => p.id).join("\n");
  });

  // Stashed pods — separate selector for dock rendering
  const stashedPodIds = useWorkspaceStore((s) => {
    const pods = s.flightLayouts[workspaceId]?.pods;
    if (!pods) return "";
    return pods.filter((p) => p.stashed).map((p) => p.id).join("\n");
  });
  const stashedPodIdList = useMemo(
    () => (stashedPodIds ? stashedPodIds.split("\n") : []),
    [stashedPodIds],
  );
```

- [ ] **Step 2: Add dockHeightRef and adjust focusPodHeight**

After the `containerSize` state declaration (~line 76), add `dockHeightRef`:

```ts
// After: const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
const DOCK_HEIGHT = 40;
const dockHeightRef = useRef(0);
dockHeightRef.current = stashedPodIdList.length > 0 ? DOCK_HEIGHT : 0;
```

Then update `focusPodHeight` (currently ~line 114) to subtract dock height:

```ts
// BEFORE:
  const focusPodHeight = useMemo(() => {
    if (!focusMode || containerSize.h === 0) return undefined;
    const GAP = 8;
    const PAD = 12;
    const HUD_HEIGHT = 35;
    return Math.floor(containerSize.h - HUD_HEIGHT - PAD * 2);
  }, [focusMode, containerSize.h]);

// AFTER:
  const hasSStashedPods = stashedPodIdList.length > 0;
  const focusPodHeight = useMemo(() => {
    if (!focusMode || containerSize.h === 0) return undefined;
    const GAP = 8;
    const PAD = 12;
    const HUD_HEIGHT = 35;
    return Math.floor(containerSize.h - HUD_HEIGHT - PAD * 2 - (hasSStashedPods ? DOCK_HEIGHT : 0));
  }, [focusMode, containerSize.h, hasSStashedPods]);
```

- [ ] **Step 3: Adjust navigateToPod availH to account for dock**

In `navigateToPod` (~line 530), update `availH`:

```ts
// BEFORE:
        const availH = containerH - HUD_HEIGHT - PAD * 2;

// AFTER:
        const availH = containerH - HUD_HEIGHT - PAD * 2 - dockHeightRef.current;
```

- [ ] **Step 4: Add StashDock import and render it**

At the top of the file, add the import:

```ts
import { StashDock } from "./StashDock";
```

In the JSX return (~line 1088, just before the `{contextMenu && ...}` portal), add the dock:

```tsx
      {/* Stash dock — rendered when pods are stashed */}
      <StashDock workspaceId={workspaceId} />
```

- [ ] **Step 5: Type-check**

```bash
./scripts/check.sh
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/FlightCanvas.tsx
git commit -m "feat(stash-dock): filter stashed pods from canvas + render StashDock"
```

---

### Task 7: Add shift+click handler to stash a pod

**Files:**
- Modify: `src/components/FlightCanvas.tsx`

The canvas has a `clickTracker` in its `mousedown` capture phase listener (~line 166). Add shift+click detection at the top of that handler before the existing pod-focus logic.

- [ ] **Step 1: Add shift+click logic to clickTracker**

Find `clickTracker` (~line 166):

```ts
// BEFORE:
    const clickTracker = (e: MouseEvent) => {
      const podEl = (e.target as HTMLElement).closest("[data-flight-pod]");
      if (podEl) {
        canvasFocused = false;
        el.classList.remove("flight-panning");
        // Track clicked pod as the active pod for Cmd+N / Shift+Arrow nav
        const podId = podEl.getAttribute("data-flight-pod");
        if (podId) focusedPodIdRef.current = podId;
      } else {

// AFTER:
    const clickTracker = (e: MouseEvent) => {
      const podEl = (e.target as HTMLElement).closest("[data-flight-pod]");
      if (podEl) {
        // Shift+click: stash the pod
        if (e.shiftKey) {
          const stashId = podEl.getAttribute("data-flight-pod");
          if (stashId) {
            e.preventDefault();
            e.stopPropagation();
            useWorkspaceStore.getState().stashPod(workspaceId, stashId);
          }
          return;
        }
        canvasFocused = false;
        el.classList.remove("flight-panning");
        // Track clicked pod as the active pod for Cmd+N / Shift+Arrow nav
        const podId = podEl.getAttribute("data-flight-pod");
        if (podId) focusedPodIdRef.current = podId;
      } else {
```

- [ ] **Step 2: Also filter stashed pods from navigateToPod's allPods**

In `navigateToPod` (~line 500), filter stashed pods so focus mode doesn't lay them out:

```ts
// BEFORE:
        const allPods = store.flightLayouts[workspaceId]?.pods ?? [];

// AFTER:
        const allPods = (store.flightLayouts[workspaceId]?.pods ?? []).filter((p) => !p.stashed);
```

There are two occurrences of `allPods` construction inside `navigateToPod` — one at ~line 500 (focus mode layout) and one that's part of the orphan check. Find only the one in the focus mode layout block (`const allPods = store.flightLayouts[workspaceId]?.pods ?? [];` at the start of the focus mode branch, just after `const HUD_HEIGHT = 35;`).

- [ ] **Step 3: Type-check**

```bash
./scripts/check.sh
```

Expected: no errors.

- [ ] **Step 4: Reload and manually test**

```bash
./scripts/reload.sh
```

Test sequence:
1. Open Rally, switch to a workspace with multiple Flight Mode pods.
2. Shift+click a pod → it should disappear from the grid and a "Stashed" dock strip appears at the bottom with a chip for that pod.
3. Click the chip → the pod returns to the canvas.
4. Shift+click another pod → dock shows both chips.
5. Click ×on a chip → pod is permanently removed (no restore).
6. Cmd+4 → focus mode should show only the non-stashed pods.
7. Stash all pods → canvas should be empty, dock shows all chips.

- [ ] **Step 5: Commit**

```bash
git add src/components/FlightCanvas.tsx
git commit -m "feat(stash-dock): shift+click to stash, filter from focus mode layout"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|-----------------|------|
| Shift+click stashes a pod | Task 7 |
| Stashed pod stays stashed through Cmd+N | Task 6 + 7 (filtered from allPods in navigateToPod) |
| Bottom dock strip, visible only when ≥1 stashed | Task 5 |
| Activity dot (grey/active) | Task 4 |
| Click chip → restore | StashChip `handleRestore` |
| × button → close for real (kill PTY) | StashChip `handleClose` calls `removeFlightPod` |
| Stash persists to JSON | `stashed` field on pod, lives in existing `flightLayouts` JSON |
| Focus mode height accounts for dock | Task 6, `focusPodHeight` and `navigateToPod` availH |
| Frosted glass dock style | Task 5 |

**Placeholder scan:** None found.

**Type consistency:** `stashPod`/`unstashPod` interface signatures in Task 3 match usage in Task 7 (`useWorkspaceStore.getState().stashPod(workspaceId, stashId)`). `StashChip` and `StashDock` both take `workspaceId: string`, matching how `WorkspaceFlightView` passes them. `ptyLastOutputAt` exported in Task 2, imported in Task 4. `removeFlightPod` is already in the store interface — no new type needed for StashChip's close action.

**One edge case to verify during testing:** The `Shift+Arrow` keyboard shortcut (Task 7 area) also uses `e.shiftKey` — but it's gated to `!e.metaKey` arrow keys in the `navHandler`, not `clickTracker`, so there's no conflict.
