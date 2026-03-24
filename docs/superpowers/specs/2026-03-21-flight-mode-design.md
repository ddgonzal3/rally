# Flight Mode Design Spec

**Date:** 2026-03-21
**Status:** Approved
**Framework:** Tauri v2 (staying — validated by 5-expert panel)

## Overview

Flight Mode replaces Rally's static split-panel layout with an infinite canvas where terminal pods float freely. Users pan, zoom, drag, and resize pods on an open workspace. The sidebar, build status bar, and all backend code remain unchanged. The Tauri window config gets a vibrancy update (`transparent: true` + `windowEffects`) which requires a full rebuild (per PITFALLS.md) and should be tested in isolation before Flight Mode work begins.

**Scope for v1:** Only Claude and terminal pod types. Editor, diff, webview, and other `PaneType` variants are deferred to v2. The `claude-launcher` state (pre-session Claude pod) is handled within the Claude pod — it starts as a launcher and transitions to a live session, same as the current behavior.

**Inspiration:** Collaborator AI's infinite canvas with floating terminal pods.

## Core Concepts

- **Pod:** A floating, draggable, resizable terminal window on the canvas. Two types:
  - **Claude pod:** Claude Code session with an optional attached shell panel (collapsible, shares CWD)
  - **Terminal pod:** Standalone shell terminal
- **Canvas:** Infinite 2D workspace. Pan with one-finger scroll, zoom with Option+scroll wheel.
- **Viewport:** The visible window into the canvas. CSS `transform: translate3d(x,y,0) scale(z)` on a single container div — GPU-composited.

## Data Model

```typescript
/** Base spatial properties shared by all pods */
interface FlightPodBase {
  id: string;
  x: number;                // Canvas coordinates
  y: number;
  width: number;
  height: number;
  cwd: string;
  title: string;
  ptyId?: string;           // Main PTY
  zIndex: number;           // Layering — last-focused-on-top
}

/** Claude Code pod — has an optional attached shell */
interface FlightClaudePod extends FlightPodBase {
  type: "claude";
  shellExpanded: boolean;   // Attached shell toggle
  shellHeight: number;      // Height of attached shell when expanded
  shellPtyId?: string;      // Attached shell PTY
}

/** Standalone terminal pod */
interface FlightTerminalPod extends FlightPodBase {
  type: "terminal";
}

export type FlightPod = FlightClaudePod | FlightTerminalPod;

export interface FlightViewport {
  panX: number;
  panY: number;
  zoom: number;             // 0.3–2.0, default 1.0
}

export interface FlightLayout {
  pods: FlightPod[];
  viewport: FlightViewport;
}
```

### Key Design Decisions

- **Flat list, not a tree.** No split nodes, no groups, no tabs. Pods have x/y/width/height. Radically simpler than the current `LayoutNode` tree.
- **Claude pods have attached shells.** `shellExpanded` toggles a secondary terminal that docks below the main Claude terminal. Same CWD, separate PTY. Animates open/closed.
- **zIndex via monotonic counter.** Click a pod → increment counter → assign. No renumbering needed.
- **Per-workspace persistence.** Each workspace saves its `FlightLayout` (pod positions + viewport state) to `~/.rally/workspaces.json`.

## Default Sizes

| Pod Type | Default Width | Default Height |
|----------|--------------|----------------|
| Claude   | 700          | 500            |
| Terminal | 500          | 300            |

Minimum sizes: 400x250 (Claude), 300x150 (Terminal). Freely resizable beyond minimums.

## Canvas Interaction

### Pan
- **Input:** One-finger scroll (wheel events without Option key)
- **Behavior:** Updates `panX/panY`. Canvas container uses `transform: translate3d(panX, panY, 0) scale(zoom)`.
- **Performance:** GPU-composited transform, zero layout thrashing.

### Zoom
- **Input:** Option + scroll wheel
- **Behavior:** Zoom toward cursor position (point under cursor stays fixed).
- **Math:** `newPan = cursor - (cursor - pan) * (newZoom / oldZoom)`
- **Range:** 0.3 (zoomed out, overview) to 2.0 (zoomed in, detail). Default 1.0.
- **Quality:** During zoom gesture, accept compositor scaling (slightly blurry). After zoom settles (300ms debounce), re-render xterm at correct resolution.

### Drag Pods
- **Input:** Mousedown on pod header (title bar area)
- **Behavior:** Updates pod `x/y` in canvas coordinates. Screen deltas divided by zoom for correct canvas-space movement.
- **Focus:** Dragged pod gets bumped to top `zIndex`.
- **Performance:** `pointer-events: none` on all other pods during drag.

### Resize Pods
- **Input:** Grip at bottom-right corner (and optionally all edges/corners)
- **Behavior:** Updates pod `width/height` with minimum enforcement.
- **Coordinate math:** Same zoom compensation as drag.

