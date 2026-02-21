import { create } from "zustand";
import { persist } from "zustand/middleware";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { addToast } from "../components/ToastContainer";
import type {
  Workspace,
  GitStatus,
  PrStatus,
  PushResult,
  Pane,
  WorkspaceLayout,
  LayoutNode,
  SplitDirection,
  PaneGroup,
  ScriptRun,
  ShipStatus,
  ShipSession,
  ShipDetailPhase,
} from "../lib/types";
import {
  createDefaultLayout,
  replaceNode,
  findParent,
  findFirstGroupInSubtree,
} from "../lib/types";
import { api } from "../lib/tauri";

/**
 * Ship PTY output buffer — stored outside Zustand state to avoid O(n) array
 * copies and React re-renders on every PTY output chunk. The store listener
 * pushes raw bytes here; ShipTerminalView polls it directly.
 */
export const shipOutputBuffer: Uint8Array[] = [];

/**
 * Script PTY output buffers — stored outside Zustand state (like shipOutputBuffer)
 * to avoid O(n) array copies and React re-renders on every PTY output chunk.
 * Keyed by "rootPath:scriptName".
 */
export const scriptOutputBuffers = new Map<string, Uint8Array[]>();

const WINDOW_PERSIST_KEY = (() => {
  try {
    return `rally-state:${getCurrentWindow().label}`;
  } catch {
    return "rally-state:main";
  }
})();


interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  /** Git status keyed by repo path */
  gitStatuses: Record<string, GitStatus>;
  /** PR status keyed by repo path */
  prStatuses: Record<string, PrStatus | null>;
  /** Repo paths that need sync after a merge */
  syncNeeded: Record<string, boolean>;
  /** Which repo path is active per workspace (index into ws.paths) */
  activePathIndex: Record<string, number>;
  layouts: Record<string, WorkspaceLayout>;
  /** Tracks the last-focused group per workspace for Cmd+W etc. */
  activeGroupIds: Record<string, string>;
  /** Active script runs keyed by "rootPath:scriptName" */
  scriptRuns: Record<string, ScriptRun>;
  /** Ship status keyed by repo path */
  shipStatuses: Record<string, ShipStatus>;
  /** Active ship session (detached PTY running /ship) */
  shipSession: ShipSession | null;
  /** File path to reveal in explorer (set on explicit reveal, auto-clears) */
  revealedFilePath: string | null;
  loading: boolean;

  // Workspace actions
  loadWorkspaces: (options?: { keepNullActive?: boolean }) => Promise<void>;
  setActive: (id: string | null) => void;
  setActivePathIndex: (workspaceId: string, index: number) => void;
  /** Get the currently active repo path for a workspace */
  getActivePath: (workspaceId: string) => string | null;
  addWorkspace: (params: {
    name: string;
    paths: string[];
  }) => Promise<void>;
  removeWorkspace: (id: string) => Promise<void>;
  addPathToWorkspace: (id: string, path: string) => Promise<void>;
  removePathFromWorkspace: (id: string, path: string) => Promise<void>;

  // Git actions (all keyed by repo path)
  refreshGitStatusForPath: (path: string, mainBranch: string) => Promise<void>;
  refreshAllGitStatuses: () => Promise<void>;
  refreshPrStatusForPath: (path: string) => Promise<void>;
  refreshAllPrStatuses: () => Promise<void>;
  syncPath: (path: string, branch: string, mainBranch: string) => Promise<string>;
  /** Full sync: rebase onto main + smart push to remote. Clears syncNeeded. */
  syncAndPushPath: (path: string, branch: string, mainBranch: string) => Promise<string>;
  rebasePath: (path: string, branch: string, mainBranch: string) => Promise<string>;
  commitPath: (path: string, message: string) => Promise<string>;
  pushPath: (path: string) => Promise<PushResult>;
  createPrForPath: (path: string, title?: string, body?: string) => Promise<string>;
  mergePrForPath: (path: string, method?: string) => Promise<string>;

  // Layout actions
  getOrCreateLayout: (workspaceId: string) => WorkspaceLayout;
  splitGroup: (
    workspaceId: string,
    groupId: string,
    direction: SplitDirection,
    cwd?: string
  ) => void;
  closePane: (
    workspaceId: string,
    groupId: string,
    paneId: string
  ) => void;
  closeGroup: (workspaceId: string, groupId: string) => void;
  reorderPanes: (
    workspaceId: string,
    groupId: string,
    fromIndex: number,
    toIndex: number
  ) => void;
  addPaneToGroup: (
    workspaceId: string,
    groupId: string,
    pane: Pane
  ) => void;
  setActivePane: (
    workspaceId: string,
    groupId: string,
    paneId: string
  ) => void;
  updateSplitRatio: (
    workspaceId: string,
    splitId: string,
    ratio: number
  ) => void;
  transformPane: (
    workspaceId: string,
    groupId: string,
    paneId: string,
    updates: Partial<Pane>
  ) => void;
  /** Close the active pane in the last-focused group */
  closeActiveTab: (workspaceId: string) => void;
  /** Open a file in an editor pane in the top area of the layout */
  openFile: (workspaceId: string, filePath: string) => void;
  /** Reveal a file in the explorer (expand ancestors + highlight) */
  revealFileInExplorer: (filePath: string) => void;
  /** Open a diff view for a repo path */
  openDiff: (workspaceId: string, rootPath: string) => void;
  // Ship actions
  pollShipSignals: () => Promise<void>;
  handleAutoMerge: (repoPath: string) => Promise<void>;
  /** Spawn a detached PTY running /ship. Shows status pill. */
  startShipSession: (repoPath: string) => Promise<void>;
  /** Dock the ship terminal into the top-left pane group */
  dockShipSession: (workspaceId: string) => void;
  /** Kill PTY and clear ship session */
  dismissShipSession: () => void;

  /** Open a Claude pane that auto-sends a slash command. Does NOT steal focus. */
  openClaudeCommand: (workspaceId: string, cwd: string, slashCommand: string, title: string) => void;

  // Script runner actions
  runScript: (rootPath: string, scriptName: string, command: string) => Promise<void>;
  stopScript: (rootPath: string, scriptName: string) => Promise<void>;
  clearScript: (rootPath: string, scriptName: string) => void;
  /** Open a terminal pane connected to a running script's PTY */
  openScriptTerminal: (workspaceId: string, rootPath: string, scriptName: string) => void;

  /** Move a pane from one group into a new split on a target group */
  dropPaneOnGroup: (
    workspaceId: string,
    sourceGroupId: string,
    sourcePaneId: string,
    targetGroupId: string,
    position: "top" | "bottom" | "left" | "right" | "center"
  ) => void;

  /** Drop file(s) onto a pane group — center adds tab(s), edge creates a split */
  dropFileOnGroup: (
    workspaceId: string,
    targetGroupId: string,
    filePaths: string[],
    position: "top" | "bottom" | "left" | "right" | "center"
  ) => void;
}

