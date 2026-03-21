# Flight Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Rally's static split-panel layout with an infinite canvas ("Flight Mode") where terminal pods float freely with pan/zoom.

**Architecture:** New `FlightCanvas` component replaces `PaneLayout` in the render tree. Pods are absolutely-positioned divs inside a CSS-transformed viewport container. Store adds a `flightLayouts` slice for per-workspace pod state. All existing backend code and sidebar UI unchanged.

**Tech Stack:** React 19, Zustand 5, xterm.js 6 (WebGL), Tauri v2 window vibrancy, CSS `transform: translate3d + scale` for GPU-composited pan/zoom.

**Spec:** `docs/superpowers/specs/2026-03-21-flight-mode-design.md`

---

## File Map

### New Files
| File | Responsibility |
|------|---------------|
| `src/components/FlightCanvas.tsx` | Canvas container, wheel events (pan/zoom), vibrancy background, viewport visibility tracking |
| `src/components/FlightPod.tsx` | Pod chrome (header, resize handles), positioning, hosts Terminal, drag logic |
| `src/components/FlightHUD.tsx` | Fixed overlay: zoom %, add pod buttons |

### Modified Files
| File | Changes |
|------|---------|
| `src/lib/types.ts` | Add `FlightPod`, `FlightViewport`, `FlightLayout` types |
| `src/stores/workspaceStore.ts` | Add `flightLayouts`, `flightNextZIndex` state + actions, persistence |
| `src/App.tsx` | Replace `<PaneLayout />` with `<FlightCanvas />` (~line 2076) |
| `src-tauri/tauri.conf.json` | Add `transparent: true` + `windowEffects` for vibrancy |

### Unchanged (reused as-is)
| File | Role |
|------|------|
| `src/components/Terminal.tsx` | xterm.js terminal — mounted inside pods |
| `src/components/ClaudeTerminalWrapper.tsx` | Claude startup overlay — used for Claude pods |
| `src/components/TerminalLauncher.tsx` | May be reused for the claude-launcher state inside pods |
| `src/components/BuildStatusBar.tsx` | Fixed footer — stays below canvas |
| `src/components/BuildStatusDrawer.tsx` | Script output drawer — stays in place |

---

## Task 1: Add Flight Mode Types

**Files:**
- Modify: `src/lib/types.ts` (append after line 556, after `createDefaultLayout`)

- [ ] **Step 1: Add Flight Mode type definitions**

Add to the end of `src/lib/types.ts`:

```typescript
// --- Flight Mode Types ---

/** Base spatial properties shared by all pods */
export interface FlightPodBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  cwd: string;
  title: string;
  ptyId?: string;
  zIndex: number;
}

/** Claude Code pod — has an optional attached shell */
export interface FlightClaudePod extends FlightPodBase {
  type: "claude";
  shellExpanded: boolean;
  shellHeight: number;
  shellPtyId?: string;
}

/** Standalone terminal pod */
export interface FlightTerminalPod extends FlightPodBase {
  type: "terminal";
}

export type FlightPod = FlightClaudePod | FlightTerminalPod;

export interface FlightViewport {
  panX: number;
  panY: number;
  zoom: number;
}

export interface FlightLayout {
  pods: FlightPod[];
  viewport: FlightViewport;
}

// Flight Mode constants
export const FLIGHT_DEFAULT_CLAUDE_WIDTH = 700;
export const FLIGHT_DEFAULT_CLAUDE_HEIGHT = 500;
export const FLIGHT_DEFAULT_TERMINAL_WIDTH = 500;
export const FLIGHT_DEFAULT_TERMINAL_HEIGHT = 300;
export const FLIGHT_MIN_CLAUDE_WIDTH = 400;
export const FLIGHT_MIN_CLAUDE_HEIGHT = 250;
export const FLIGHT_MIN_TERMINAL_WIDTH = 300;
export const FLIGHT_MIN_TERMINAL_HEIGHT = 150;
export const FLIGHT_DEFAULT_SHELL_HEIGHT = 200;
export const FLIGHT_ZOOM_MIN = 0.3;
export const FLIGHT_ZOOM_MAX = 2.0;
```

- [ ] **Step 2: Verify types compile**