### Attached Shell Toggle
- **Input:** Toggle button in Claude pod header
- **Behavior:** Animates shell height from 0 to stored `shellHeight` (default 200px). First expansion spawns shell PTY with same CWD.
- **Animation:** CSS transition on the shell container.

### Focus
- Clicking a pod brings it to front (`zIndex` bump) and focuses its xterm instance.
- Only one terminal receives keyboard input at a time.
- Clicking empty canvas deselects all pods.

## Component Architecture

```
App.tsx
├── Titlebar (unchanged)
├── ActivityBar + Explorers (unchanged)
├── FlightCanvas                    ← NEW, replaces PaneLayout
│   ├── FlightViewport              ← transform container (pan/zoom)
│   │   ├── FlightPod               ← one per pod
│   │   │   ├── PodHeader           ← drag handle, type icon, title, controls
│   │   │   ├── Terminal             ← existing Terminal.tsx (reused)
│   │   │   ├── PodShell (optional)  ← collapsible attached shell
│   │   │   │   └── Terminal         ← same Terminal.tsx, shares CWD
│   │   │   └── PodResizeHandles    ← edge/corner grips
│   │   └── ...more pods
│   └── FlightHUD                   ← fixed overlay (zoom %, add button)
├── BuildStatusDrawer (unchanged)
├── BuildStatusBar (unchanged)
└── UnifiedGitPanel (unchanged)
```

### New Components

| Component | File | Responsibility |
|-----------|------|---------------|
| `FlightCanvas` | `src/components/FlightCanvas.tsx` | Outer container, wheel event handling, vibrancy background |
| `FlightViewport` | inside FlightCanvas | Single div with CSS transform, contains all pods |
| `FlightPod` | `src/components/FlightPod.tsx` | Pod chrome, positioning, resize handles, hosts Terminal |
| `PodHeader` | inside FlightPod | Drag handle, title, type icon, shell toggle, close button |
| `PodShell` | inside FlightPod | Collapsible attached terminal for Claude pods |
| `FlightHUD` | `src/components/FlightHUD.tsx` | Fixed overlay: zoom %, add pod button, minimap (future) |

### Reused Unchanged

- `Terminal.tsx` — zero changes, already handles PTY spawn/resize/output/themes
- `BuildStatusBar.tsx`, `BuildStatusDrawer.tsx` — stay in place
- Sidebar / activity bar — untouched
- All Rust backend — untouched

### Replaced (not deleted, just not rendered)

- `PaneLayout.tsx` — Flight Mode renders instead
- `SplitContainer.tsx` — not used in Flight Mode
- `PaneGroupView.tsx` — no tabs/groups concept

## Store Changes

New fields in `workspaceStore.ts`:

```typescript
// State
flightLayouts: Record<string, FlightLayout>;   // per workspace
flightNextZIndex: Record<string, number>;       // per workspace counter

// Actions
addFlightPod(workspaceId: string, type: "claude" | "terminal"): void;
removeFlightPod(workspaceId: string, podId: string): void;
updateFlightPod(workspaceId: string, podId: string, updates: Partial<FlightPod>): void;
setFlightViewport(workspaceId: string, viewport: Partial<FlightViewport>): void;
bringPodToFront(workspaceId: string, podId: string): void;
togglePodShell(workspaceId: string, podId: string): void;
getOrCreateFlightLayout(workspaceId: string): FlightLayout;
```

### addFlightPod

Creates a new pod at center of current viewport, offset if overlapping. Sets default dimensions by type. Spawns PTY automatically.

### bringPodToFront

Increments `flightNextZIndex[workspaceId]`, assigns to pod. Monotonic, no renumbering.

### togglePodShell

Flips `shellExpanded`. If expanding for first time with no `shellPtyId`, spawns new PTY with same CWD.

### Persistence

`flightLayouts` serializes alongside existing workspace data in `~/.rally/workspaces.json`. Pod positions and viewport state survive app restart.

## Default Layout

When a workspace has no saved `FlightLayout`, `getOrCreateFlightLayout` creates:

- One Claude pod at `(100, 100)`, 700x500, shell collapsed
- CWD set to workspace's active path
- Viewport at `{ panX: 0, panY: 0, zoom: 1.0 }`

## Visual Design

### Window Vibrancy

Tauri window config:
```json
{
  "transparent": true,
  "windowEffects": {
    "effects": ["underWindow"],
    "state": "followsWindowActiveState"
  }
}
```

Canvas background is transparent — macOS WindowServer handles frosted blur natively. Zero CSS `backdrop-filter` cost.

### Pod Styling

