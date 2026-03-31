# Remove Ship Feature & Smart PTY Monitoring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the entire ship feature and all Rally built-in commands, then make PTY foreground monitoring conditional on visibility so only active terminals poll `pgrep`/`ps`.

**Architecture:** Two independent changes: (1) a large deletion of ship-related code across Rust backend, TypeScript types, Zustand store, React components, and Tauri command registrations; (2) a targeted addition of pause/resume capability to the PTY foreground monitor thread, with frontend signaling based on workspace/mode visibility.

**Tech Stack:** Rust (Tauri v2), React 19, Zustand v5, TypeScript, xterm.js

---

## File Structure

### Files to DELETE
- `src-tauri/src/ship_ops.rs` — all ship signals, CLI scripts, command management
- `src/components/ShipStatusPill.tsx` — floating ship pill + terminal
- `src/components/ScriptEditor.tsx` — Rally scripts management UI
- `src-tauri/resources/commands/rally-ship.md` — embedded ship command
- `src-tauri/resources/commands/rally-review-pr.md` — embedded review-pr command

### Files to MODIFY (ship removal)
- `src-tauri/src/lib.rs` — remove `pub mod ship_ops`
- `src-tauri/src/main.rs` — remove ship_ops imports, command registrations, ensure_default_commands()
- `src-tauri/src/commands.rs` — remove `builtin_commands()` and its usage in `list_scripts()`
- `src/lib/types.ts` — remove Ship* types, RallyScriptInfo
- `src/lib/tauri.ts` — remove ship API wrappers, rally script wrappers, Ship import
- `src/stores/workspaceStore.ts` — remove ship state, actions, buffers, imports
- `src/App.tsx` — remove ShipStatusPill, ScriptEditor, ship polling, scripts explorer view
- `src/components/Terminal.tsx` — remove lockCols, shipOutputBuffer usage
- `src/components/PrReviewOverlay.tsx` — remove handleShip callback
- `CLAUDE.md` — remove ship documentation sections
- `PITFALLS.md` — remove ship-related pitfall entries

### Files to MODIFY (smart PTY monitoring)
- `src-tauri/src/pty_manager.rs` — add `monitor_paused` atomic, pause/resume commands
- `src/lib/tauri.ts` — add `pausePtyMonitor`/`resumePtyMonitor` wrappers
- `src/components/Terminal.tsx` — call resume on mount, pause on unmount
- `src/App.tsx` — batch pause/resume on workspace switch

---

## Task 1: Create branch

**Files:** (none)

- [ ] **Step 1: Create and switch to feature branch**

```bash
git checkout -b perf/remove-ship-smart-pty-monitoring
```

- [ ] **Step 2: Commit plan**

```bash
git add docs/superpowers/plans/2026-03-31-remove-ship-smart-pty-monitoring.md
git commit -m "docs: add plan for ship removal and smart PTY monitoring"
```

---

## Task 2: Delete ship files

**Files:**
- Delete: `src-tauri/src/ship_ops.rs`
- Delete: `src/components/ShipStatusPill.tsx`
- Delete: `src/components/ScriptEditor.tsx`
- Delete: `src-tauri/resources/commands/rally-ship.md`
- Delete: `src-tauri/resources/commands/rally-review-pr.md`

- [ ] **Step 1: Delete the files**

```bash
rm src-tauri/src/ship_ops.rs
rm src/components/ShipStatusPill.tsx
rm src/components/ScriptEditor.tsx
rm src-tauri/resources/commands/rally-ship.md
rm src-tauri/resources/commands/rally-review-pr.md
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: delete ship feature files and Rally built-in commands"
```

---

## Task 3: Remove ship from Rust backend

**Files:**
- Modify: `src-tauri/src/lib.rs` — remove `pub mod ship_ops` (line 8)
- Modify: `src-tauri/src/main.rs` — remove ship_ops imports (line 11), command registrations (lines 218-223), and `ensure_default_commands()` call (lines 324-326)
- Modify: `src-tauri/src/commands.rs` — remove `builtin_commands()` function (lines 786-806) and its usage in `list_scripts()` (lines ~920-930 where it calls `builtin_commands()` and iterates)

- [ ] **Step 1: Remove `pub mod ship_ops` from lib.rs**

In `src-tauri/src/lib.rs`, delete line 8:
```rust
pub mod ship_ops;
```

- [ ] **Step 2: Remove ship_ops from main.rs**

In `src-tauri/src/main.rs`:

1. Delete the import at line 11:
```rust
use rally::ship_ops;
```

2. Delete these lines from the `generate_handler![]` macro (lines 218-223):
```rust
        ship_ops::check_ship_signal,
        ship_ops::clear_ship_signal,
        ship_ops::check_ship_trigger,
        ship_ops::post_merge_sync,
        ship_ops::list_rally_scripts,
        ship_ops::restore_rally_script,
```

3. Delete the `ensure_default_commands()` call in `setup()` (lines 324-326):
```rust
        if let Err(e) = ship_ops::ensure_default_commands() {
          eprintln!("Warning: failed to install default commands: {}", e);
        }
```

- [ ] **Step 3: Remove builtin_commands from commands.rs**

In `src-tauri/src/commands.rs`:

1. Delete the entire `builtin_commands()` function (lines 786-806).

2. In `list_scripts()`, remove the reference to `rally_commands_dir()` and the builtin commands iteration. Find and remove:
   - The `rally_commands` variable that calls `crate::ship_ops::rally_commands_dir()`
   - The `for builtin in builtin_commands()` loop and all code inside it
   - The `exclude_builtins` variable and its parsing from RALLY.json (if it's only used for builtins)

   Keep the scripts directory scanning and repo-level Claude commands logic intact.

- [ ] **Step 4: Verify Rust compiles**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: compiles with no errors (warnings OK).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/main.rs src-tauri/src/commands.rs
git commit -m "feat: remove ship_ops module and built-in command registrations from Rust backend"
```

---

## Task 4: Remove ship types and API wrappers from TypeScript

**Files:**
- Modify: `src/lib/types.ts` — remove lines 122-164 (ShipSignalFlaggedItem, ShipSignal, ShipPhase, ShipDetailPhase, ShipSession, ShipStatus) and RallyScriptInfo type (~line 205)
- Modify: `src/lib/tauri.ts` — remove ship API wrappers (lines 193-203), rally script wrappers (lines 231-235), and ShipSignal/RallyScriptInfo from imports (line 2)

- [ ] **Step 1: Remove ship types from types.ts**

Delete these type blocks from `src/lib/types.ts`:

```typescript
// Lines 122-164 — all of these:
export interface ShipSignalFlaggedItem { ... }
export interface ShipSignal { ... }
export type ShipPhase = ...;
export type ShipDetailPhase = ...;
export interface ShipSession { ... }
export interface ShipStatus { ... }
```

Also delete `RallyScriptInfo` (~line 205):
```typescript
export interface RallyScriptInfo { ... }
```

- [ ] **Step 2: Remove ship wrappers from tauri.ts**

In `src/lib/tauri.ts`:

1. Remove `ShipSignal` and `RallyScriptInfo` from the type import on line 2.

2. Delete the ship API wrappers (lines 193-203):
```typescript
  checkShipSignal: (repoPath: string) => ...
  clearShipSignal: (repoPath: string) => ...
  checkShipTrigger: () => ...
  postMergeSync: (cwd: string, mainBranch: string, mergedBranch: string) => ...
```

3. Delete the rally scripts API wrappers (lines 231-235):
```typescript
  listRallyScripts: () => ...
  restoreRallyScript: (name: string) => ...
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts src/lib/tauri.ts
git commit -m "feat: remove ship types and API wrappers from TypeScript layer"
```

---

## Task 5: Remove ship from Zustand store

This is the largest single task. The store has ship state, ship actions, and the ship output buffer.

**Files:**
- Modify: `src/stores/workspaceStore.ts`

- [ ] **Step 1: Remove ship imports**

At the top of `workspaceStore.ts`, remove ship types from the import (lines 20-23):
```typescript
  ShipStatus,
  ShipSession,
  ShipSignal,
  ShipDetailPhase,
```

- [ ] **Step 2: Remove shipOutputBuffer and MAX_SHIP_BUFFER_CHUNKS**

Delete the module-level `shipOutputBuffer` declaration and its JSDoc (lines 61-65):
```typescript
export const shipOutputBuffer: Uint8Array[] = [];
```

Delete `MAX_SHIP_BUFFER_CHUNKS` constant (line 80):
```typescript
const MAX_SHIP_BUFFER_CHUNKS = 500;
```

Also update the `scriptOutputBuffers` JSDoc (line 68) to remove the "like shipOutputBuffer" reference.

- [ ] **Step 3: Remove ship state fields from interface**

Remove from the state interface (lines 312-315):
```typescript
  shipStatuses: Record<string, ShipStatus>;
  shipSession: ShipSession | null;
```

- [ ] **Step 4: Remove ship action declarations from interface**

Remove from the actions interface (lines 491-499):
```typescript
  // Ship actions
  pollShipSignals: () => Promise<void>;
  handleAutoMerge: (repoPath: string) => Promise<void>;
  startShipSession: (repoPath: string) => Promise<void>;
  dockShipSession: (workspaceId: string) => void;
  dismissShipSession: () => void;
```

- [ ] **Step 5: Remove ship initial values**

Remove from the `create()` call (lines 824-825):
```typescript
  shipStatuses: {},
  shipSession: null,
```

- [ ] **Step 6: Remove all ship action implementations**

Delete the entire ship actions block (lines ~1499-1887):
```typescript
  // --- Ship actions ---
  pollShipSignals: async () => { ... },
  handleAutoMerge: async (repoPath) => { ... },
  startShipSession: async (repoPath) => { ... },
  dockShipSession: (workspaceId) => { ... },
  dismissShipSession: () => { ... },
```

This is a large block (~390 lines). Delete from the `// --- Ship actions ---` comment through the end of `dismissShipSession`.

- [ ] **Step 7: Clean up any remaining ship references**

Search for any remaining `ship` references in the store file and remove them. Likely candidates:
- References to `shipOutputBuffer.length = 0` in non-ship actions
- Any `get().shipSession` checks in non-ship code

- [ ] **Step 8: Commit**

```bash
git add src/stores/workspaceStore.ts
git commit -m "feat: remove all ship state and actions from Zustand store"
```

---

## Task 6: Remove ship from React components

**Files:**
- Modify: `src/App.tsx` — remove ShipStatusPill, ScriptEditor, ship polling, scripts explorer view
- Modify: `src/components/Terminal.tsx` — remove lockCols, shipOutputBuffer
- Modify: `src/components/PrReviewOverlay.tsx` — remove handleShip

- [ ] **Step 1: Clean up App.tsx**

1. Remove imports (lines 8, 39):
```typescript
import { ScriptEditor } from "./components/ScriptEditor";
import { ShipStatusPill } from "./components/ShipStatusPill";
```

2. Remove `pollShipSignals` selector (line 463):
```typescript
  const pollShipSignals = useWorkspaceStore((s) => s.pollShipSignals);
```

3. Remove `shipPollInFlightRef` (line 557):
```typescript
  const shipPollInFlightRef = useRef(false);
```

4. Remove `runShipPoll` callback (lines 705-714):
```typescript
  const runShipPoll = useCallback(async () => { ... }, [...]);
```

5. Remove `shipMs` calculation (line 755):
```typescript
    const shipMs = pathCount > 6 ? 10000 : 5000;
```

6. Remove `shipInterval` setup (lines 764-766):
```typescript
    const shipInterval = setInterval(() => {
      void runShipPoll();
    }, shipMs);
```

7. Remove `clearInterval(shipInterval)` from cleanup (line 775).

8. Remove `runShipPoll` from the useEffect dependency array (line 782).

9. Remove `<ShipStatusPill />` render (line 2227).

10. Remove `<ScriptEditor />` render and the `explorerView === "scripts"` conditional (line 2130):
```typescript
            {explorerView === "scripts" && <ScriptEditor />}
```

- [ ] **Step 2: Clean up Terminal.tsx**

1. Remove `shipOutputBuffer` from the import (line 7):
```typescript
// Change from:
import { useWorkspaceStore, shipOutputBuffer, scriptOutputBuffers, ... } from ...
// To:
import { useWorkspaceStore, scriptOutputBuffers, ... } from ...
```

2. Remove `lockCols` prop from the interface (lines 19-21):
```typescript
  /** Lock columns to 80 — only for ship dock terminals where SIGWINCH
   *  col changes cause rich TUI garble. Regular terminals should NOT lock. */
  lockCols?: boolean;
```

3. Remove `lockCols: lockColsProp` from the destructured props (line 189).

4. Remove `lockCols` and `LOCKED_COLS` from the useEffect (lines 584-587):
```typescript
    const lockCols = !!lockColsProp;
    const LOCKED_COLS = 80;
```

5. Remove the `fitRowsOnly()` helper function (lines 593-595).

6. Remove the `fitRowsWithLockedCols` import and function if it becomes unused.

7. In `connectToPty`, simplify all `lockCols ? fitRowsOnly() : safeFit(...)` ternaries to just `safeFit(...)`.

8. Remove ship buffer replay block in `attachExistingPty` (lines 742-749):
```typescript
        if (lockCols) {
          const session = useWorkspaceStore.getState().shipSession;
          if (session && session.ptyId === existingPtyId) {
            for (const chunk of shipOutputBuffer) {
              term.write(chunk);
            }
          }
        }
```

9. In `term.onResize`, remove the `lockCols ? LOCKED_COLS : cols` logic — just use `cols`.

10. In the ResizeObserver callback, remove the `lockCols ? fitRowsOnly() :` ternary — just call `safeFit(...)`.

11. In the `onDragEnd` handler, remove `lockCols ? LOCKED_COLS :` — just use `term.cols`.

- [ ] **Step 3: Clean up PrReviewOverlay.tsx**

Remove the `handleShip` callback (lines 334-338):
```typescript
  const handleShip = useCallback(() => {
    if (!activeWorkspaceId) return;
    onClose?.();
    openClaudeCommand(activeWorkspaceId, rootPath, "/rally-ship", "Ship");
  }, [activeWorkspaceId, rootPath, onClose, openClaudeCommand]);
```

If `openClaudeCommand` is no longer used in this component after removing `handleShip`, also remove its selector.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
./scripts/check.sh
```

Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/components/Terminal.tsx src/components/PrReviewOverlay.tsx
git commit -m "feat: remove ship UI from App, Terminal, and PrReviewOverlay components"
```

---

## Task 7: Update documentation

**Files:**
- Modify: `CLAUDE.md` — remove ship sections
- Modify: `PITFALLS.md` — remove ship pitfalls

- [ ] **Step 1: Remove ship sections from CLAUDE.md**

Remove these sections:
- "Built-in Commands (Ship, Review PR)" section and all subsections
- "Ship Signal Protocol" section
- "Adding New Built-in Commands" section
- Ship-related entries from the "File Map" tables (ShipStatusPill.tsx row, ship_ops.rs row)
- Ship-related entries from the "Related Files" table

Keep the rest of the file intact — workspace management, git operations, PTY architecture, etc.

- [ ] **Step 2: Remove ship pitfalls from PITFALLS.md**

Remove these entries:
- "Ship Terminal: Use Persistent Hidden xterm"
- "Ship Signal: `phase` Field Uses `#[serde(default)]`"
- "Ship Sessions: Always Guard `ptyId` Before PTY Operations"

Keep all non-ship pitfalls.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md PITFALLS.md
git commit -m "docs: remove ship documentation from CLAUDE.md and PITFALLS.md"
```

---

## Task 8: Add pause/resume to PTY foreground monitor (Rust)

**Files:**
- Modify: `src-tauri/src/pty_manager.rs`

- [ ] **Step 1: Add `monitor_paused` field to PtySession**

In the `PtySession` struct (line 38), add a new field:

```rust
struct PtySession {
    write_tx: Option<mpsc::Sender<Vec<u8>>>,
    pair: portable_pty::PtyPair,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    foreground: Arc<Mutex<Option<String>>>,
    monitor_stop: Arc<AtomicBool>,
    monitor_paused: Arc<AtomicBool>,
    cwd: String,
    command: Option<String>,
}
```

- [ ] **Step 2: Update spawn_foreground_monitor to accept and check paused flag**

Change the signature of `spawn_foreground_monitor` (line 57) to accept `monitor_paused`:

```rust
fn spawn_foreground_monitor(
    app_handle: AppHandle,
    pty_id: String,
    shell_pid: Option<u32>,
    foreground: Arc<Mutex<Option<String>>>,
    monitor_stop: Arc<AtomicBool>,
    monitor_paused: Arc<AtomicBool>,
) {
```

Inside the monitor loop (between the `monitor_stop` check and the `sampled` line), add a pause check:

```rust
            if monitor_stop.load(Ordering::Relaxed) {
                break;
            }

            // Skip polling when paused (PTY not visible to user)
            if monitor_paused.load(Ordering::Relaxed) {
                thread::sleep(STEADY_POLL_INTERVAL);
                continue;
            }
```

- [ ] **Step 3: Update spawn() to create and pass monitor_paused**

In `PtyManager::spawn()`, create the `monitor_paused` atomic (starts paused — frontend will resume when visible):

```rust
        let monitor_paused = Arc::new(AtomicBool::new(true));
```

Pass it to `spawn_foreground_monitor`:

```rust
        spawn_foreground_monitor(
            app_handle.clone(),
            pty_id.clone(),
            shell_pid,
            foreground.clone(),
            monitor_stop.clone(),
            monitor_paused.clone(),
        );
```

Store it in the session:

```rust
        self.sessions.insert(
            pty_id.clone(),
            PtySession {
                write_tx: Some(write_tx),
                pair,
                child,
                foreground,
                monitor_stop,
                monitor_paused,
                cwd: effective_cwd,
                command,
            },
        );
```

- [ ] **Step 4: Add pause_pty_monitor and resume_pty_monitor methods to PtyManager**

```rust
    pub fn pause_monitor(&self, pty_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .get(pty_id)
            .ok_or_else(|| format!("PTY session not found: {}", pty_id))?;
        session.monitor_paused.store(true, Ordering::Relaxed);
        Ok(())
    }

    pub fn resume_monitor(&self, pty_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .get(pty_id)
            .ok_or_else(|| format!("PTY session not found: {}", pty_id))?;
        session.monitor_paused.store(false, Ordering::Relaxed);
        Ok(())
    }
```

- [ ] **Step 5: Add Tauri command wrappers**

At the bottom of `pty_manager.rs`, add:

```rust
#[tauri::command]
pub fn pause_pty_monitor(
    state: tauri::State<'_, PtyState>,
    pty_id: String,
) -> Result<(), String> {
    let manager = state.lock().map_err(|e| e.to_string())?;
    manager.pause_monitor(&pty_id)
}

#[tauri::command]
pub fn resume_pty_monitor(
    state: tauri::State<'_, PtyState>,
    pty_id: String,
) -> Result<(), String> {
    let manager = state.lock().map_err(|e| e.to_string())?;
    manager.resume_monitor(&pty_id)
}
```

- [ ] **Step 6: Register commands in main.rs**

In `src-tauri/src/main.rs`, add to the `generate_handler![]` macro near the other PTY commands:

```rust
        pty_manager::pause_pty_monitor,
        pty_manager::resume_pty_monitor,
```

- [ ] **Step 7: Verify Rust compiles**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: compiles with no errors.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/pty_manager.rs src-tauri/src/main.rs
git commit -m "feat: add pause/resume for PTY foreground monitor threads"
```

---

## Task 9: Wire up pause/resume from frontend

**Files:**
- Modify: `src/lib/tauri.ts` — add pausePtyMonitor/resumePtyMonitor wrappers
- Modify: `src/components/Terminal.tsx` — resume on mount, pause on unmount
- Modify: `src/App.tsx` — batch pause/resume on workspace switch

- [ ] **Step 1: Add API wrappers in tauri.ts**

In `src/lib/tauri.ts`, add to the `api` object:

```typescript
  pausePtyMonitor: (ptyId: string) =>
    invoke<void>("pause_pty_monitor", { ptyId }),

  resumePtyMonitor: (ptyId: string) =>
    invoke<void>("resume_pty_monitor", { ptyId }),
```

- [ ] **Step 2: Resume/pause monitor in Terminal.tsx based on mount lifecycle**

In `Terminal.tsx`, inside the `connectToPty` function (after setting up listeners), add a resume call:

```typescript
      // Resume foreground monitoring — this terminal is now visible
      api.resumePtyMonitor(ptyId).catch(() => {});
```

In the cleanup function (the `return () => { ... }` at the end of the main useEffect), add a pause call before the existing cleanup logic:

```typescript
      // Pause foreground monitoring — this terminal is no longer visible
      if (ptyIdRef.current) {
        api.pausePtyMonitor(ptyIdRef.current).catch(() => {});
      }
```

This handles the basic case: when a Terminal component mounts (becomes visible), its monitor resumes. When it unmounts (hidden/removed), the monitor pauses.

**Important:** For terminals that are kept mounted but hidden via `display: none` (workspace switching), the Terminal component does NOT unmount — so this alone won't pause them. That's handled in step 3.

- [ ] **Step 3: Batch pause/resume on workspace switch in App.tsx**

In `src/App.tsx`, add a `useEffect` that fires when `activeWorkspaceId` changes. It should:

1. Collect all PTY IDs from the **newly active** workspace's layout (both flight pods and dev panes)
2. Collect all PTY IDs from **all other** workspaces
3. Call `resumePtyMonitor` for the active set
4. Call `pausePtyMonitor` for the inactive set

Add a helper to the store or inline in App.tsx that collects PTY IDs from a workspace's layout:

```typescript
  // Collect all ptyIds from a workspace's layout tree
  function collectPtyIds(layout: WorkspaceLayout | undefined): string[] {
    if (!layout?.root) return [];
    const ids: string[] = [];
    function walk(node: LayoutNode) {
      if (node.type === "group") {
        for (const pane of (node as PaneGroup).panes) {
          if (pane.ptyId) ids.push(pane.ptyId);
        }
      } else if (node.type === "split") {
        for (const child of node.children) walk(child);
      }
    }
    walk(layout.root);
    return ids;
  }
```

Also collect PTY IDs from flight pods (check `flightLayouts[workspaceId]` for pod PTY IDs — each pod may have shell tabs with PTY IDs).

The useEffect:

```typescript
  useEffect(() => {
    if (!activeWorkspaceId) return;
    const state = useWorkspaceStore.getState();

    // Resume monitors for active workspace
    const activeLayout = state.layouts[activeWorkspaceId];
    const activePtyIds = collectPtyIds(activeLayout);
    // Also collect flight pod PTY IDs for this workspace
    const flightLayout = state.flightLayouts[activeWorkspaceId];
    if (flightLayout?.pods) {
      for (const pod of Object.values(flightLayout.pods)) {
        // Pod layouts use "flight:{podId}" as layout key
        const podLayout = state.layouts[`flight:${pod.id}`];
        activePtyIds.push(...collectPtyIds(podLayout));
        // Shell tabs
        if ('shellTabs' in pod && pod.shellTabs) {
          for (const tab of pod.shellTabs) {
            if (tab.ptyId) activePtyIds.push(tab.ptyId);
          }
        }
        if ('shellPtyId' in pod && pod.shellPtyId) {
          activePtyIds.push(pod.shellPtyId);
        }
      }
    }

    for (const id of activePtyIds) {
      api.resumePtyMonitor(id).catch(() => {});
    }

    // Pause monitors for all other workspaces
    for (const ws of state.workspaces) {
      if (ws.id === activeWorkspaceId) continue;
      const layout = state.layouts[ws.id];
      const inactivePtyIds = collectPtyIds(layout);
      const inactiveFlightLayout = state.flightLayouts[ws.id];
      if (inactiveFlightLayout?.pods) {
        for (const pod of Object.values(inactiveFlightLayout.pods)) {
          const podLayout = state.layouts[`flight:${pod.id}`];
          inactivePtyIds.push(...collectPtyIds(podLayout));
          if ('shellTabs' in pod && pod.shellTabs) {
            for (const tab of pod.shellTabs) {
              if (tab.ptyId) inactivePtyIds.push(tab.ptyId);
            }
          }
          if ('shellPtyId' in pod && pod.shellPtyId) {
            inactivePtyIds.push(pod.shellPtyId);
          }
        }
      }
      for (const id of inactivePtyIds) {
        api.pausePtyMonitor(id).catch(() => {});
      }
    }
  }, [activeWorkspaceId]);
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
./scripts/check.sh
```

Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tauri.ts src/components/Terminal.tsx src/App.tsx
git commit -m "feat: wire up PTY monitor pause/resume from frontend based on visibility"
```

---

## Task 10: Final verification and cleanup

- [ ] **Step 1: Run full type check**

```bash
./scripts/check.sh
```

Expected: no errors in TypeScript or Rust.

- [ ] **Step 2: Search for any remaining ship references**

```bash
grep -ri "ship" src/ src-tauri/src/ --include="*.ts" --include="*.tsx" --include="*.rs" | grep -v node_modules | grep -v target | grep -v ".md"
```

Expected: no ship references remain (except possibly the word "relationship" or similar false positives).

- [ ] **Step 3: Search for dead imports**

Check that no file imports deleted types or components:

```bash
grep -r "ShipStatusPill\|ScriptEditor\|ShipSignal\|ShipSession\|ShipStatus\|ShipPhase\|ShipDetailPhase\|shipOutputBuffer\|RallyScriptInfo" src/ --include="*.ts" --include="*.tsx"
```

Expected: no matches.

- [ ] **Step 4: Commit any final cleanup**

```bash
git add -A
git commit -m "chore: final cleanup of ship removal and PTY monitoring"
```

---

## Task 11: Create PR

- [ ] **Step 1: Push branch and create PR**

```bash
git push -u origin perf/remove-ship-smart-pty-monitoring
```

Create PR with summary of both changes: ship removal (reduced code/complexity) and smart PTY monitoring (reduced CPU from ~36 monitor threads to only visible ones).