Run: `./scripts/check.sh`
Expected: No TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(flight): add Flight Mode type definitions"
```

---

## Task 2: Add Flight Mode Store Slice

**Files:**
- Modify: `src/stores/workspaceStore.ts`

This task adds the Flight Mode state and actions to the existing Zustand store. The key patterns to follow:
- State fields go in the store's state type
- Actions are defined inside the `create()` call
- Persisted fields must be added to `PersistedWorkspaceState`, `PersistRefs`, `buildRefs()`, and `sameRefs()`

- [ ] **Step 1: Add Flight Mode state fields to the store**

In `workspaceStore.ts`, find the state type (look for fields like `layouts: Record<string, WorkspaceLayout>`) and add:

```typescript
flightLayouts: Record<string, FlightLayout>;
flightNextZIndex: Record<string, number>;
```

Initialize both as `{}` in the store's initial state.

- [ ] **Step 2: Add `flightLayouts` to persistence**

Add `flightLayouts` to ALL SIX persistence integration points:
1. The `PersistedWorkspaceState` type (~line 134)
2. The `PersistRefs` type inside `workspacePersistStorage` (~line 150)
3. The `buildRefs()` function (~line 172)
4. The `sameRefs()` function (~line 192)
5. The `partialize` option in the `persist()` middleware call
6. **The `merge` function** — find where persisted state is merged back into the store on startup. Without this, `flightLayouts` will be silently dropped on restart.

**Do NOT persist `flightNextZIndex`.** Instead, recalculate it from saved pods on restore:
```typescript
// In getOrCreateFlightLayout or during merge:
const maxZ = Math.max(0, ...layout.pods.map(p => p.zIndex));
// Set flightNextZIndex[workspaceId] = maxZ + 1
```

This ensures pod positions survive app restart.

- [ ] **Step 3: Add `getOrCreateFlightLayout` action**

```typescript
getOrCreateFlightLayout: (workspaceId: string): FlightLayout => {
  const existing = get().flightLayouts[workspaceId];
  if (existing) return existing;

  const ws = get().workspaces.find((w) => w.id === workspaceId);
  const idx = get().activePathIndex[workspaceId] ?? 0;
  const cwd = ws?.paths[idx] ?? ws?.paths[0] ?? "";
  const podId = crypto.randomUUID();

  const layout: FlightLayout = {
    pods: [{
      id: podId,
      type: "claude",
      x: 100,
      y: 100,
      width: FLIGHT_DEFAULT_CLAUDE_WIDTH,
      height: FLIGHT_DEFAULT_CLAUDE_HEIGHT,
      cwd,
      title: cwd.split("/").pop() || "Claude Code",
      zIndex: 1,
      shellExpanded: false,
      shellHeight: FLIGHT_DEFAULT_SHELL_HEIGHT,
    }],
    viewport: { panX: 0, panY: 0, zoom: 1.0 },
  };

  set((s) => ({
    flightLayouts: { ...s.flightLayouts, [workspaceId]: layout },
    flightNextZIndex: { ...s.flightNextZIndex, [workspaceId]: 2 },
  }));
  return layout;
},
```

- [ ] **Step 4: Add `addFlightPod` action**

```typescript
addFlightPod: (workspaceId: string, type: "claude" | "terminal") => {
  const layout = get().getOrCreateFlightLayout(workspaceId);
  const nextZ = (get().flightNextZIndex[workspaceId] ?? 1) + 1;
  const ws = get().workspaces.find((w) => w.id === workspaceId);
  const idx = get().activePathIndex[workspaceId] ?? 0;
  const cwd = ws?.paths[idx] ?? ws?.paths[0] ?? "";

  // Place at center of current viewport, offset to avoid stacking
  const vp = layout.viewport;
  const offsetIndex = layout.pods.length;
  const staggerX = (offsetIndex % 5) * 40;
  const staggerY = (offsetIndex % 5) * 40;

  const isClaudeType = type === "claude";
  const width = isClaudeType ? FLIGHT_DEFAULT_CLAUDE_WIDTH : FLIGHT_DEFAULT_TERMINAL_WIDTH;
  const height = isClaudeType ? FLIGHT_DEFAULT_CLAUDE_HEIGHT : FLIGHT_DEFAULT_TERMINAL_HEIGHT;

  const pod: FlightPod = isClaudeType ? {
    id: crypto.randomUUID(),
    type: "claude",
    x: -vp.panX / vp.zoom + 100 + staggerX,
    y: -vp.panY / vp.zoom + 100 + staggerY,
    width,
    height,
    cwd,
    title: cwd.split("/").pop() || "Claude Code",
    zIndex: nextZ,
    shellExpanded: false,
    shellHeight: FLIGHT_DEFAULT_SHELL_HEIGHT,
  } : {
    id: crypto.randomUUID(),
    type: "terminal",
    x: -vp.panX / vp.zoom + 100 + staggerX,
    y: -vp.panY / vp.zoom + 100 + staggerY,
    width,
    height,
    cwd,
    title: cwd.split("/").pop() || "Terminal",
    zIndex: nextZ,
  };

  set((s) => ({
    flightLayouts: {
      ...s.flightLayouts,
      [workspaceId]: {
        ...layout,
        pods: [...layout.pods, pod],
      },
    },
    flightNextZIndex: { ...s.flightNextZIndex, [workspaceId]: nextZ },
  }));
},
```

- [ ] **Step 5: Add `removeFlightPod` action**

```typescript
removeFlightPod: (workspaceId: string, podId: string) => {
  const layout = get().flightLayouts[workspaceId];
  if (!layout) return;
  const pod = layout.pods.find((p) => p.id === podId);
  // Kill PTYs
  if (pod?.ptyId) api.killPty(pod.ptyId).catch(() => {});
  if (pod?.type === "claude" && pod.shellPtyId) {
    api.killPty(pod.shellPtyId).catch(() => {});
  }
  set((s) => ({
    flightLayouts: {
      ...s.flightLayouts,
      [workspaceId]: {
        ...layout,
        pods: layout.pods.filter((p) => p.id !== podId),
      },
    },
  }));
},
```

- [ ] **Step 6: Add `updateFlightPod` action**

```typescript
updateFlightPod: (workspaceId: string, podId: string, updates: Partial<FlightPod>) => {
  const layout = get().flightLayouts[workspaceId];
  if (!layout) return;
  set((s) => ({
    flightLayouts: {
      ...s.flightLayouts,
      [workspaceId]: {
        ...layout,
        pods: layout.pods.map((p) =>
          p.id === podId ? { ...p, ...updates } : p
        ),
      },
    },
  }));
},
```

- [ ] **Step 7: Add `setFlightViewport` action**

Use the functional `set()` form to avoid stale state during rapid scrolling:

```typescript
setFlightViewport: (workspaceId: string, viewport: Partial<FlightViewport>) => {
  set((s) => {
    const layout = s.flightLayouts[workspaceId];
    if (!layout) return {};
    return {
      flightLayouts: {
        ...s.flightLayouts,
        [workspaceId]: {
          ...layout,
          viewport: { ...layout.viewport, ...viewport },
        },
      },
    };
  });
},
```

- [ ] **Step 8: Add `bringPodToFront` action**

```typescript
bringPodToFront: (workspaceId: string, podId: string) => {
  const layout = get().flightLayouts[workspaceId];
  if (!layout) return;
  const nextZ = (get().flightNextZIndex[workspaceId] ?? 1) + 1;
  set((s) => ({
    flightLayouts: {
      ...s.flightLayouts,
      [workspaceId]: {
        ...layout,
        pods: layout.pods.map((p) =>
          p.id === podId ? { ...p, zIndex: nextZ } : p
        ),
      },
    },
    flightNextZIndex: { ...s.flightNextZIndex, [workspaceId]: nextZ },
  }));
},
```

- [ ] **Step 9: Add `togglePodShell` action**

```typescript
togglePodShell: (workspaceId: string, podId: string) => {
  const layout = get().flightLayouts[workspaceId];
  if (!layout) return;
  set((s) => ({
    flightLayouts: {
      ...s.flightLayouts,
      [workspaceId]: {
        ...layout,
        pods: layout.pods.map((p) => {
          if (p.id !== podId || p.type !== "claude") return p;
          return { ...p, shellExpanded: !p.shellExpanded };
        }),
      },
    },
  }));
},
```

- [ ] **Step 10: Verify store compiles**

Run: `./scripts/check.sh`
Expected: No TypeScript errors.

- [ ] **Step 11: Commit**

```bash
git add src/stores/workspaceStore.ts
git commit -m "feat(flight): add Flight Mode store slice with pod CRUD and persistence"
```

---

## Task 3: Enable Window Vibrancy

**Files:**
- Modify: `src-tauri/tauri.conf.json`

**Important:** This is a Tauri config change — requires full rebuild via `./scripts/run.sh`, NOT hot-reload.

- [ ] **Step 1: Add transparency and vibrancy to window config**

In `src-tauri/tauri.conf.json`, update the window object inside `app.windows[0]`:

```json
{
  "title": "Rally",
  "width": 1400,
  "height": 900,
  "resizable": true,
  "fullscreen": false,
  "decorations": true,
  "titleBarStyle": "Overlay",
  "hiddenTitle": true,
  "acceptFirstMouse": true,
  "transparent": true
}
```

Also add at the top level of the config (sibling to `app`):

```json
"app": {
  "windows": [{
    ...existing config...,
    "transparent": true
  }],
  ...rest of app config...
}
```

Note: Tauri v2 window vibrancy may need to be set programmatically in Rust via `window.set_effects()` if the JSON config doesn't support `windowEffects` directly. Check Tauri v2 docs. The fallback approach is to add this in `main.rs`:

```rust
use tauri::window::Effect;
// After window creation:
window.set_effects(tauri::utils::config::WindowEffectsConfig {
    effects: vec![Effect::UnderWindow],
    state: None,
    radius: None,
    color: None,
}).ok();
```

- [ ] **Step 2: Build and test vibrancy**

Run: `./scripts/run.sh`
Expected: App launches with translucent window. You should be able to see a blurred version of the desktop behind the app. If the window is fully opaque, the vibrancy config needs adjustment (see fallback in Step 1).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tauri.conf.json src-tauri/src/main.rs
git commit -m "feat(flight): enable window transparency and vibrancy"
```