Each pod:
- Background: `rgba(20, 20, 20, 0.85)` — dark, semi-transparent
- Border: `1px solid rgba(255, 255, 255, 0.08)` — subtle edge definition
- Border-radius: `10px` — macOS-native rounded corners
- Shadow: `0 8px 32px rgba(0, 0, 0, 0.4)` — floating elevation
- No colored buttons or icons (per UI rules — neutral only)

### Pod Header

- Height: ~32px
- Left: type icon (Claude invader icon or `>_` for terminal) + title (CWD basename)
- Right: shell toggle (Claude pods only) + close button
- All icons in `#999`, matching neighbors

### Terminal inside Pods

- Existing `Terminal.tsx` renders inside pod body
- Background matches pod background via CSS variables
- WebGL renderer for crisp text at any zoom level
- Zoom-level font adjustment (debounced after zoom settles)

## Performance Strategy

### GPU Compositing
- Canvas container: `will-change: transform` for layer promotion
- Pod elements: absolutely positioned, `will-change: transform` during drag
- Pan/zoom updates CSS transform only — no layout, no paint

### Viewport Virtualization
- Off-screen pods use `display: none` (NOT unmounted) — consistent with PITFALLS.md. Unmounting xterm destroys alternate screen buffer state, causing garbled output on remount for TUI apps like Claude Code.
- `display: none` hides the DOM but keeps xterm instances alive. ResizeObserver fires on re-show, triggering SIGWINCH for correct redraw.
- **WebGL context management:** When a pod goes off-screen, detach the WebGL addon (releases the GPU context) but keep the xterm instance. Reattach WebGL when the pod becomes visible. This respects the ~16 context browser limit while avoiding the replay problem.
- Threshold: pods more than 1.5 viewport-widths outside visible area get `display: none` + WebGL detach.

### xterm.js at Scale
- WebGL renderer for all terminals
- At zoom < 0.5: consider showing simplified pod preview instead of live terminal
- After zoom settles (300ms debounce): adjust font size for crisp rendering at new zoom level
- Max ~16 active WebGL contexts (browser limit) — virtualization handles this naturally

### xterm.js Under CSS Transform

CSS `transform: scale()` on the viewport container means xterm.js mouse events (`clientX`/`clientY`) are in screen coordinates while terminal content is in transformed coordinates. This differs from Rally's existing CSS `zoom` approach (documented in PITFALLS.md).

**Key difference:** CSS `transform` does NOT affect `getBoundingClientRect()` the same way CSS `zoom` does. xterm.js's internal coordinate math (`(clientX - rect.left) / cellWidth`) will be correct because `rect` is already in screen space and includes the transform. Text selection and click-to-position should work without the `zoom: 1/Z` counter-scaling hack currently used in Terminal.tsx.

**Validation needed:** Test text selection and link clicking at zoom levels 0.5, 1.0, and 2.0 early in implementation. If coordinate drift appears, apply a similar counter-scaling approach on the `.xterm` element within each pod.

### Input Performance
- `pointer-events: none` on non-interacted pods during drag/resize
- Passive wheel listeners where possible
- No `backdrop-filter` — native vibrancy only

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+T | Add new terminal pod |
| Cmd+Shift+T | Add new Claude pod |
| Cmd+W | Close focused pod |
| Cmd+\` | Cycle focus to next pod (by zIndex order) |
| Cmd+Shift+\` | Cycle focus to previous pod |
| Cmd+0 | Reset zoom to 1.0 and pan to origin |
| Cmd++ / Cmd+- | Zoom in / out (centered on viewport) |

Pod header title text is not user-selectable (standard window chrome behavior) to prevent conflict with drag.

## Migration Path

Flight Mode becomes the default. The old split-panel layout code is **deprecated** — kept temporarily for reference but will be removed once Flight Mode stabilizes:

1. In `App.tsx`, replace `<PaneLayout />` with `<FlightCanvas />`
2. Old layout types (`LayoutNode`, `PaneGroup`, `SplitDirection`) remain in `types.ts` temporarily
3. Old components (`PaneLayout`, `SplitContainer`, `PaneGroupView`) remain in `components/` temporarily
4. If a workspace has an existing `layouts` entry but no `flightLayouts` entry, `getOrCreateFlightLayout` creates a fresh default layout (no migration of old split-tree data)
5. **Cleanup milestone:** After Flight Mode has been the default for 2+ weeks with no regressions, remove deprecated layout code and types per CLAUDE.md dead code policy

## Future Considerations (Not in v1)

- **Layout presets:** Save/restore named pod arrangements (replaces current `LayoutPreset`)
- **Snap-to-grid:** Optional grid alignment when dragging pods
- **Auto-arrange:** Button to auto-layout pods in a grid pattern
- **Minimap:** Small overview in the HUD showing all pods and viewport position
- **Pod linking:** Connect pods visually (e.g., Claude pod → its output terminal)
- **Thumbnail mode:** At very low zoom, render pod screenshots instead of live terminals
