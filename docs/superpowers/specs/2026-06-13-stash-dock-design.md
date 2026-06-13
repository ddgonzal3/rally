# Stash Dock — Design Spec
_Date: 2026-06-13_

## Problem

Danny runs 8 Flow workspaces simultaneously in Rally's Flight Mode. The grid is always showing all (or many) pods, even ones where Claude has finished and is just sitting idle. `Cmd+N` controls *how many* pods show but picks them by count, not by identity — there's no way to say "hide flow1, flow2, flow5, keep flow3 and flow7 front and center." The result is a visually dense, cognitively stimulating grid that makes it hard to focus on the 1-2 active threads.

## Goal

Give Danny a way to **explicitly stash individual pods** out of the grid into a bottom dock strip, with a live activity dot so he can see at a glance which stashed Claudes are still generating. Click to restore. Zero automatic behavior — fully manual, fully predictable.

---

## Interaction Design

### Stashing a pod

**Gesture:** Shift+click anywhere on a FlightPod.

- The pod animates out of the grid (slides down / fades).
- Remaining pods reflow to fill the freed space — a grid of N-1 pods expands naturally.
- Stashed state is **independent of** `Cmd+N` focus mode. A stashed pod stays stashed through `Cmd+4` / `Cmd+6` / `Cmd+0` — it never reappears unless the user clicks its chip.
- Stash state persists to the flight layout JSON (`~/.rally/workspaces.json`) — survives restart, per-workspace.

> **Pre-implementation check:** Verify shift+click isn't already bound on pods (multi-select, drag, etc.) before shipping. Fallback gesture: Cmd+Shift+click.

### The dock strip

A slim horizontal strip along the **bottom edge** of the FlightCanvas. Appears only when ≥1 pod is stashed; otherwise hidden (zero chrome overhead).

Each stashed pod renders as a **chip**: `[● flow3]`

Chip anatomy:
- **Status dot** — grey (○) when PTY has been silent for > ~3s, colored (●) when output is flowing. Powered by a per-PTY `lastOutputAt` timestamp (see Data section).
- **Name** — workspace/pod name (e.g., `flow3`, `midi generator`).
- **Restore click** — clicking the chip body flies the pod back into the grid at its prior position/size.
- **× button** — appears on hover. Closes the pod for-real (kills PTY, removes from layout). For "done, never coming back" Claudes.

### Restoring a pod

Click a chip → pod flies back into grid. Its prior `x, y, width, height` are remembered (stored in stash state). If the saved position collides badly with the current layout, it restores to a sensible default (center, standard size).

---

## Data Model

### FlightPod type extension (`src/lib/types.ts`)

Add one field to `FlightPod`:

```ts
stashed?: boolean   // defaults undefined/false
```

Stash state lives on the pod itself, so it's automatically persisted with the workspace JSON. No separate stash list needed — the layout already serializes all pods; stashed pods are simply pods with `stashed: true`.

### PTY last-output timestamp (`workspaceStore.ts` + `pty_manager.rs`)

Add a module-level Map alongside `ptyOutputBuffers`:

```ts
const ptyLastOutputAt: Map<string, number> = new Map()  // ptyId → Date.now()
```

Updated every time a `pty-output-{id}` event fires (same handler that feeds `appendPtyBuffer`). No Rust changes needed — the event already fires per output chunk.

The dot in each chip reads `ptyLastOutputAt.get(pod.ptyId)` and compares to `Date.now()`. Threshold: **3 seconds** — if the last output was within 3s, dot is "active" (amber/white); otherwise grey.

---

## Component Design

### `FlightCanvas.tsx`

- Handle `shift+click` on pods → call `stashPod(podId)` store action.
- Pass a `onStash` callback down to `FlightPod` (or handle at canvas level via event).
- Render `<StashDock />` at the bottom when `stalledPods.length > 0`.

### `StashDock.tsx` (new component)

```
src/components/StashDock.tsx
```

- Reads stashed pods from `useWorkspaceStore` (filtered `flightPods.filter(p => p.stashed)`).
- Renders a fixed strip at the bottom of the flight canvas area.
- Renders one `<StashChip />` per pod.
- Styled: same frosted blur treatment as other popovers — `background: rgba(36,36,36,0.78)`, `backdrop-filter: blur(20px) saturate(180%)`, `border-top: 1px solid rgba(255,255,255,0.12)`.

### `StashChip.tsx` (new component)

```
src/components/StashChip.tsx
```

Props: `pod`, `lastOutputAt: number | undefined`, `onRestore`, `onClose`.

- Status dot: reads `lastOutputAt`, compares `Date.now() - lastOutputAt < 3000`. Active = `#ddd` dot; idle = `#444` dot.
- Hover state shows × button.
- Matches font size / color / padding of existing `FlightPodFooter` chips.

### `workspaceStore.ts` — new actions

```ts
stashPod(podId: string): void
  // sets pod.stashed = true, records pod's current x/y/w/h in pod itself (already there)

unstashPod(podId: string): void  
  // sets pod.stashed = false, restores prior x/y/w/h
```

---

## Grid reflow behavior

When a pod is stashed, it sets `stashed: true` — it's no longer rendered in the canvas. The FlightCanvas already lays out only rendered pods (positioned absolutely by their x/y/w/h), so removal naturally frees space. **Active pods don't auto-reflow** — Flight Mode pods are freeform/absolute, not auto-grid. The freed space just becomes empty canvas.

Exception: **focus mode** (Cmd+N grid). When focus mode is active, the grid re-packs only non-stashed pods when a pod is stashed. The focus-mode layout calculation in `FlightCanvas.tsx` already filters by `isVisible` — we change that filter to also exclude `stashed: true`.

---

## What's explicitly out of scope

- **Auto-hide inactive pods** — no automatic stashing based on output silence. All manual.
- **Stash all inactive** shortcut — deferred; the `ptyLastOutputAt` signal is the building block if wanted later.
- **Cross-workspace stash** — stash is per-workspace, like all flight layout state.
- **Stash in Dev/Product modes** — Flight Mode only for now.

---

## Files to change

| File | Change |
|------|--------|
| `src/lib/types.ts` | Add `stashed?: boolean` to `FlightPod` |
| `src/stores/workspaceStore.ts` | Add `ptyLastOutputAt` map + `stashPod` / `unstashPod` actions |
| `src/components/FlightCanvas.tsx` | Shift+click handler, exclude stashed from focus mode, render `<StashDock />` |
| `src/components/FlightPod.tsx` | Pass `onStash` callback, handle shift+click |
| `src/components/StashDock.tsx` | **New** — dock strip container |
| `src/components/StashChip.tsx` | **New** — individual stashed pod chip |

No Rust changes required.