---

## Task 4: Create FlightCanvas Component

**Files:**
- Create: `src/components/FlightCanvas.tsx`

This is the core canvas component. It handles:
1. Transparent background (lets vibrancy show through)
2. Wheel events for pan and zoom
3. Rendering the viewport container with CSS transform
4. Rendering pods for the active workspace

- [ ] **Step 1: Create FlightCanvas.tsx**

**Critical patterns applied:**
- Uses native `addEventListener("wheel", ..., { passive: false })` — React synthetic wheel events are passive and cannot call `preventDefault()`
- Renders ALL workspaces with `display: none` toggling (not conditional mount/unmount) — prevents xterm destruction on workspace switch (per PITFALLS.md)
- Clicks on empty canvas deselect focused pod

```typescript
import React, { useEffect, useRef, useMemo } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { FlightPod } from "./FlightPod";
import { FlightHUD } from "./FlightHUD";
import { FLIGHT_ZOOM_MIN, FLIGHT_ZOOM_MAX } from "../lib/types";

/** Renders a single workspace's flight canvas. Hidden via display:none when inactive. */
const WorkspaceFlightView = React.memo(function WorkspaceFlightView({
  workspaceId,
  isActive,
}: {
  workspaceId: string;
  isActive: boolean;
}) {
  const getOrCreateFlightLayout = useWorkspaceStore((s) => s.getOrCreateFlightLayout);
  const setFlightViewport = useWorkspaceStore((s) => s.setFlightViewport);
  const containerRef = useRef<HTMLDivElement>(null);

  // Stable selectors — avoid returning new objects
  const viewport = useWorkspaceStore((s) => s.flightLayouts[workspaceId]?.viewport);
  const podIds = useWorkspaceStore((s) => {
    const pods = s.flightLayouts[workspaceId]?.pods;
    if (!pods) return "";
    return pods.map((p) => p.id).join("\n");
  });
  const podIdList = useMemo(
    () => (podIds ? podIds.split("\n") : []),
    [podIds]
  );

  // Ensure layout exists
  useEffect(() => {
    getOrCreateFlightLayout(workspaceId);
  }, [workspaceId, getOrCreateFlightLayout]);

  // Native wheel listener — MUST be non-passive to call preventDefault()
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const store = useWorkspaceStore.getState();
      const vp = store.flightLayouts[workspaceId]?.viewport;
      if (!vp) return;

      if (e.altKey) {
        // Zoom toward cursor
        const zoomFactor = 1 - e.deltaY * 0.002;
        const newZoom = Math.max(FLIGHT_ZOOM_MIN, Math.min(FLIGHT_ZOOM_MAX, vp.zoom * zoomFactor));
        const rect = el.getBoundingClientRect();
        const cursorX = e.clientX - rect.left;
        const cursorY = e.clientY - rect.top;
        store.setFlightViewport(workspaceId, {
          panX: cursorX - (cursorX - vp.panX) * (newZoom / vp.zoom),
          panY: cursorY - (cursorY - vp.panY) * (newZoom / vp.zoom),
          zoom: newZoom,
        });
      } else {
        // Pan
        store.setFlightViewport(workspaceId, {
          panX: vp.panX - e.deltaX,
          panY: vp.panY - e.deltaY,
        });
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [workspaceId, setFlightViewport]);

  const vp = viewport ?? { panX: 0, panY: 0, zoom: 1.0 };

  return (
    <div
      ref={containerRef}
      style={{
        ...styles.canvas,
        display: isActive ? "flex" : "none",
      }}
    >
      <div
        style={{
          ...styles.viewport,
          transform: `translate3d(${vp.panX}px, ${vp.panY}px, 0) scale(${vp.zoom})`,
          transformOrigin: "0 0",
        }}
      >
        {podIdList.map((podId) => (
          <FlightPod
            key={podId}
            podId={podId}
            workspaceId={workspaceId}
            zoom={vp.zoom}
          />
        ))}
      </div>
      {isActive && <FlightHUD workspaceId={workspaceId} zoom={vp.zoom} />}
    </div>
  );
});

export function FlightCanvas() {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const hasActiveWorkspace = useWorkspaceStore(
    (s) => !!s.activeWorkspaceId && s.workspaces.some((w) => w.id === s.activeWorkspaceId)
  );

  // Mount all workspaces that have flight layouts + active workspace
  // Same pattern as PaneLayout's WorkspaceLayoutView
  const mountedIdsString = useWorkspaceStore((s) => {
    const wsIds = new Set(s.workspaces.map((w) => w.id));
    const ids = new Set<string>();
    for (const id of Object.keys(s.flightLayouts)) {
      if (wsIds.has(id)) ids.add(id);
    }
    if (s.activeWorkspaceId && wsIds.has(s.activeWorkspaceId)) {
      ids.add(s.activeWorkspaceId);
    }
    return Array.from(ids).join("\n");
  });
  const mountedIds = useMemo(
    () => (mountedIdsString ? mountedIdsString.split("\n") : []),
    [mountedIdsString]
  );

  if (!hasActiveWorkspace) {
    return (
      <div style={styles.empty}>
        <div style={styles.emptyText}>
          No workspace selected.<br />
          Add a workspace from the sidebar to get started.
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {mountedIds.map((wsId) => (
        <WorkspaceFlightView
          key={wsId}
          workspaceId={wsId}
          isActive={wsId === activeWorkspaceId}
        />
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    display: "flex",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    position: "relative",
  },
  canvas: {
    flex: 1,
    position: "relative",
    overflow: "hidden",
    background: "transparent",
    cursor: "default",
  },
  viewport: {
    position: "absolute",
    top: 0,
    left: 0,
    willChange: "transform",
  },
  empty: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    textAlign: "center" as const,
    color: "var(--text-dim)",
    fontSize: 14,
    lineHeight: 1.6,
  },
};
```