/** On restore, convert active claude sessions back to launchers (fresh start). */
function restoreLayouts(layouts: Record<string, WorkspaceLayout>): Record<string, WorkspaceLayout> {
  const restored: Record<string, WorkspaceLayout> = {};
  for (const [wsId, layout] of Object.entries(layouts)) {
    const groups: Record<string, PaneGroup> = {};
    for (const [gId, group] of Object.entries(layout.groups)) {
      groups[gId] = {
        ...group,
        panes: group.panes.map((p) => {
          // Strip stale ptyIds — PTYs don't survive app restart
          const { ptyId: _, ...rest } = p;
          return rest.type === "claude"
            ? { ...rest, type: "claude-launcher" as const, command: undefined }
            : rest;
        }),
      };
    }
    restored[wsId] = { root: layout.root, groups };
  }
  return restored;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function gitStatusEqual(a: GitStatus, b: GitStatus): boolean {
  return (
    a.branch === b.branch &&
    a.dirty === b.dirty &&
    a.ahead === b.ahead &&
    a.behind === b.behind &&
    arraysEqual(a.modified_files, b.modified_files) &&
    arraysEqual(a.untracked_files, b.untracked_files)
  );
}

function prStatusEqual(a: PrStatus | null, b: PrStatus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.number === b.number &&
    a.title === b.title &&
    a.url === b.url &&
    a.state === b.state &&
    a.is_draft === b.is_draft &&
    a.mergeable === b.mergeable &&
    a.review_decision === b.review_decision &&
    a.checks_status === b.checks_status
  );
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  gitStatuses: {},
  prStatuses: {},
  syncNeeded: {},
  activePathIndex: {},
  layouts: {},
  activeGroupIds: {},
  scriptRuns: {},
  shipStatuses: {},
  shipSession: null,
  revealedFilePath: null,
  loading: false,

  // --- Workspace actions ---

  loadWorkspaces: async (options) => {
    const keepNullActive = options?.keepNullActive ?? false;
    set({ loading: true });
    const workspaces = await api.listWorkspaces();
    const currentActive = get().activeWorkspaceId;
    const activeExists =
      currentActive !== null && workspaces.some((w) => w.id === currentActive);
    set({
      workspaces,
      loading: false,
      activeWorkspaceId:
        keepNullActive && currentActive === null
          ? null
          : activeExists
            ? currentActive
            : workspaces[0]?.id ?? null,
    });
  },

  setActive: (id) => set({ activeWorkspaceId: id }),

  setActivePathIndex: (workspaceId, index) =>
    set((s) => ({ activePathIndex: { ...s.activePathIndex, [workspaceId]: index } })),

  getActivePath: (workspaceId) => {
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    if (!ws || ws.paths.length === 0) return null;
    const idx = get().activePathIndex[workspaceId] ?? 0;
    return ws.paths[idx] ?? ws.paths[0];
  },

  addWorkspace: async (params) => {
    await api.createWorkspace(params);
    await get().loadWorkspaces();
  },

  addPathToWorkspace: async (id, path) => {
    await api.addWorkspacePath(id, path);
    await get().loadWorkspaces();
  },

  removePathFromWorkspace: async (id, path) => {
    await api.removeWorkspacePath(id, path);
    await get().loadWorkspaces();
  },

  removeWorkspace: async (id) => {
    await api.removeWorkspace(id);
    const remaining = get().workspaces.filter((w) => w.id !== id);
    const { layouts, ...rest } = get();
    const newLayouts = { ...layouts };
    delete newLayouts[id];
    set({
      ...rest,
      workspaces: remaining,
      layouts: newLayouts,
      activeWorkspaceId:
        get().activeWorkspaceId === id
          ? remaining[0]?.id ?? null
          : get().activeWorkspaceId,
    });
  },

  // --- Git actions (all keyed by repo path) ---

  refreshGitStatusForPath: async (path, mainBranch) => {
    try {
      const status = await api.gitStatus(path, mainBranch);
      // Skip update if nothing changed — prevents unnecessary re-renders
      const prev = get().gitStatuses[path];
      if (prev && gitStatusEqual(prev, status)) return;
      set((s) => ({ gitStatuses: { ...s.gitStatuses, [path]: status } }));
    } catch (e) {
      console.error(`Failed to get git status for ${path}:`, e);
    }
  },

  refreshAllGitStatuses: async () => {
    const workspaces = get().workspaces;
    const promises: Promise<void>[] = [];
    for (const ws of workspaces) {
      for (const path of ws.paths) {
        promises.push(get().refreshGitStatusForPath(path, ws.main_branch));
      }
    }
    await Promise.all(promises);
  },

  refreshPrStatusForPath: async (path) => {
    try {
      const prStatus = await api.gitPrStatus(path);
      // Skip update if nothing changed — prevents unnecessary re-renders
      const prev = get().prStatuses[path];
      if (prStatusEqual(prev ?? null, prStatus)) return;
      set((s) => ({ prStatuses: { ...s.prStatuses, [path]: prStatus } }));
    } catch {
      const prev = get().prStatuses[path];
      if (prev === null) return;
      set((s) => ({ prStatuses: { ...s.prStatuses, [path]: null } }));
    }
  },

  refreshAllPrStatuses: async () => {
    const workspaces = get().workspaces;
    const promises: Promise<void>[] = [];
    for (const ws of workspaces) {
      for (const path of ws.paths) {
        promises.push(get().refreshPrStatusForPath(path));
      }
    }
    await Promise.all(promises);
  },

  syncPath: async (path, branch, mainBranch) => {
    const result = await api.gitSync(path, branch, mainBranch);
    await get().refreshGitStatusForPath(path, mainBranch);
    return result;
  },

  syncAndPushPath: async (path, branch, mainBranch) => {
    await api.gitSync(path, branch, mainBranch);
    await api.gitPush(path);
    set((s) => ({ syncNeeded: { ...s.syncNeeded, [path]: false } }));
    await get().refreshGitStatusForPath(path, mainBranch);
    await get().refreshPrStatusForPath(path);
    return "Synced and pushed";
  },

  rebasePath: async (path, branch, mainBranch) => {
    const result = await api.gitRebase(path, branch, mainBranch);
    await get().refreshGitStatusForPath(path, mainBranch);
    return result;
  },

  commitPath: async (path, message) => {
    const result = await api.gitCommit(path, message);
    // Find main_branch for this path
    const ws = get().workspaces.find((w) => w.paths.includes(path));
    if (ws) await get().refreshGitStatusForPath(path, ws.main_branch);
    return result;
  },

  pushPath: async (path) => {
    const result = await api.gitPush(path);
    const ws = get().workspaces.find((w) => w.paths.includes(path));
    if (ws) await get().refreshGitStatusForPath(path, ws.main_branch);
    return result;
  },

  createPrForPath: async (path, title, body) => {
    const result = await api.gitCreatePr(path, title, body);
    await get().refreshPrStatusForPath(path);
    return result;
  },

  mergePrForPath: async (path, method) => {
    const result = await api.gitMergePr(path, method ?? "squash");
    // Mark all paths with same repo URL as needing sync
    // Skip if repo_url is empty — repos without a remote aren't related
    const ws = get().workspaces.find((w) => w.paths.includes(path));
    if (ws && ws.repo_url) {
      const allPaths = get().workspaces
        .filter((w) => w.repo_url === ws.repo_url)
        .flatMap((w) => w.paths);
      set((s) => {
        const newSyncNeeded = { ...s.syncNeeded };
        for (const p of allPaths) newSyncNeeded[p] = true;
        return { syncNeeded: newSyncNeeded };
      });
      await get().refreshGitStatusForPath(path, ws.main_branch);
    }
    await get().refreshPrStatusForPath(path);
    return result;
  },

  // --- Layout actions ---


  // --- Ship actions ---

  pollShipSignals: async () => {
    // Check for trigger files from the `ship` zsh alias
    try {
      const triggerPath = await api.checkShipTrigger();
      if (triggerPath && !get().shipSession) {
        get().startShipSession(triggerPath);
      }
    } catch { /* trigger check failed — ignore */ }

    const workspaces = get().workspaces;
    const allPaths = new Set<string>();
    for (const ws of workspaces) {
      for (const p of ws.paths) allPaths.add(p);
    }

    for (const repoPath of allPaths) {
      const currentStatus = get().shipStatuses[repoPath];
      // Skip paths already in merging/syncing phase (app is handling them)
      if (currentStatus?.phase === "merging" || currentStatus?.phase === "syncing") continue;

      try {
        const signal = await api.checkShipSignal(repoPath);
        if (!signal) {
          // No signal — if we were tracking this path, clear it
          if (currentStatus && currentStatus.phase !== "idle") {
            set((s) => ({
              shipStatuses: { ...s.shipStatuses, [repoPath]: { phase: "idle" } },
            }));
          }
          continue;
        }

        // If there's an active ship session for this repo, attach the signal to it
        const session = get().shipSession;
        if (session && session.repoPath === repoPath && !session.signal) {
          set((s) => ({
            shipSession: s.shipSession ? {
              ...s.shipSession,
              signal,
              phase: signal.verdict === "manual_review" ? "complete" : s.shipSession.phase,
            } : null,
          }));
        }

        if (signal.verdict === "auto_merge") {
          // Trigger auto-merge flow
          set((s) => ({
            shipStatuses: {
              ...s.shipStatuses,
              [repoPath]: { phase: "merging", signal, pr_number: signal.pr_number },
            },
          }));
          addToast({
            type: "info",
            title: `Merging PR #${signal.pr_number}`,
            message: signal.summary || "Auto-merging approved PR",
            actions: signal.pr_url
              ? [{ label: "View PR", onClick: () => invoke("plugin:shell|open", { path: signal.pr_url }) }]
              : undefined,
          });
          // Don't await — let it run async
          get().handleAutoMerge(repoPath);
        } else if (signal.verdict === "manual_review") {
          // Only notify on transition into awaiting_review (not every poll)
          // Skip toast if there's an active ship session for this repo (the card handles it)
          const hasShipSession = get().shipSession?.repoPath === repoPath;
          if (currentStatus?.phase !== "awaiting_review" && !hasShipSession) {
            const items = signal.flagged_items?.length ?? 0;
            const message = items > 0
              ? `${items} flagged item${items !== 1 ? "s" : ""}: ${signal.summary}`
              : signal.summary || "Manual review required";

            const actions: { label: string; onClick: () => void }[] = [];
            if (signal.pr_url) {
              actions.push({ label: "View PR", onClick: () => invoke("plugin:shell|open", { path: signal.pr_url }) });
            }

            addToast({
              type: "warning",
              title: `Review Needed — PR #${signal.pr_number}`,
              message,
              actions: actions.length > 0 ? actions : undefined,
              duration: 0, // persistent — user needs to act
            });
          }
          set((s) => ({
            shipStatuses: {
              ...s.shipStatuses,
              [repoPath]: { phase: "awaiting_review", signal, pr_number: signal.pr_number },
            },
          }));
          // Clear signal file so we don't re-toast on app restart
          await api.clearShipSignal(repoPath).catch(() => {});
        }
      } catch {
        // Signal check failed — ignore silently
      }
    }
  },

  handleAutoMerge: async (repoPath) => {
    const signal = get().shipStatuses[repoPath]?.signal;
    if (!signal) return;

    const ws = get().workspaces.find((w) => w.paths.includes(repoPath));
    const mainBranch = ws?.main_branch ?? "main";

    try {
      // Phase: merging
      set((s) => ({
        shipStatuses: {
          ...s.shipStatuses,
          [repoPath]: { phase: "merging", signal, pr_number: signal.pr_number },
        },
      }));

      // Merge the PR
      await api.gitMergePr(repoPath, "squash");

      // Phase: syncing
      set((s) => ({
        shipStatuses: {
          ...s.shipStatuses,
          [repoPath]: { phase: "syncing", signal, pr_number: signal.pr_number },
        },
      }));

      // Auto-sync the shipping branch back to main
      await api.postMergeSync(repoPath, mainBranch, signal.branch);

      // Mark related repos (same remote, different paths) as needing sync
      // Skip if repo_url is empty — repos without a remote aren't related
      if (ws && ws.repo_url) {
        const relatedPaths = get().workspaces
          .filter((w) => w.repo_url === ws.repo_url)
          .flatMap((w) => w.paths)
          .filter((p) => p !== repoPath);

        if (relatedPaths.length > 0) {
          set((s) => {
            const newSyncNeeded = { ...s.syncNeeded };
            for (const p of relatedPaths) newSyncNeeded[p] = true;
            return { syncNeeded: newSyncNeeded };
          });
        }
      }

      // Clear signal file
      await api.clearShipSignal(repoPath);

      // Refresh git status
      await get().refreshGitStatusForPath(repoPath, mainBranch);
      await get().refreshPrStatusForPath(repoPath);

      // Notify that merge + sync completed
      addToast({
        type: "success",
        title: `PR #${signal.pr_number} Merged`,
        message: `Branch synced with ${mainBranch} and ready to work on`,
        actions: signal.pr_url
          ? [{ label: "View PR", onClick: () => invoke("plugin:shell|open", { path: signal.pr_url }) }]
          : undefined,
      });

      // Done
      set((s) => ({
        shipStatuses: { ...s.shipStatuses, [repoPath]: { phase: "idle" } },
      }));
    } catch (e) {
      console.error(`Auto-merge failed for ${repoPath}:`, e);
      // Revert to showing signal so user can see what happened
      set((s) => ({
        shipStatuses: {
          ...s.shipStatuses,
          [repoPath]: { phase: "awaiting_review", signal, pr_number: signal.pr_number },
        },
      }));
    }
  },

  startShipSession: async (repoPath) => {
    // Don't start a second session
    if (get().shipSession) return;

    // Clear any stale signal file from a previous ship run for this repo
    await api.clearShipSignal(repoPath).catch(() => {});
    // Clear stale ship status
    set((s) => ({
      shipStatuses: { ...s.shipStatuses, [repoPath]: { phase: "idle" } },
    }));

    try {
      // Spawn at 80x24 (standard size). The floating terminal will resize
      // the PTY when opened — going wider is clean, going narrower garbles.
      const ptyId = await api.spawnPty(
        repoPath,
        'claude --dangerously-skip-permissions "/ship"',
        80,
        24
      );

      // Reset the module-level output buffer (outside Zustand to avoid
      // O(n) array copies and React re-renders on every PTY chunk)
      shipOutputBuffer.length = 0;

      set({
        shipSession: {
          ptyId,
          repoPath,
          phase: "detecting",
          exited: false,
          exitCode: null,
          docked: false,
        },
      });

      // Listen for PTY output — buffer raw bytes and parse phase markers
      const phaseRegex = /<<RALLY_PHASE:(\w+)>>/;
      const unlistenOutput = await listen<{ data: number[] }>(
        `pty-output-${ptyId}`,
        (event) => {
          const chunk = new Uint8Array(event.payload.data);

          // Scan for phase markers in this chunk
          const text = new TextDecoder().decode(chunk);
          const match = phaseRegex.exec(text);
          if (match) {
            const phase = match[1] as ShipDetailPhase;
            set((s) => {
              if (!s.shipSession || s.shipSession.ptyId !== ptyId) return s;
              return { shipSession: { ...s.shipSession, phase } };
            });
          }

          // Buffer raw bytes in the module-level array (not Zustand state).
          // This avoids O(n) array copies and React re-renders on every chunk,
          // which was causing lag across all terminals and editors.
          shipOutputBuffer.push(chunk);
        }
      );

      // Listen for PTY exit
      const unlistenExit = await listen<{ code: number | null }>(
        `pty-exit-${ptyId}`,
        (event) => {
          set((s) => {
            if (!s.shipSession || s.shipSession.ptyId !== ptyId) return s;
            return {
              shipSession: {
                ...s.shipSession,
                exited: true,
                exitCode: event.payload.code,
                // Show "finishing" until we detect the signal with the verdict
                phase: s.shipSession.signal ? s.shipSession.phase : "finishing",
              },
            };
          });
          unlistenOutput();
          unlistenExit();
          // Immediately poll for the signal instead of waiting up to 5s
          setTimeout(() => get().pollShipSignals(), 500);
        }
      );
    } catch (e) {
      console.error("Failed to start ship session:", e);
      set({ shipSession: null });
    }
  },

  dockShipSession: (workspaceId) => {
    const session = get().shipSession;
    if (!session) return;

    const layout = get().getOrCreateLayout(workspaceId);

    // Find the top-left pane group (same logic as openFile)
    let targetGroupId: string | null = null;
    const root = layout.root;
    if (root.type === "split" && root.direction === "vertical") {
      targetGroupId = findFirstGroupInSubtree(root.children[0]);
    }
    if (!targetGroupId) {
      targetGroupId = findFirstGroupInSubtree(root);
    }
    if (!targetGroupId) return;

    const repoName = session.repoPath.split("/").pop() ?? "Ship";
    const pane: Pane = {
      id: crypto.randomUUID(),
      type: "claude",
      title: `Ship: ${repoName}`,
      cwd: session.repoPath,
      ptyId: session.ptyId,
    };

    get().addPaneToGroup(workspaceId, targetGroupId, pane);
    set((s) => ({
      shipSession: s.shipSession ? { ...s.shipSession, docked: true } : null,
    }));
  },

  dismissShipSession: () => {
    const session = get().shipSession;
    if (!session) return;
    if (!session.exited) {
      api.killPty(session.ptyId).catch(() => {});
    }
    shipOutputBuffer.length = 0;
    set({ shipSession: null });
  },

  openClaudeCommand: (workspaceId, cwd, slashCommand, title) => {
    const layout = get().getOrCreateLayout(workspaceId);

    // Find a group in the bottom area of the layout to add the pane
    let targetGroupId: string | null = null;
    const root = layout.root;
    if (root.type === "split" && root.direction === "vertical") {
      targetGroupId = findFirstGroupInSubtree(root.children[1]);
    }
    if (!targetGroupId) {
      targetGroupId = findFirstGroupInSubtree(root);
    }
    if (!targetGroupId) return;

    const pane: Pane = {
      id: crypto.randomUUID(),
      type: "claude",
      title,
      command: `claude --dangerously-skip-permissions "${slashCommand}"`,
      cwd,
    };

    // Add pane to group and switch to it (user explicitly clicked the command)
    const group = layout.groups[targetGroupId];
    if (!group) return;
    set((s) => ({
      layouts: {
        ...s.layouts,
        [workspaceId]: {
          ...layout,
          groups: {
            ...layout.groups,
            [targetGroupId]: {
              ...group,
              panes: [...group.panes, pane],
              activePaneId: pane.id,
            },
          },
        },
      },
    }));
  },

  // --- Script runner actions ---

  runScript: async (rootPath, scriptName, command) => {
    const key = `${rootPath}:${scriptName}`;

    // Kill existing run if any
    const existing = get().scriptRuns[key];
    if (existing && existing.status === "running") {
      await api.killPty(existing.ptyId);
    }

    const ptyId = await api.spawnPty(rootPath, command, 120, 40, true);

    // Reset module-level output buffer (outside Zustand to avoid
    // O(n) array copies and React re-renders on every PTY chunk)
    scriptOutputBuffers.set(key, []);

    set((s) => ({
      scriptRuns: {
        ...s.scriptRuns,
        [key]: { scriptName, ptyId, status: "running", exitCode: null },
      },
    }));

    // Buffer PTY output in module-level array (not Zustand state)
    const unlistenOutput = await listen<{ data: number[] }>(
      `pty-output-${ptyId}`,
      (event) => {
        const buf = scriptOutputBuffers.get(key);
        if (buf) buf.push(new Uint8Array(event.payload.data));
      }
    );

    // Listen for exit event to update status
    const unlistenExit = await listen<{ code: number | null }>(
      `pty-exit-${ptyId}`,
      (event) => {
        const code = event.payload.code;
        set((s) => ({
          scriptRuns: {
            ...s.scriptRuns,
            [key]: {
              ...s.scriptRuns[key],
              status: code === 0 ? "success" : "error",
              exitCode: code,
            },
          },
        }));
        unlistenOutput();
        unlistenExit();
      }
    );
  },

  stopScript: async (rootPath, scriptName) => {
    const key = `${rootPath}:${scriptName}`;
    const run = get().scriptRuns[key];
    if (!run) return;
    await api.killPty(run.ptyId);

    // Close any open terminal panes connected to this PTY
    const layouts = get().layouts;
    for (const [wsId, layout] of Object.entries(layouts)) {
      for (const [gId, group] of Object.entries(layout.groups)) {
        const pane = group.panes.find((p) => p.ptyId === run.ptyId);
        if (pane) {
          get().closePane(wsId, gId, pane.id);
        }
      }
    }

    set((s) => ({
      scriptRuns: {
        ...s.scriptRuns,
        [key]: { ...run, status: "stopped" },
      },
    }));
  },

  clearScript: (rootPath, scriptName) => {
    const key = `${rootPath}:${scriptName}`;
    scriptOutputBuffers.delete(key);
    set((s) => {
      const { [key]: _, ...rest } = s.scriptRuns;
      return { scriptRuns: rest };
    });
  },

  openScriptTerminal: (workspaceId, rootPath, scriptName) => {
    const key = `${rootPath}:${scriptName}`;
    const run = get().scriptRuns[key];
    if (!run) return;

    const layout = get().getOrCreateLayout(workspaceId);

    // Find the active group, or fall back to the first group
    const activeGroupId = get().activeGroupIds[workspaceId];
    let targetGroupId = activeGroupId && layout.groups[activeGroupId]
      ? activeGroupId
      : findFirstGroupInSubtree(layout.root);
    if (!targetGroupId) return;

    // Don't open a duplicate — if a terminal pane already exists for this ptyId, switch to it
    const group = layout.groups[targetGroupId];
    if (group) {
      const existing = group.panes.find((p) => p.ptyId === run.ptyId);
      if (existing) {
        get().setActivePane(workspaceId, targetGroupId, existing.id);
        return;
      }
    }

    const pane: Pane = {
      id: crypto.randomUUID(),
      type: "terminal",
      title: scriptName,
      cwd: rootPath,
      ptyId: run.ptyId,
      scriptBufferKey: key,
    };

    get().addPaneToGroup(workspaceId, targetGroupId, pane);
  },

  getOrCreateLayout: (workspaceId) => {
    const existing = get().layouts[workspaceId];
    if (existing) return existing;
    const layout = createDefaultLayout();
    set((s) => ({
      layouts: { ...s.layouts, [workspaceId]: layout },
    }));
    return layout;
  },

  splitGroup: (workspaceId, groupId, direction, cwd?) => {
    const layout = get().getOrCreateLayout(workspaceId);
    // Create a new group with a terminal pane
    const newPane: Pane = {
      id: crypto.randomUUID(),
      type: "terminal",
      title: "Terminal",
      ...(cwd ? { cwd } : {}),
    };
    const newGroup: PaneGroup = {
      id: crypto.randomUUID(),
      panes: [newPane],
      activePaneId: newPane.id,
    };
    // Replace the group leaf with a split containing original + new group
    const splitNode: LayoutNode = {
      type: "split",
      id: crypto.randomUUID(),
      direction,
      children: [
        { type: "group", groupId },
        { type: "group", groupId: newGroup.id },
      ],
      ratio: 0.5,
    };
    const newRoot = replaceNode(layout.root, groupId, splitNode);
    set((s) => ({
      activeGroupIds: { ...s.activeGroupIds, [workspaceId]: newGroup.id },
      layouts: {
        ...s.layouts,
        [workspaceId]: {
          root: newRoot,
          groups: { ...layout.groups, [newGroup.id]: newGroup },
        },
      },
    }));
  },

  closePane: (workspaceId, groupId, paneId) => {
    const layout = get().getOrCreateLayout(workspaceId);
    const group = layout.groups[groupId];
    if (!group) return;

    // Kill PTY if the pane has one (store-managed lifecycle)
    const closingPane = group.panes.find((p) => p.id === paneId);
    if (closingPane?.ptyId) {
      api.killPty(closingPane.ptyId).catch(() => {});
    }

    if (group.panes.length <= 1) {
      // Last pane in group — collapse it if there are sibling panels,
      // otherwise keep empty state (can't remove the only panel)
      const parentInfo = findParent(layout.root, groupId);
      if (parentInfo) {
        get().closeGroup(workspaceId, groupId);
      }
      // Root (only panel) — just do nothing, keep the group with its last pane
      return;
    }

    // Remove the pane from the group
    const newPanes = group.panes.filter((p) => p.id !== paneId);
    // Remove closed pane from MRU history
    const newHistory = (group.paneHistory ?? []).filter((id) => id !== paneId);
    const remainingIds = new Set(newPanes.map((p) => p.id));

    let newActive = group.activePaneId;
    if (group.activePaneId === paneId) {
      // Walk MRU history backwards to find the most recent still-open pane
      let found: string | null = null;
      for (let i = newHistory.length - 1; i >= 0; i--) {
        if (remainingIds.has(newHistory[i])) {
          found = newHistory[i];
          break;
        }
      }
      newActive = found ?? newPanes[0].id;
    }

    set((s) => ({
      layouts: {
        ...s.layouts,
        [workspaceId]: {
          ...layout,
          groups: {
            ...layout.groups,
            [groupId]: {
              ...group,
              panes: newPanes,
              activePaneId: newActive,
              paneHistory: newHistory,
            },
          },
        },
      },
    }));
  },

  closeGroup: (workspaceId, groupId) => {
    const layout = get().getOrCreateLayout(workspaceId);

    // Kill all PTYs in this group (store-managed lifecycle)
    const group = layout.groups[groupId];
    if (group) {
      for (const pane of group.panes) {
        if (pane.ptyId) api.killPty(pane.ptyId).catch(() => {});
      }
    }

    const parentInfo = findParent(layout.root, groupId);

    if (!parentInfo) {
      // This is the root group — can't close it, reset to default
      const newLayout = createDefaultLayout();
      set((s) => ({
        layouts: { ...s.layouts, [workspaceId]: newLayout },
      }));
      return;
    }

    // Replace the parent split with the sibling
    const siblingIndex = parentInfo.index === 0 ? 1 : 0;
    const sibling = parentInfo.parent.children[siblingIndex];
    const newRoot = replaceNode(layout.root, parentInfo.parent.id, sibling);

    // Remove the closed group from the groups map
    const newGroups = { ...layout.groups };
    delete newGroups[groupId];

    set((s) => ({
      layouts: {
        ...s.layouts,
        [workspaceId]: { root: newRoot, groups: newGroups },
      },
    }));
  },

  reorderPanes: (workspaceId, groupId, fromIndex, toIndex) => {
    const layout = get().getOrCreateLayout(workspaceId);
    const group = layout.groups[groupId];
    if (!group) return;
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || fromIndex >= group.panes.length) return;
    if (toIndex < 0 || toIndex >= group.panes.length) return;

    const newPanes = [...group.panes];
    const [moved] = newPanes.splice(fromIndex, 1);
    newPanes.splice(toIndex, 0, moved);

    set((s) => ({
      layouts: {
        ...s.layouts,
        [workspaceId]: {
          ...layout,
          groups: {
            ...layout.groups,
            [groupId]: { ...group, panes: newPanes },
          },
        },
      },
    }));
  },

  addPaneToGroup: (workspaceId, groupId, pane) => {
    const layout = get().getOrCreateLayout(workspaceId);
    const group = layout.groups[groupId];
    if (!group) return;

    // Push new pane onto MRU history
    const history = [...(group.paneHistory ?? []), pane.id];

    set((s) => ({
      activeGroupIds: { ...s.activeGroupIds, [workspaceId]: groupId },
      layouts: {
        ...s.layouts,
        [workspaceId]: {
          ...layout,
          groups: {
            ...layout.groups,
            [groupId]: {
              ...group,
              panes: [...group.panes, pane],
              activePaneId: pane.id,
              paneHistory: history,
            },
          },
        },
      },
    }));
  },

  setActivePane: (workspaceId, groupId, paneId) => {
    const layout = get().getOrCreateLayout(workspaceId);
    const group = layout.groups[groupId];
    if (!group) return;
    const currentActiveGroupId = get().activeGroupIds[workspaceId];
    if (
      group.activePaneId === paneId &&
      currentActiveGroupId === groupId
    ) {
      return;
    }

    // Update MRU history: remove paneId if present, then push to end
    const history = (group.paneHistory ?? []).filter((id) => id !== paneId);
    history.push(paneId);

    set((s) => ({
      activeGroupIds: { ...s.activeGroupIds, [workspaceId]: groupId },
      layouts: {
        ...s.layouts,
        [workspaceId]: {
          ...layout,
          groups: {
            ...layout.groups,
            [groupId]: { ...group, activePaneId: paneId, paneHistory: history },
          },
        },
      },
    }));
  },

  updateSplitRatio: (workspaceId, splitId, ratio) => {
    const layout = get().getOrCreateLayout(workspaceId);
    const clamped = Math.max(0.15, Math.min(0.85, ratio));
    const newRoot = replaceNode(layout.root, splitId, {
      ...findSplitById(layout.root, splitId)!,
      ratio: clamped,
    });
    set((s) => ({
      layouts: {
        ...s.layouts,
        [workspaceId]: { ...layout, root: newRoot },
      },
    }));
  },

  transformPane: (workspaceId, groupId, paneId, updates) => {
    const layout = get().getOrCreateLayout(workspaceId);
    const group = layout.groups[groupId];
    if (!group) return;

    const newPanes = group.panes.map((p) =>
      p.id === paneId ? { ...p, ...updates } : p
    );
    set((s) => ({
      layouts: {
        ...s.layouts,
        [workspaceId]: {
          ...layout,
          groups: {
            ...layout.groups,
            [groupId]: { ...group, panes: newPanes },
          },
        },
      },
    }));
  },

  closeActiveTab: (workspaceId) => {
    const layout = get().getOrCreateLayout(workspaceId);
    const activeGroupId = get().activeGroupIds[workspaceId];

    // Find the group to close the tab in
    let groupId: string | undefined = activeGroupId;
    if (!groupId || !layout.groups[groupId]) {
      groupId = findFirstGroupInSubtree(layout.root) ?? undefined;
    }
    if (!groupId) return;

    const group = layout.groups[groupId];
    if (!group) return;

    get().closePane(workspaceId, groupId, group.activePaneId);
  },

  openFile: (workspaceId, filePath) => {
    const layout = get().getOrCreateLayout(workspaceId);

    // Find target group in the "top" area of the layout
    let targetGroupId: string | null = null;
    const root = layout.root;
    if (root.type === "split" && root.direction === "vertical") {
      targetGroupId = findFirstGroupInSubtree(root.children[0]);
    }
    if (!targetGroupId) {
      targetGroupId = findFirstGroupInSubtree(root);
    }
    if (!targetGroupId) return;

    // Dedup only within the target group — if already open there, just focus it
    const targetGroup = layout.groups[targetGroupId];
    if (targetGroup) {
      const existing = targetGroup.panes.find(
        (p) => p.type === "editor" && p.filePath === filePath
      );
      if (existing) {
        if (
          targetGroup.activePaneId === existing.id &&
          get().activeGroupIds[workspaceId] === targetGroupId
        ) {
          return;
        }
        get().setActivePane(workspaceId, targetGroupId, existing.id);
        return;
      }
    }

    const fileName = filePath.split("/").pop() ?? filePath;
    const pane: Pane = {
      id: crypto.randomUUID(),
      type: "editor",
      title: fileName,
      filePath,
    };
    get().addPaneToGroup(workspaceId, targetGroupId, pane);
  },

  revealFileInExplorer: (filePath) => {
    set({ revealedFilePath: filePath });
    // Auto-clear after the explorer has had time to expand + scroll
    setTimeout(() => set({ revealedFilePath: null }), 1000);
  },

  openDiff: (workspaceId, rootPath) => {
    const layout = get().getOrCreateLayout(workspaceId);

    // Dedup: if a diff pane for this path already exists, focus it
    for (const [gid, group] of Object.entries(layout.groups)) {
      const existing = group.panes.find(
        (p) => p.type === "diff" && p.cwd === rootPath
      );
      if (existing) {
        get().setActivePane(workspaceId, gid, existing.id);
        return;
      }
    }

    // Find target group in the top area
    let targetGroupId: string | null = null;
    const root = layout.root;
    if (root.type === "split" && root.direction === "vertical") {
      targetGroupId = findFirstGroupInSubtree(root.children[0]);
    }
    if (!targetGroupId) {
      targetGroupId = findFirstGroupInSubtree(root);
    }
    if (!targetGroupId) return;

    const folderName = rootPath.split("/").pop() ?? rootPath;
    const pane: Pane = {
      id: crypto.randomUUID(),
      type: "diff",
      title: `Changes: ${folderName}`,
      cwd: rootPath,
    };
    get().addPaneToGroup(workspaceId, targetGroupId, pane);
  },

  dropPaneOnGroup: (workspaceId, sourceGroupId, sourcePaneId, targetGroupId, position) => {
    const layout = get().getOrCreateLayout(workspaceId);
    const sourceGroup = layout.groups[sourceGroupId];
    const targetGroup = layout.groups[targetGroupId];
    if (!sourceGroup || !targetGroup) return;

    const pane = sourceGroup.panes.find((p) => p.id === sourcePaneId);
    if (!pane) return;

    // "center" = move tab to target group (no split)
    if (position === "center") {
      if (sourceGroupId === targetGroupId) return;
      // Add pane to target group
      get().addPaneToGroup(workspaceId, targetGroupId, pane);
      // Remove from source
      get().closePane(workspaceId, sourceGroupId, sourcePaneId);
      return;
    }

    // For top/bottom/left/right: create a new group with this pane, split the target
    const direction: "horizontal" | "vertical" =
      position === "left" || position === "right" ? "horizontal" : "vertical";
    const newFirst = position === "top" || position === "left";

    // Remove pane from source first
    const updatedLayout = get().getOrCreateLayout(workspaceId);
    const updatedSource = updatedLayout.groups[sourceGroupId];
    if (!updatedSource) return;

    // Create a new group for the dropped pane
    const newGroup: PaneGroup = {
      id: crypto.randomUUID(),
      panes: [pane],
      activePaneId: pane.id,
    };

    // Remove pane from source group
    const remainingPanes = updatedSource.panes.filter((p) => p.id !== sourcePaneId);
    let newGroups = { ...updatedLayout.groups, [newGroup.id]: newGroup };
    let newRoot = updatedLayout.root;

    if (remainingPanes.length === 0 && sourceGroupId !== targetGroupId) {
      // Source group is now empty — remove it from the tree
      const parentInfo = findParent(newRoot, sourceGroupId);
      if (parentInfo) {
        const sibIdx = parentInfo.index === 0 ? 1 : 0;
        const sibling = parentInfo.parent.children[sibIdx];
        newRoot = replaceNode(newRoot, parentInfo.parent.id, sibling);
      }
      delete newGroups[sourceGroupId];
    } else if (remainingPanes.length > 0) {
      // Update source group with remaining panes
      newGroups[sourceGroupId] = {
        ...updatedSource,
        panes: remainingPanes,
        activePaneId:
          updatedSource.activePaneId === sourcePaneId
            ? remainingPanes[0].id
            : updatedSource.activePaneId,
      };
    }

    // Now split the target group
    const splitNode: LayoutNode = {
      type: "split",
      id: crypto.randomUUID(),
      direction,
      children: newFirst
        ? [{ type: "group", groupId: newGroup.id }, { type: "group", groupId: targetGroupId }]
        : [{ type: "group", groupId: targetGroupId }, { type: "group", groupId: newGroup.id }],
      ratio: 0.5,
    };
    newRoot = replaceNode(newRoot, targetGroupId, splitNode);

    set((s) => ({
      layouts: {
        ...s.layouts,
        [workspaceId]: { root: newRoot, groups: newGroups },
      },
    }));
  },

  dropFileOnGroup: (workspaceId, targetGroupId, filePaths, position) => {
    if (filePaths.length === 0) return;

    const makePanes = (): Pane[] =>
      filePaths.map((fp) => ({
        id: crypto.randomUUID(),
        type: "editor" as const,
        title: fp.split("/").pop() ?? fp,
        filePath: fp,
      }));

    if (position === "center") {
      // Add files as tabs in the target group
      for (const pane of makePanes()) {
        get().addPaneToGroup(workspaceId, targetGroupId, pane);
      }
      return;
    }

    // Edge drop: create a new group with the file panes, split the target
    const panes = makePanes();
    const newGroup: PaneGroup = {
      id: crypto.randomUUID(),
      panes,
      activePaneId: panes[0].id,
    };

    const layout = get().getOrCreateLayout(workspaceId);
    const direction: "horizontal" | "vertical" =
      position === "left" || position === "right" ? "horizontal" : "vertical";
    const newFirst = position === "top" || position === "left";

    const splitNode: LayoutNode = {
      type: "split",
      id: crypto.randomUUID(),
      direction,
      children: newFirst
        ? [{ type: "group", groupId: newGroup.id }, { type: "group", groupId: targetGroupId }]
        : [{ type: "group", groupId: targetGroupId }, { type: "group", groupId: newGroup.id }],
      ratio: 0.5,
    };
    const newRoot = replaceNode(layout.root, targetGroupId, splitNode);

    set((s) => ({
      layouts: {
        ...s.layouts,
        [workspaceId]: {
          root: newRoot,
          groups: { ...layout.groups, [newGroup.id]: newGroup },
        },
      },
    }));
  },
    }),
    {
      name: WINDOW_PERSIST_KEY,
      partialize: (state) => ({
        activeWorkspaceId: state.activeWorkspaceId,
        activePathIndex: state.activePathIndex,
        layouts: state.layouts,
        activeGroupIds: state.activeGroupIds,
      }),
      merge: (persisted, current) => {
        const p = persisted as Partial<WorkspaceState> | undefined;
        return {
          ...current,
          activeWorkspaceId: p?.activeWorkspaceId ?? current.activeWorkspaceId,
          layouts: restoreLayouts(p?.layouts ?? {}),
          activeGroupIds: p?.activeGroupIds ?? current.activeGroupIds,
        };
      },
    }
  )
);

/** Helper to find a split node by ID in the tree */
function findSplitById(
  node: LayoutNode,
  id: string
): Extract<LayoutNode, { type: "split" }> | null {
  if (node.type === "split") {
    if (node.id === id) return node;
    return (
      findSplitById(node.children[0], id) ??
      findSplitById(node.children[1], id)
    );
  }
  return null;
}