- [ ] **Step 2: Verify it compiles**

Run: `./scripts/check.sh`
Expected: May fail because `FlightPod` and `FlightHUD` components don't exist yet — that's OK, proceed to next tasks.

- [ ] **Step 3: Commit**

```bash
git add src/components/FlightCanvas.tsx
git commit -m "feat(flight): create FlightCanvas component with pan/zoom"
```

---

## Task 5: Create FlightPod Component

**Files:**
- Create: `src/components/FlightPod.tsx`

This is the floating pod — positioned absolutely in canvas space. Handles:
1. Pod chrome (header with drag handle, close button, shell toggle)
2. Terminal rendering (reuses existing `Terminal.tsx` and `ClaudeTerminalWrapper.tsx`)
3. Drag (via mousedown on header)
4. Resize (via mousedown on bottom-right corner grip)
5. Focus management (click brings to front)

- [ ] **Step 1: Create FlightPod.tsx**

```typescript
import React, { useCallback, useRef, useState } from "react";
import { Terminal } from "./Terminal";
import { ClaudeTerminalWrapper } from "./ClaudeTerminalWrapper";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { FlightPod as FlightPodType } from "../lib/types";
import {
  FLIGHT_MIN_CLAUDE_WIDTH,
  FLIGHT_MIN_CLAUDE_HEIGHT,
  FLIGHT_MIN_TERMINAL_WIDTH,
  FLIGHT_MIN_TERMINAL_HEIGHT,
} from "../lib/types";
import type { OnFileOpen } from "../lib/terminalLinkProvider";

interface FlightPodProps {
  podId: string;
  workspaceId: string;
  zoom: number;
}

/**
 * FlightPod selects its OWN data from the store (not passed as prop from parent).
 * This prevents all pods from re-rendering when the canvas pans/zooms, because
 * the parent's layout selector changes on every viewport update but individual
 * pod data only changes when THAT pod moves/resizes.
 */
export const FlightPod = React.memo(function FlightPod({
  podId,
  workspaceId,
  zoom,
}: FlightPodProps) {
  const pod = useWorkspaceStore((s) => {
    const layout = s.flightLayouts[workspaceId];
    if (!layout) return null;
    return layout.pods.find((p) => p.id === podId) ?? null;
  });

  if (!pod) return null;
  const updateFlightPod = useWorkspaceStore((s) => s.updateFlightPod);
  const removeFlightPod = useWorkspaceStore((s) => s.removeFlightPod);
  const bringPodToFront = useWorkspaceStore((s) => s.bringPodToFront);
  const togglePodShell = useWorkspaceStore((s) => s.togglePodShell);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const dragRef = useRef({ startX: 0, startY: 0, podX: 0, podY: 0 });
  const resizeRef = useRef({ startX: 0, startY: 0, w: 0, h: 0 });

  const minW = pod.type === "claude" ? FLIGHT_MIN_CLAUDE_WIDTH : FLIGHT_MIN_TERMINAL_WIDTH;
  const minH = pod.type === "claude" ? FLIGHT_MIN_CLAUDE_HEIGHT : FLIGHT_MIN_TERMINAL_HEIGHT;

  const podRef = useRef<HTMLDivElement>(null);

  const handlePointerDown = useCallback(() => {
    bringPodToFront(workspaceId, pod.id);
    // Focus the xterm textarea inside this pod
    const textarea = podRef.current?.querySelector("textarea.xterm-helper-textarea") as HTMLTextAreaElement | null;
    if (textarea) textarea.focus();
  }, [bringPodToFront, workspaceId, pod.id]);

  // --- Drag ---
  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        podX: pod.x,
        podY: pod.y,
      };
      setIsDragging(true);
      bringPodToFront(workspaceId, pod.id);

      // Disable pointer events on other pods during drag for performance
      document.querySelectorAll("[data-flight-pod]").forEach((el) => {
        if ((el as HTMLElement).dataset.flightPod !== pod.id) {
          (el as HTMLElement).style.pointerEvents = "none";
        }
      });

      const onMove = (ev: MouseEvent) => {
        const dx = (ev.clientX - dragRef.current.startX) / zoom;
        const dy = (ev.clientY - dragRef.current.startY) / zoom;
        updateFlightPod(workspaceId, pod.id, {
          x: dragRef.current.podX + dx,
          y: dragRef.current.podY + dy,
        });
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        setIsDragging(false);
        // Restore pointer events
        document.querySelectorAll("[data-flight-pod]").forEach((el) => {
          (el as HTMLElement).style.pointerEvents = "";
        });
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp, { once: true });
    },
    [pod.id, pod.x, pod.y, zoom, workspaceId, updateFlightPod, bringPodToFront]
  );

  // --- Resize ---
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      resizeRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        w: pod.width,
        h: pod.height,
      };
      setIsResizing(true);

      const onMove = (ev: MouseEvent) => {
        const dx = (ev.clientX - resizeRef.current.startX) / zoom;
        const dy = (ev.clientY - resizeRef.current.startY) / zoom;
        updateFlightPod(workspaceId, pod.id, {
          width: Math.max(minW, resizeRef.current.w + dx),
          height: Math.max(minH, resizeRef.current.h + dy),
        });
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        setIsResizing(false);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp, { once: true });
    },
    [pod.id, pod.width, pod.height, zoom, workspaceId, minW, minH, updateFlightPod]
  );

  // --- PTY callbacks ---
  const handlePtySpawned = useCallback(
    (ptyId: string) => {
      updateFlightPod(workspaceId, pod.id, { ptyId });
    },
    [workspaceId, pod.id, updateFlightPod]
  );

  const handleCwdChanged = useCallback(
    (cwd: string) => {
      updateFlightPod(workspaceId, pod.id, { cwd, title: cwd.split("/").pop() || pod.title });
    },
    [workspaceId, pod.id, pod.title, updateFlightPod]
  );

  const handleFileOpen: OnFileOpen = useCallback(() => {
    // TODO: file open handling in Flight Mode (future: editor pods)
  }, []);

  const shellExpanded = pod.type === "claude" && pod.shellExpanded;
  const shellHeight = pod.type === "claude" ? pod.shellHeight : 0;
  const totalHeight = pod.height + (shellExpanded ? shellHeight : 0);

  return (
    <div
      ref={podRef}
      className="no-select"
      data-flight-pod={pod.id}
      style={{
        position: "absolute",
        left: pod.x,
        top: pod.y,
        width: pod.width,
        height: totalHeight,
        zIndex: pod.zIndex,
        borderRadius: 10,
        background: "rgba(20, 20, 20, 0.85)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        cursor: isDragging ? "grabbing" : isResizing ? "nwse-resize" : "default",
      }}
      onPointerDown={handlePointerDown}
    >
      {/* --- Pod Header (drag handle) --- */}
      <div
        style={podStyles.header}
        onMouseDown={handleDragStart}
      >
        <div style={podStyles.headerLeft}>
          {pod.type === "claude" ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="#999" style={{ flexShrink: 0 }}>
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
            </svg>
          ) : (
            <span style={{ color: "#999", fontSize: 13, fontFamily: "monospace", flexShrink: 0 }}>
              {">"}_
            </span>
          )}
          <span style={podStyles.title}>{pod.title}</span>
        </div>
        <div style={podStyles.headerRight}>
          {pod.type === "claude" && (
            <button
              className="sidebar-btn"
              style={podStyles.headerBtn}
              onClick={(e) => {
                e.stopPropagation();
                togglePodShell(workspaceId, pod.id);
              }}
              title={shellExpanded ? "Collapse shell" : "Expand shell"}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path
                  d={shellExpanded ? "M2 4l4 4 4-4" : "M2 8l4-4 4 4"}
                  stroke="#999"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
          <button
            className="sidebar-btn"
            style={podStyles.headerBtn}
            onClick={(e) => {
              e.stopPropagation();
              removeFlightPod(workspaceId, pod.id);
            }}
            title="Close pod"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2 2l6 6M8 2l-6 6" stroke="#999" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* --- Terminal Body --- */}
      {/* background: var(--terminal-bg) prevents flash before xterm init (per PITFALLS.md) */}
      <div style={{ flex: 1, minHeight: 0, position: "relative", background: "var(--terminal-bg)" }}>
        {pod.type === "claude" ? (
          <ClaudeTerminalWrapper
            cwd={pod.cwd}
            command="claude"
            ptyId={pod.ptyId}
            workspaceId={workspaceId}
            onPtySpawned={handlePtySpawned}
            onCwdChanged={handleCwdChanged}
            onFileOpen={handleFileOpen}
          />
        ) : (
          <Terminal
            cwd={pod.cwd}
            ptyId={pod.ptyId}
            workspaceId={workspaceId}
            onPtySpawned={handlePtySpawned}
            onCwdChanged={handleCwdChanged}
            onFileOpen={handleFileOpen}
          />
        )}
      </div>

      {/* --- Attached Shell (Claude pods only) --- */}
      {/* CRITICAL: Use display:none, NEVER unmount Terminal components.
          Per PITFALLS.md, unmounting destroys xterm state (alternate screen buffer,
          cursor positioning) causing garbled output on remount. */}
      {pod.type === "claude" && (
        <div
          style={{
            height: shellExpanded ? shellHeight : 0,
            display: shellExpanded ? "flex" : "none",
            overflow: "hidden",
            borderTop: shellExpanded ? "1px solid rgba(255, 255, 255, 0.06)" : "none",
          }}
        >
          <Terminal
            cwd={pod.cwd}
            ptyId={pod.shellPtyId}
            workspaceId={workspaceId}
            onPtySpawned={(ptyId) =>
              updateFlightPod(workspaceId, pod.id, { shellPtyId: ptyId } as any)
            }
            onCwdChanged={() => {}}
            onFileOpen={handleFileOpen}
          />
        </div>
      )}

      {/* --- Resize Grip --- */}
      <div
        style={podStyles.resizeGrip}
        onMouseDown={handleResizeStart}
      />
    </div>
  );
});

const podStyles: Record<string, React.CSSProperties> = {
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    height: 32,
    minHeight: 32,
    padding: "0 8px 0 10px",
    cursor: "grab",
    userSelect: "none",
    borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
    flex: 1,
  },
  title: {
    fontSize: 12,
    fontWeight: 500,
    color: "#bbb",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: 2,
  },
  headerBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 22,
    background: "none",
    border: "none",
    cursor: "pointer",
    borderRadius: 4,
    padding: 0,
  },
  resizeGrip: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: 16,
    height: 16,
    cursor: "nwse-resize",
  },
};
```

- [ ] **Step 2: Verify it compiles**

Run: `./scripts/check.sh`
Expected: May have minor type issues to fix. The `shellPtyId` update uses `as any` — this is intentional because `updateFlightPod` takes `Partial<FlightPodBase>` but `shellPtyId` is only on `FlightClaudePod`. Refine the update function type if needed.

- [ ] **Step 3: Commit**

```bash
git add src/components/FlightPod.tsx
git commit -m "feat(flight): create FlightPod component with drag/resize/terminal"
```

---

## Task 6: Create FlightHUD Component

**Files:**
- Create: `src/components/FlightHUD.tsx`

Minimal HUD overlay — zoom percentage display and buttons to add pods.

- [ ] **Step 1: Create FlightHUD.tsx**

```typescript
import React from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";

interface FlightHUDProps {
  workspaceId: string;
  zoom: number;
}

export const FlightHUD = React.memo(function FlightHUD({
  workspaceId,
  zoom,
}: FlightHUDProps) {
  const addFlightPod = useWorkspaceStore((s) => s.addFlightPod);
  const setFlightViewport = useWorkspaceStore((s) => s.setFlightViewport);

  return (
    <div style={styles.hud}>
      <button
        className="sidebar-btn"
        style={styles.btn}
        onClick={() => addFlightPod(workspaceId, "claude")}
        title="Add Claude pod"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M6 2v8M2 6h8" stroke="#999" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <span style={styles.btnLabel}>Claude</span>
      </button>
      <button
        className="sidebar-btn"
        style={styles.btn}
        onClick={() => addFlightPod(workspaceId, "terminal")}
        title="Add terminal pod"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M6 2v8M2 6h8" stroke="#999" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <span style={styles.btnLabel}>Terminal</span>
      </button>
      <button
        className="sidebar-btn"
        style={styles.zoomBtn}
        onClick={() =>
          setFlightViewport(workspaceId, { panX: 0, panY: 0, zoom: 1.0 })
        }
        title="Reset zoom"
      >
        {Math.round(zoom * 100)}%
      </button>
    </div>
  );
});

const styles: Record<string, React.CSSProperties> = {
  hud: {
    position: "absolute",
    bottom: 8,
    right: 8,
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "4px 6px",
    borderRadius: 8,
    background: "rgba(36, 36, 36, 0.78)",
    backdropFilter: "blur(20px) saturate(180%)",
    border: "1px solid rgba(255, 255, 255, 0.12)",
    zIndex: 9999,
  },
  btn: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "4px 8px",
    background: "none",
    border: "none",
    color: "#999",
    fontSize: 11,
    cursor: "pointer",
    borderRadius: 4,
  },
  btnLabel: {
    fontSize: 11,
    color: "#999",
  },
  zoomBtn: {
    display: "flex",
    alignItems: "center",
    padding: "4px 8px",
    background: "none",
    border: "none",
    color: "#888",
    fontSize: 11,
    fontFamily: "monospace",
    cursor: "pointer",
    borderRadius: 4,
    minWidth: 40,
    justifyContent: "center",
  },
};
```

- [ ] **Step 2: Verify it compiles**

Run: `./scripts/check.sh`
Expected: Pass (or minor issues from earlier tasks).

- [ ] **Step 3: Commit**

```bash
git add src/components/FlightHUD.tsx
git commit -m "feat(flight): create FlightHUD with zoom display and add-pod buttons"
```

---

## Task 7: Wire FlightCanvas into App.tsx

**Files:**
- Modify: `src/App.tsx`

Replace `<PaneLayout />` with `<FlightCanvas />` in the main render tree.

- [ ] **Step 1: Add import**

At the top of `App.tsx`, add:

```typescript
import { FlightCanvas } from "./components/FlightCanvas";
```

- [ ] **Step 2: Replace PaneLayout with FlightCanvas**

Find the block around line 2065-2078:

```typescript
<div
  style={{
    display: isProductMode ? "none" : "flex",
    flex: 1,
    flexDirection: "column" as const,
    minWidth: 0,
    minHeight: 0,
    position: "relative" as const,
    overflow: "hidden",
  }}
>
  <PaneLayout />
  <BuildStatusDrawer />
</div>
```

Replace `<PaneLayout />` with `<FlightCanvas />`:

```typescript
<div
  style={{
    display: isProductMode ? "none" : "flex",
    flex: 1,
    flexDirection: "column" as const,
    minWidth: 0,
    minHeight: 0,
    position: "relative" as const,
    overflow: "hidden",
  }}
>
  <FlightCanvas />
  <BuildStatusDrawer />
</div>
```

The `PaneLayout` import can stay for now (deprecated but not removed yet).

- [ ] **Step 3: Verify it compiles**

Run: `./scripts/check.sh`
Expected: Pass — all types, store, and components should resolve.

- [ ] **Step 4: Build and test**

Run: `./scripts/run.sh` (need full rebuild because of vibrancy config change)
Expected: App launches. When you select a workspace, you see the Flight Mode canvas with one Claude pod floating on a transparent/vibrancy background. The pod should have a header, terminal inside, and be draggable by the header.

**Test checklist:**
- [ ] Canvas background shows vibrancy (frosted glass) or at minimum transparent
- [ ] One Claude pod appears at (100, 100) with correct CWD
- [ ] Pod header shows title and close button
- [ ] Terminal renders inside the pod (Claude Code starts)
- [ ] Dragging the pod header moves it
- [ ] Scrolling pans the canvas
- [ ] Option+scroll zooms toward cursor
- [ ] HUD shows zoom % and add buttons in bottom-right
- [ ] Clicking "Claude" in HUD adds a new Claude pod
- [ ] Clicking "Terminal" in HUD adds a new terminal pod
- [ ] Close button removes a pod
- [ ] Resize grip (bottom-right corner) resizes the pod
- [ ] Pods persist after app restart (check by closing and reopening)

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "feat(flight): wire FlightCanvas into App.tsx as default layout"
```

---

## Task 8: Polish and Fix Issues

**Files:**
- May touch any of the new files based on testing

This task is for fixing issues found during Task 7's test checklist.

- [ ] **Step 1: Validate xterm.js text selection under CSS transform**

Test text selection at zoom 0.5, 1.0, and 2.0. If selection drifts, apply the counter-scaling approach from the spec:

```typescript
// On the .xterm element inside the pod, if zoom ≠ 1:
style={{ zoom: 1 / canvasZoom }}
// And adjust fontSize to compensate
```

- [ ] **Step 2: Add debounced font-size adjustment after zoom settles**

After the user stops zooming (300ms debounce), adjust xterm font sizes for crisp rendering at the new zoom level. This can be done by emitting a custom event from FlightCanvas that FlightPod listens for, or by storing the settled zoom in the store and having Terminal.tsx respond.

- [ ] **Step 3: Fix any remaining visual/interaction issues and commit**

Run: `./scripts/check.sh && ./scripts/run.sh`

```bash
git add -A
git commit -m "fix(flight): polish xterm zoom quality and text selection"
```

**Note: Viewport virtualization (display:none for off-screen pods + WebGL context detach) is deferred to a follow-up task.** It becomes necessary when users have >12 pods. For v1 with typical usage (3-8 pods), the 16 WebGL context limit won't be hit.

---

## Task 9: Add Keyboard Shortcuts

**Files:**
- Modify: `src/App.tsx` (add to existing keyboard handler)
- Modify: `src/components/FlightCanvas.tsx`

- [ ] **Step 1: Add Flight Mode keyboard shortcuts**

In `App.tsx`, find the existing keyboard shortcut handler (search for `addEventListener("keydown"`). Add handlers for:

```typescript
// Cmd+0 — reset zoom
if (e.metaKey && e.key === "0") {
  e.preventDefault();
  const wsId = useWorkspaceStore.getState().activeWorkspaceId;
  if (wsId) useWorkspaceStore.getState().setFlightViewport(wsId, { panX: 0, panY: 0, zoom: 1.0 });
}
```

Note: `Cmd+T` (new terminal) and `Cmd+W` (close pod) may conflict with existing shortcuts. Check what's currently bound and adjust. If they conflict, defer to future work — the HUD buttons handle adding pods for now.

- [ ] **Step 2: Verify shortcuts work**

Run: `./scripts/reload.sh`
Test: Press Cmd+0 — canvas should reset to default zoom and pan.

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(flight): add Cmd+0 zoom reset keyboard shortcut"
```
