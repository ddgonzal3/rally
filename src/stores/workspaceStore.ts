import { create } from "zustand";
import { persist } from "zustand/middleware";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { addToast } from "../components/ToastContainer";
import { openUrl } from "../lib/tauri";
import type {
  Workspace,
  GitStatus,
  PrStatus,
  Pane,
  WorkspaceLayout,
  LayoutNode,
  LayoutPreset,
  SplitDirection,
  PaneGroup,
  ScriptRun,
  ShipStatus,
  ShipSession,
  ShipSignal,
  ShipDetailPhase,
  EditorViewMode,
} from "../lib/types";
import {
  createDefaultLayout,
  replaceNode,
  findParent,
  findFirstGroupInSubtree,
} from "../lib/types";
import { api } from "../lib/tauri";
import { getExpandedPaths, setExpandedPaths } from "../components/FileExplorer";

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

const VALID_PANE_TYPES = new Set([
  "claude",
  "terminal",
  "claude-launcher",
  "editor",
  "diff",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

type PersistedWorkspaceState = {
  activeWorkspaceId: string | null;
  activePathIndex: Record<string, number>;
  layouts: Record<string, WorkspaceLayout>;
  activeGroupIds: Record<string, string>;
  layoutPresets: Record<string, LayoutPreset[]>;
  activePresetId: Record<string, string>;
  gitDiffActiveTab: "unstaged" | "staged";
  unifiedGitPanelOpen: boolean;
  unifiedGitPanelPath: string | null;
  unifiedGitPanelTab: "changes" | "pr";
};

const workspacePersistStorage = (() => {
  let lastRefs: {
    activeWorkspaceId: string | null;
    activePathIndex: PersistedWorkspaceState["activePathIndex"];
    layouts: PersistedWorkspaceState["layouts"];
    activeGroupIds: PersistedWorkspaceState["activeGroupIds"];
    layoutPresets: PersistedWorkspaceState["layoutPresets"];
    activePresetId: PersistedWorkspaceState["activePresetId"];
    gitDiffActiveTab: string;
    unifiedGitPanelOpen: boolean;
    unifiedGitPanelPath: string | null;
    unifiedGitPanelTab: string;
    version: number;
  } | null = null;

  return {
    getItem: (name: string) => {
      const raw = localStorage.getItem(name);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        // Self-heal invalid persisted payloads from previous builds.
        localStorage.removeItem(name);
        return null;
      }
    },
    setItem: (
      name: string,
      value: { state: PersistedWorkspaceState; version?: number },
    ) => {
      const { state, version } = value;
      const resolvedVersion = version ?? 0;
      if (
        lastRefs &&
        lastRefs.version === resolvedVersion &&
        lastRefs.activeWorkspaceId === state.activeWorkspaceId &&
        lastRefs.activePathIndex === state.activePathIndex &&
        lastRefs.layouts === state.layouts &&
        lastRefs.activeGroupIds === state.activeGroupIds &&
        lastRefs.layoutPresets === state.layoutPresets &&
        lastRefs.activePresetId === state.activePresetId &&
        lastRefs.gitDiffActiveTab === state.gitDiffActiveTab &&
        lastRefs.unifiedGitPanelOpen === state.unifiedGitPanelOpen &&
        lastRefs.unifiedGitPanelPath === state.unifiedGitPanelPath &&
        lastRefs.unifiedGitPanelTab === state.unifiedGitPanelTab
      ) {
        return;
      }

      localStorage.setItem(name, JSON.stringify(value));
      lastRefs = {
        activeWorkspaceId: state.activeWorkspaceId,
        activePathIndex: state.activePathIndex,
        layouts: state.layouts,
        activeGroupIds: state.activeGroupIds,
        layoutPresets: state.layoutPresets,
        activePresetId: state.activePresetId,
        gitDiffActiveTab: state.gitDiffActiveTab,
        unifiedGitPanelOpen: state.unifiedGitPanelOpen,
        unifiedGitPanelPath: state.unifiedGitPanelPath,
        unifiedGitPanelTab: state.unifiedGitPanelTab,
        version: resolvedVersion,
      };
    },
    removeItem: (name: string) => {
      localStorage.removeItem(name);
      lastRefs = null;
    },
  };
})();


interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  /** Git status keyed by repo path */
  gitStatuses: Record<string, GitStatus>;
  /** PR status keyed by repo path */
  prStatuses: Record<string, PrStatus | null>;
  /** Which repo path is active per workspace (index into ws.paths) */
  activePathIndex: Record<string, number>;
  layouts: Record<string, WorkspaceLayout>;
  /** Tracks the last-focused group per workspace for Cmd+W etc. */
  activeGroupIds: Record<string, string>;
  /** Saved layout presets per workspace */
  layoutPresets: Record<string, LayoutPreset[]>;
  /** Currently active preset per workspace (set on restore, cleared on delete) */
  activePresetId: Record<string, string>;
  /** Active script runs keyed by "rootPath:scriptName" */
  scriptRuns: Record<string, ScriptRun>;
  /** Ship status keyed by repo path */
  shipStatuses: Record<string, ShipStatus>;
  /** Active ship session (detached PTY running /ship) */
  shipSession: ShipSession | null;
  /** File path to reveal in explorer (set on explicit reveal, auto-clears) */
  revealedFilePath: string | null;
  /** Git diff state (shared by GitDiffContent) */
  gitDiffActiveTab: "unstaged" | "staged";
  gitDiffScrollToFile: string | null;
  /** PR review scroll state (shared by PrReviewContent) */
  prReviewScrollToFile: string | null;
  /** Unified git panel state */
  unifiedGitPanelOpen: boolean;
  unifiedGitPanelPath: string | null;
  unifiedGitPanelTab: "changes" | "pr";
  openUnifiedGitPanel: (rootPath: string, tab?: "changes" | "pr") => void;
  closeUnifiedGitPanel: () => void;
  setUnifiedGitPanelTab: (tab: "changes" | "pr") => void;
  loading: boolean;
  /** Set of pane IDs with unsaved editor changes */
  dirtyPanes: Set<string>;

  // Dirty pane tracking
  markPaneDirty: (paneId: string) => void;
  markPaneClean: (paneId: string) => void;

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
  reorderWorkspace: (id: string, toIndex: number) => Promise<void>;
  renameWorkspace: (id: string, name: string) => Promise<void>;
  addPathToWorkspace: (id: string, path: string) => Promise<void>;
  removePathFromWorkspace: (id: string, path: string) => Promise<void>;
  reorderWorkspacePath: (
    workspaceId: string,
    path: string,
    toIndex: number,
  ) => Promise<void>;

  // Git actions (all keyed by repo path)
  refreshGitStatusForPath: (path: string, mainBranch: string) => Promise<void>;
  refreshAllGitStatuses: () => Promise<void>;
  refreshPrStatusForPath: (path: string) => Promise<void>;
  refreshAllPrStatuses: () => Promise<void>;
  /** Fetch all repos in parallel (silent failures per-path) */
  fetchAllRepos: () => Promise<void>;
  /** Rebase a repo path onto origin/<mainBranch>, then refresh git status */
  rebaseOnMain: (path: string, mainBranch: string) => Promise<void>;
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
  setEditorViewMode: (
    workspaceId: string,
    groupId: string,
    paneId: string,
    mode: EditorViewMode,
  ) => void;
  /** Close the active pane in the last-focused group */
  closeActiveTab: (workspaceId: string) => void;
  /** Save current layout as a named preset */
  saveLayoutPreset: (workspaceId: string, name: string) => void;
  /** Overwrite an existing preset with the current layout + repos */
  updateLayoutPreset: (workspaceId: string, presetId: string) => void;
  /** Restore a saved layout preset (kills existing PTYs) */
  restoreLayoutPreset: (workspaceId: string, presetId: string) => void;
  /** Delete a saved layout preset */
  deleteLayoutPreset: (workspaceId: string, presetId: string) => void;
  /** Open a file in an editor pane in the top area of the layout */
  openFile: (workspaceId: string, filePath: string, options?: { line?: number; col?: number }) => void;
  /** Reveal a file in the explorer (expand ancestors + highlight) */
  revealFileInExplorer: (filePath: string) => void;
  /** Set the active tab in the git diff panel */
  setGitDiffActiveTab: (tab: "unstaged" | "staged") => void;
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

  /** Open a plain terminal pane in the bottom half of the layout. */
  openTerminalInBottom: (workspaceId: string, cwd: string) => void;

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

function sanitizePane(raw: unknown): Pane | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" && raw.id ? raw.id : crypto.randomUUID();
  const rawType = typeof raw.type === "string" ? raw.type : "terminal";
  if (!VALID_PANE_TYPES.has(rawType)) return null;
  const type = rawType as Pane["type"];
  const title =
    typeof raw.title === "string" && raw.title
      ? raw.title
      : type === "editor" || type === "diff"
        ? "File"
        : type === "claude" || type === "claude-launcher"
          ? "Claude Code"
          : "Terminal";

  const pane: Pane = {
    id,
    type,
    title,
  };
  if (typeof raw.command === "string") pane.command = raw.command;
  if (typeof raw.filePath === "string") pane.filePath = raw.filePath;
  if (typeof raw.cwd === "string") pane.cwd = raw.cwd;
  if (typeof raw.initialInput === "string") pane.initialInput = raw.initialInput;
  if (typeof raw.ptyId === "string") pane.ptyId = raw.ptyId;
  if (typeof raw.scriptBufferKey === "string") pane.scriptBufferKey = raw.scriptBufferKey;
  return pane;
}

function sanitizeGroup(raw: unknown): PaneGroup | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" && raw.id ? raw.id : crypto.randomUUID();
  const rawPanes = Array.isArray(raw.panes) ? raw.panes : [];
  const panes = rawPanes
    .map((p) => sanitizePane(p))
    .filter((p): p is Pane => p !== null);

  const rawActivePaneId =
    typeof raw.activePaneId === "string" ? raw.activePaneId : "";
  const activePaneId =
    panes.length > 0
      ? panes.some((p) => p.id === rawActivePaneId)
        ? rawActivePaneId
        : panes[0].id
      : "";

  const paneHistory =
    Array.isArray(raw.paneHistory)
      ? raw.paneHistory.filter(
          (id): id is string =>
            typeof id === "string" && panes.some((p) => p.id === id),
        )
      : undefined;

  return {
    id,
    panes,
    activePaneId,
    ...(paneHistory && paneHistory.length > 0 ? { paneHistory } : {}),
  };
}

function sanitizeLayoutNode(
  raw: unknown,
  groups: Record<string, PaneGroup>,
  depth = 0,
): LayoutNode | null {
  if (depth > 64 || !isRecord(raw) || typeof raw.type !== "string") return null;
  if (raw.type === "group") {
    if (typeof raw.groupId !== "string" || !groups[raw.groupId]) return null;
    return { type: "group", groupId: raw.groupId };
  }
  if (raw.type !== "split") return null;

  const children = Array.isArray(raw.children) ? raw.children : [];
  if (children.length !== 2) return null;
  const first = sanitizeLayoutNode(children[0], groups, depth + 1);
  const second = sanitizeLayoutNode(children[1], groups, depth + 1);
  if (!first || !second) return null;

  const direction =
    raw.direction === "vertical" ? "vertical" : "horizontal";
  const ratioRaw =
    typeof raw.ratio === "number" && Number.isFinite(raw.ratio)
      ? raw.ratio
      : 0.5;
  const ratio = Math.min(0.9, Math.max(0.1, ratioRaw));
  const id = typeof raw.id === "string" && raw.id ? raw.id : crypto.randomUUID();

  return {
    type: "split",
    id,
    direction,
    children: [first, second],
    ratio,
  };
}

function isClaudeCodeTitle(title: string): boolean {
  const lower = title.trim().toLowerCase();
  return lower === "claude" || lower.startsWith("claude ");
}

function shouldRestoreAsClaudeLauncher(pane: Pane): boolean {
  if (pane.type === "claude") return true;
  if (pane.type !== "terminal") return false;
  if (pane.scriptBufferKey) return false;
  if (isClaudeCodeTitle(pane.title)) return true;
  const command = (pane.command ?? "").trim().toLowerCase();
  if (!command) return false;
  return command === "claude" || command.startsWith("claude ") || command.includes("/claude ");
}

/** On restore, convert active claude sessions back to launchers (fresh start). */
function restoreLayouts(layouts: Record<string, WorkspaceLayout>): Record<string, WorkspaceLayout> {
  const restored: Record<string, WorkspaceLayout> = {};
  if (!isRecord(layouts)) return restored;

  for (const [wsId, rawLayout] of Object.entries(layouts)) {
    if (!isRecord(rawLayout)) {
      restored[wsId] = createDefaultLayout();
      continue;
    }

    const rawGroups = isRecord(rawLayout.groups) ? rawLayout.groups : {};
    const groups: Record<string, PaneGroup> = {};
    for (const [gId, group] of Object.entries(rawGroups)) {
      const sanitizedGroup = sanitizeGroup(group);
      if (!sanitizedGroup) continue;
      groups[gId] = {
        ...sanitizedGroup,
        id: gId,
        panes: sanitizedGroup.panes.map((p) => {
          // Strip stale ptyIds — PTYs don't survive app restart.
          // CWD is preserved — OSC 7 tracking keeps it up to date with
          // the shell's actual directory, so it's correct on restore.
          const { ptyId: _, ...rest } = p;
          if (!shouldRestoreAsClaudeLauncher(p)) return rest;
          return {
            id: rest.id,
            type: "claude-launcher" as const,
            title: rest.type === "claude" ? rest.title : "Claude Code",
            ...(rest.cwd ? { cwd: rest.cwd } : {}),
          };
        }),
      };
    }

    if (Object.keys(groups).length === 0) {
      restored[wsId] = createDefaultLayout();
      continue;
    }

    const root = sanitizeLayoutNode(rawLayout.root, groups);
    if (!root) {
      restored[wsId] = createDefaultLayout();
      continue;
    }

    // Clean up collapsed bottom panels: if root is a vertical split whose
    // bottom group has no panes, replace the split with just the top child.
    let cleanRoot = root;
    if (
      cleanRoot.type === "split" &&
      cleanRoot.direction === "vertical" &&
      cleanRoot.children[1].type === "group"
    ) {
      const bottomGroup = groups[cleanRoot.children[1].groupId];
      if (!bottomGroup || bottomGroup.panes.length === 0) {
        delete groups[cleanRoot.children[1].groupId];
        cleanRoot = cleanRoot.children[0];
      }
    }

    restored[wsId] = { root: cleanRoot, groups };
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
  activePathIndex: {},
  layouts: {},
  activeGroupIds: {},
  layoutPresets: {},
  activePresetId: {},
  scriptRuns: {},
  shipStatuses: {},
  shipSession: null,
  revealedFilePath: null,
  gitDiffActiveTab: "unstaged" as const,
  gitDiffScrollToFile: null,
  prReviewScrollToFile: null,
  unifiedGitPanelOpen: false,
  unifiedGitPanelPath: null,
  unifiedGitPanelTab: "changes" as const,
  loading: false,
  dirtyPanes: new Set(),

  markPaneDirty: (paneId) => {
    const s = get();
    if (s.dirtyPanes.has(paneId)) return;
    const next = new Set(s.dirtyPanes);
    next.add(paneId);
    set({ dirtyPanes: next });
  },

  markPaneClean: (paneId) => {
    const s = get();
    if (!s.dirtyPanes.has(paneId)) return;
    const next = new Set(s.dirtyPanes);
    next.delete(paneId);
    set({ dirtyPanes: next });
  },

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
    // Immediately fetch git status for the new workspace's paths
    // so the branch name appears right away instead of waiting for the next poll
    const ws = get().workspaces.find((w) => w.name === params.name);
    if (ws) {
      await Promise.all(
        ws.paths.map((p) => get().refreshGitStatusForPath(p, ws.main_branch)),
      );
    }
  },

  addPathToWorkspace: async (id, path) => {
    await api.addWorkspacePath(id, path);
    await get().loadWorkspaces();
    // Immediately fetch git status for the newly added path
    const ws = get().workspaces.find((w) => w.id === id);
    if (ws) {
      await get().refreshGitStatusForPath(path, ws.main_branch);
    }
  },

  removePathFromWorkspace: async (id, path) => {
    await api.removeWorkspacePath(id, path);
    await get().loadWorkspaces();
  },

  reorderWorkspacePath: async (workspaceId, path, toIndex) => {
    const state = get();
    const ws = state.workspaces.find((w) => w.id === workspaceId);
    if (!ws || ws.paths.length <= 1) return;

    const fromIndex = ws.paths.indexOf(path);
    if (fromIndex < 0) return;
    const target = Math.max(0, Math.min(toIndex, ws.paths.length - 1));
    if (fromIndex === target) return;

    const nextPaths = [...ws.paths];
    const [moved] = nextPaths.splice(fromIndex, 1);
    nextPaths.splice(target, 0, moved);

    const currentActiveIndex = state.activePathIndex[workspaceId] ?? 0;
    let nextActiveIndex = currentActiveIndex;
    if (currentActiveIndex === fromIndex) {
      nextActiveIndex = target;
    } else if (
      fromIndex < target &&
      currentActiveIndex > fromIndex &&
      currentActiveIndex <= target
    ) {
      nextActiveIndex = currentActiveIndex - 1;
    } else if (
      fromIndex > target &&
      currentActiveIndex >= target &&
      currentActiveIndex < fromIndex
    ) {
      nextActiveIndex = currentActiveIndex + 1;
    }

    const prevWorkspaces = state.workspaces;
    const prevActivePathIndex = state.activePathIndex;

    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId ? { ...w, paths: nextPaths } : w,
      ),
      activePathIndex: {
        ...s.activePathIndex,
        [workspaceId]: nextActiveIndex,
      },
    }));

    try {
      await api.reorderWorkspacePath(workspaceId, path, target);
    } catch (e) {
      console.error("Failed to reorder workspace paths:", e);
      set({
        workspaces: prevWorkspaces,
        activePathIndex: prevActivePathIndex,
      });
      throw e;
    }
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

  reorderWorkspace: async (id, toIndex) => {
    const current = get().workspaces;
    const fromIndex = current.findIndex((w) => w.id === id);
    if (fromIndex < 0 || current.length <= 1) return;
    const target = Math.max(0, Math.min(toIndex, current.length - 1));
    if (fromIndex === target) return;

    const next = [...current];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(target, 0, moved);
    set({ workspaces: next });

    try {
      await api.reorderWorkspace(id, target);
    } catch (e) {
      console.error("Failed to reorder workspaces:", e);
      set({ workspaces: current });
      throw e;
    }
  },

  renameWorkspace: async (id, name) => {
    await api.renameWorkspace(id, name);
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id ? { ...w, name } : w
      ),
    }));
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
    const targets: { path: string; mainBranch: string }[] = [];
    for (const ws of workspaces) {
      for (const path of ws.paths) {
        targets.push({ path, mainBranch: ws.main_branch });
      }
    }
    if (targets.length === 0) return;

    const results = await Promise.all(
      targets.map(async ({ path, mainBranch }) => {
        try {
          const status = await api.gitStatus(path, mainBranch);
          return { path, status };
        } catch (e) {
          console.error(`Failed to get git status for ${path}:`, e);
          return null;
        }
      }),
    );

    set((s) => {
      let changed = false;
      const next = { ...s.gitStatuses };
      for (const result of results) {
        if (!result) continue;
        const prev = s.gitStatuses[result.path];
        if (!prev || !gitStatusEqual(prev, result.status)) {
          next[result.path] = result.status;
          changed = true;
        }
      }
      return changed ? { gitStatuses: next } : s;
    });
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
    const targets: string[] = [];
    for (const ws of workspaces) {
      for (const path of ws.paths) {
        targets.push(path);
      }
    }
    if (targets.length === 0) return;

    const results = await Promise.all(
      targets.map(async (path) => {
        try {
          const prStatus = await api.gitPrStatus(path);
          return { path, prStatus, error: false as const };
        } catch {
          return { path, prStatus: null, error: true as const };
        }
      }),
    );

    set((s) => {
      let changed = false;
      const next = { ...s.prStatuses };
      for (const result of results) {
        if (result.error) {
          if (s.prStatuses[result.path] === null) continue;
          next[result.path] = null;
          changed = true;
          continue;
        }
        const prev = s.prStatuses[result.path];
        if (prStatusEqual(prev ?? null, result.prStatus)) continue;
        next[result.path] = result.prStatus;
        changed = true;
      }
      return changed ? { prStatuses: next } : s;
    });
  },

  fetchAllRepos: async () => {
    const workspaces = get().workspaces;
    const paths = workspaces.flatMap((ws) => ws.paths);
    await Promise.allSettled(paths.map((p) => api.gitFetch(p)));
    // Refresh git statuses after fetch so behind counts update
    await get().refreshAllGitStatuses();
  },

  rebaseOnMain: async (path, mainBranch) => {
    try {
      await api.gitRebaseOnMain(path, mainBranch);
      await get().refreshGitStatusForPath(path, mainBranch);
    } catch (e) {
      // Refresh status even on failure (abort restores clean state)
      get().refreshGitStatusForPath(path, mainBranch).catch(() => {});
      const msg = String(e);
      if (msg.includes("uncommitted changes") || msg.includes("dirty")) {
        throw new Error("Commit or stash changes first");
      }
      if (msg.includes("CONFLICT") || msg.includes("conflict")) {
        throw new Error("Rebase had conflicts — aborted automatically. Resolve conflicts manually or merge via PR.");
      }
      throw e;
    }
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
          // Also clear headless ship sessions for this repo if signal disappears
          const session = get().shipSession;
          if (session && !session.ptyId && session.repoPath === repoPath && !session.signal) {
            set({ shipSession: null });
          }
          continue;
        }

        // If there's an active ship session for this repo, validate + update it
        const session = get().shipSession;
        if (session && session.repoPath === repoPath) {
          // Auto-dismiss headless sessions if the PR is no longer open
          if (!session.ptyId && signal.verdict === "shipping" && signal.pr_number > 0) {
            const livePr = get().prStatuses[repoPath];
            if (livePr && livePr.state !== "OPEN") {
              await api.clearShipSignal(repoPath).catch(() => {});
              set({ shipSession: null });
              continue;
            }
          }
          if (signal.verdict === "shipping") {
            // In-progress signal — update phase and attach signal when it has PR info.
            // ship.md writes phases to the signal file instead of echoing
            // <<RALLY_PHASE>> markers, so this is the primary phase source.
            const newPhase = (signal as ShipSignal).phase;
            const phaseChanged = newPhase && newPhase !== session.phase;
            const signalHasNewPrInfo = signal.pr_number > 0 && !session.signal?.pr_number;
            if (phaseChanged || signalHasNewPrInfo) {
              set((s) => ({
                shipSession: s.shipSession ? {
                  ...s.shipSession,
                  phase: newPhase ?? s.shipSession.phase,
                  // Attach signal when it has PR info so the pill can show PR # and link
                  signal: signal.pr_number > 0 ? signal : s.shipSession.signal,
                } : null,
              }));
            }
          } else if (!session.signal) {
            // Final signal — attach to any session type (only once)
            set((s) => ({
              shipSession: s.shipSession ? {
                ...s.shipSession,
                signal,
                phase: signal.verdict === "manual_review" ? "complete" : s.shipSession.phase,
              } : null,
            }));
          }
        }

        // Handle "shipping" verdict — in-progress signal from external /ship
        if (signal.verdict === "shipping") {
          // Staleness check: if timestamp > 30 min old, clear it
          const signalAge = Date.now() - new Date(signal.timestamp).getTime();
          if (signalAge > 30 * 60 * 1000) {
            await api.clearShipSignal(repoPath).catch(() => {});
            if (get().shipSession?.repoPath === repoPath && !get().shipSession?.ptyId) {
              set({ shipSession: null });
            }
            continue;
          }

          // PR state validation: if signal references a PR that's no longer open,
          // the shipping process is dead — clear the stale signal
          if (signal.pr_number > 0) {
            const livePr = get().prStatuses[repoPath];
            if (livePr && livePr.state !== "OPEN") {
              await api.clearShipSignal(repoPath).catch(() => {});
              if (get().shipSession?.repoPath === repoPath && !get().shipSession?.ptyId) {
                set({ shipSession: null });
              }
              continue;
            }
          }

          // If no existing shipSession, create a headless one
          if (!get().shipSession) {
            set({
              shipSession: {
                repoPath,
                phase: (signal as ShipSignal).phase ?? "detecting",
                exited: false,
                exitCode: null,
                docked: false,
              },
            });
          }
          continue;
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
              ? [{ label: "View PR", onClick: () => openUrl(signal.pr_url) }]
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
              actions.push({ label: "View PR", onClick: () => openUrl(signal.pr_url) });
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

      // Clear signal file
      await api.clearShipSignal(repoPath);

      // Refresh git status (must complete before fetchAllRepos to avoid git lock races)
      await get().refreshGitStatusForPath(repoPath, mainBranch);
      await get().refreshPrStatusForPath(repoPath);

      // Fetch all repos so other checkouts see the behind count
      get().fetchAllRepos().catch(() => {});

      // Notify that merge + sync completed
      addToast({
        type: "success",
        title: `PR #${signal.pr_number} Merged`,
        message: `Branch synced with ${mainBranch} and ready to work on`,
        actions: signal.pr_url
          ? [{ label: "View PR", onClick: () => openUrl(signal.pr_url) }]
          : undefined,
      });

      // Done — clear ship status and dismiss ship session for this repo
      const session = get().shipSession;
      if (session && session.repoPath === repoPath) {
        if (session.ptyId && !session.exited) {
          api.killPty(session.ptyId).catch(() => {});
        }
        shipOutputBuffer.length = 0;
      }
      set((s) => ({
        shipStatuses: { ...s.shipStatuses, [repoPath]: { phase: "idle" } },
        shipSession: s.shipSession?.repoPath === repoPath ? null : s.shipSession,
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
    if (!session || !session.ptyId) return;

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
    if (session.ptyId) {
      // PTY-backed: we own the process — kill it and clear the signal
      if (!session.exited) {
        api.killPty(session.ptyId).catch(() => {});
      }
    }
    // Always clear the signal file on dismiss. For headless sessions where
    // an external /ship is still running, it will write a new signal on
    // its next phase change (within seconds). For early-exit cases (guard
    // rails, errors), clearing prevents the poll loop from recreating the
    // session indefinitely.
    api.clearShipSignal(session.repoPath).catch(() => {});
    shipOutputBuffer.length = 0;
    set({ shipSession: null });
  },

  openTerminalInBottom: (workspaceId, cwd) => {
    const layout = get().getOrCreateLayout(workspaceId);
    const root = layout.root;

    const folderName = cwd.split("/").pop() ?? "Terminal";
    const pane: Pane = {
      id: crypto.randomUUID(),
      type: "terminal",
      title: folderName,
      cwd,
    };

    // If root is a vertical split, add to the bottom half
    if (root.type === "split" && root.direction === "vertical") {
      const targetGroupId = findFirstGroupInSubtree(root.children[1]);
      if (targetGroupId) {
        get().addPaneToGroup(workspaceId, targetGroupId, pane);
        return;
      }
    }

    // No vertical split at root — wrap the current root in one
    const newGroup: PaneGroup = {
      id: crypto.randomUUID(),
      panes: [pane],
      activePaneId: pane.id,
    };
    const newRoot: LayoutNode = {
      type: "split",
      id: crypto.randomUUID(),
      direction: "vertical",
      children: [root, { type: "group", groupId: newGroup.id }],
      ratio: 0.5,
    };
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

  openClaudeCommand: (workspaceId, cwd, slashCommand, title) => {
    // Close git diff overlay if open — opening a command should take precedence
    if (get().unifiedGitPanelOpen) {
      set({ unifiedGitPanelOpen: false, unifiedGitPanelPath: null, gitDiffScrollToFile: null, prReviewScrollToFile: null });
    }

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

    // Don't use exitOnComplete — the shell must stay alive so the user
    // can Ctrl+C a watcher and continue typing in the terminal.
    const ptyId = await api.spawnPty(rootPath, command, 120, 40, false);

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
        if (buf) {
          buf.push(new Uint8Array(event.payload.data));
          // Notify TaskPanel that watcher output changed (event-driven, not polling)
          document.dispatchEvent(new CustomEvent("rally:watcher-output", { detail: { key } }));
        }
      }
    );

    // Poll for command completion — the shell stays alive after the
    // command exits, so we detect completion by checking whether the
    // shell still has a foreground child process. Delay the start to
    // avoid false positives while the shell is still loading .zshrc.
    let pollStarted = false;
    const pollInterval = setInterval(async () => {
      if (!pollStarted) {
        // Wait for the command to actually start (first poll finds a child)
        try {
          const fg = await api.getPtyForegroundProcess(ptyId);
          if (fg !== null) pollStarted = true;
        } catch { /* ignore */ }
        return;
      }
      try {
        const fg = await api.getPtyForegroundProcess(ptyId);
        if (fg === null) {
          // No foreground child → command finished, shell is at prompt
          clearInterval(pollInterval);
          const current = get().scriptRuns[key];
          if (current && current.status === "running") {
            set((s) => ({
              scriptRuns: {
                ...s.scriptRuns,
                [key]: {
                  ...s.scriptRuns[key],
                  status: "success",
                  exitCode: 0,
                },
              },
            }));
          }
        }
      } catch {
        // PTY gone — stop polling
        clearInterval(pollInterval);
      }
    }, 1000);

    // Listen for PTY exit (shell itself exits — e.g. user types `exit`)
    const unlistenExit = await listen<{ code: number | null }>(
      `pty-exit-${ptyId}`,
      (event) => {
        clearInterval(pollInterval);
        const code = event.payload.code;
        const current = get().scriptRuns[key];
        // Only update if still running (poll may have already marked it)
        if (current && current.status === "running") {
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
        }
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

    // Toggle: if a pane already exists for this script and is active, close it
    const group = layout.groups[targetGroupId];
    if (group) {
      const existing = group.panes.find((p) => p.ptyId === run.ptyId);
      if (existing) {
        if (group.activePaneId === existing.id) {
          get().closePane(workspaceId, targetGroupId, existing.id);
        } else {
          get().setActivePane(workspaceId, targetGroupId, existing.id);
        }
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

    // Kill PTY if the pane has one — but NOT for script terminals,
    // which should keep running in the background when the pane is closed.
    const closingPane = group.panes.find((p) => p.id === paneId);
    if (closingPane?.ptyId && !closingPane.scriptBufferKey) {
      api.killPty(closingPane.ptyId).catch(() => {});
    }

    // Clean up dirty state
    get().markPaneClean(paneId);

    if (group.panes.length <= 1) {
      // Last pane in group — check if this group IS the entire row.
      // A "row" is a direct child of the root vertical split (or the root itself).
      // If the group is inside a row (has siblings), collapse it so the sibling expands.
      // If the group IS the row, keep it alive with an empty state (TerminalLauncher).
      const parentInfo = findParent(layout.root, groupId);
      const isDirectChildOfRootVSplit =
        parentInfo &&
        layout.root.type === "split" &&
        layout.root.direction === "vertical" &&
        parentInfo.parent.id === layout.root.id;
      // Bottom row of root vertical split should collapse, not show landing page
      const isBottomRow = isDirectChildOfRootVSplit && parentInfo.index === 1;
      const isRow =
        (!parentInfo || isDirectChildOfRootVSplit) && !isBottomRow;

      if (isRow) {
        // This group is a row — show empty state
        set((s) => ({
          layouts: {
            ...s.layouts,
            [workspaceId]: {
              ...layout,
              groups: {
                ...layout.groups,
                [groupId]: {
                  ...group,
                  panes: [],
                  activePaneId: "",
                  paneHistory: [],
                },
              },
            },
          },
        }));
      } else if (isBottomRow) {
        // Bottom row — snap shut instantly (no slide animation).
        // Keep the split in the tree so the top panel doesn't remount (avoids flicker).
        const rootSplit = layout.root as Extract<LayoutNode, { type: "split" }>;
        const collapsedRoot = replaceNode(layout.root, rootSplit.id, {
          ...rootSplit,
          ratio: 1,
        });
        const topGroupId = findFirstGroupInSubtree(rootSplit.children[0]);
        // Disable flex transition so it snaps, then re-enable after paint
        document.documentElement.style.setProperty("--split-transition", "none");
        set((s) => ({
          activeGroupIds: {
            ...s.activeGroupIds,
            [workspaceId]: topGroupId ?? s.activeGroupIds[workspaceId],
          },
          layouts: {
            ...s.layouts,
            [workspaceId]: {
              root: collapsedRoot,
              groups: {
                ...layout.groups,
                [groupId]: { ...group, panes: [], activePaneId: "", paneHistory: [] },
              },
            },
          },
        }));
        requestAnimationFrame(() => {
          document.documentElement.style.removeProperty("--split-transition");
        });
        if (topGroupId) {
          setTimeout(() => {
            window.dispatchEvent(
              new CustomEvent("rally-focus-group", { detail: topGroupId }),
            );
          }, 0);
        }
      } else {
        // Group has siblings in the same row — collapse it.
        // Find the sibling group that will survive so we can focus it.
        const siblingIndex = parentInfo.index === 0 ? 1 : 0;
        const siblingNode = parentInfo.parent.children[siblingIndex];
        const targetGroupId = findFirstGroupInSubtree(siblingNode);
        get().closeGroup(workspaceId, groupId);
        // Signal the surviving group to focus its terminal after DOM updates
        if (targetGroupId) {
          setTimeout(() => {
            window.dispatchEvent(
              new CustomEvent("rally-focus-group", { detail: targetGroupId }),
            );
          }, 0);
        }
      }
      return;
    }

    // Remove the pane from the group
    const newPanes = group.panes.filter((p) => p.id !== paneId);
    // Remove closed pane from MRU history
    const newHistory = (group.paneHistory ?? []).filter((id) => id !== paneId);
    const remainingIds = new Set(newPanes.map((p) => p.id));

    let newActive = group.activePaneId;
    if (group.activePaneId === paneId) {
      // Focus the tab to the left of the closed one; if none, focus the one to the right
      const closedIndex = group.panes.findIndex((p) => p.id === paneId);
      const leftNeighbor = closedIndex > 0 ? group.panes[closedIndex - 1] : null;
      const rightNeighbor = closedIndex < group.panes.length - 1 ? group.panes[closedIndex + 1] : null;
      newActive = (leftNeighbor ?? rightNeighbor)?.id ?? newPanes[0]?.id ?? "";
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

    // Kill all PTYs in this group — except script terminals which keep running
    const group = layout.groups[groupId];
    if (group) {
      for (const pane of group.panes) {
        if (pane.ptyId && !pane.scriptBufferKey) api.killPty(pane.ptyId).catch(() => {});
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

  setEditorViewMode: (workspaceId, groupId, paneId, mode) => {
    get().transformPane(workspaceId, groupId, paneId, { editorViewMode: mode });
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

  saveLayoutPreset: (workspaceId, name) => {
    const layout = get().getOrCreateLayout(workspaceId);
    // Deep-clone and sanitize: strip ptyIds, convert claude → launcher
    const groups: Record<string, PaneGroup> = {};
    for (const [gId, group] of Object.entries(layout.groups)) {
      groups[gId] = {
        ...group,
        panes: group.panes.map((p) => {
          const { ptyId: _, scriptBufferKey: _2, ...rest } = p;
          if (rest.type === "claude") {
            return { id: rest.id, type: "claude-launcher" as const, title: rest.title, ...(rest.cwd ? { cwd: rest.cwd } : {}) };
          }
          return rest;
        }),
      };
    }
    const snapshot: WorkspaceLayout = {
      root: JSON.parse(JSON.stringify(layout.root)),
      groups,
    };
    // Capture explorer state: active repo index + expanded paths under this workspace's roots
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    const allExpanded = getExpandedPaths();
    const wsPaths = ws?.paths ?? [];
    const relevantExpanded = allExpanded.filter((ep) =>
      wsPaths.some((root) => ep === root || ep.startsWith(root + "/"))
    );

    const preset: LayoutPreset = {
      id: crypto.randomUUID(),
      name,
      layout: snapshot,
      explorerState: {
        activePathIndex: get().activePathIndex[workspaceId] ?? 0,
        expandedPaths: relevantExpanded,
        paths: [...wsPaths],
      },
    };
    set((s) => ({
      layoutPresets: {
        ...s.layoutPresets,
        [workspaceId]: [...(s.layoutPresets[workspaceId] ?? []), preset],
      },
      activePresetId: { ...s.activePresetId, [workspaceId]: preset.id },
    }));
  },

  updateLayoutPreset: (workspaceId, presetId) => {
    const presets = get().layoutPresets[workspaceId] ?? [];
    const existing = presets.find((p) => p.id === presetId);
    if (!existing) return;

    // Snapshot current layout (same logic as saveLayoutPreset)
    const layout = get().getOrCreateLayout(workspaceId);
    const groups: Record<string, PaneGroup> = {};
    for (const [gId, group] of Object.entries(layout.groups)) {
      groups[gId] = {
        ...group,
        panes: group.panes.map((p) => {
          const { ptyId: _, scriptBufferKey: _2, ...rest } = p;
          if (rest.type === "claude") {
            return { id: rest.id, type: "claude-launcher" as const, title: rest.title, ...(rest.cwd ? { cwd: rest.cwd } : {}) };
          }
          return rest;
        }),
      };
    }
    const snapshot: WorkspaceLayout = {
      root: JSON.parse(JSON.stringify(layout.root)),
      groups,
    };
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    const allExpanded = getExpandedPaths();
    const wsPaths = ws?.paths ?? [];
    const relevantExpanded = allExpanded.filter((ep) =>
      wsPaths.some((root) => ep === root || ep.startsWith(root + "/"))
    );

    const updated: LayoutPreset = {
      ...existing,
      layout: snapshot,
      explorerState: {
        activePathIndex: get().activePathIndex[workspaceId] ?? 0,
        expandedPaths: relevantExpanded,
        paths: [...wsPaths],
      },
    };
    set((s) => ({
      layoutPresets: {
        ...s.layoutPresets,
        [workspaceId]: (s.layoutPresets[workspaceId] ?? []).map((p) =>
          p.id === presetId ? updated : p
        ),
      },
    }));
  },

  restoreLayoutPreset: (workspaceId, presetId) => {
    const presets = get().layoutPresets[workspaceId] ?? [];
    const preset = presets.find((p) => p.id === presetId);
    if (!preset) return;

    // Collect orphaned PTY IDs from the CURRENT layout before replacing it.
    const oldPtyIds: string[] = [];
    const currentLayout = get().layouts[workspaceId];
    if (currentLayout) {
      for (const group of Object.values(currentLayout.groups)) {
        for (const pane of group.panes) {
          if (pane.ptyId) oldPtyIds.push(pane.ptyId);
        }
      }
    }

    // Deep-clone the preset layout and generate FRESH IDs for everything.
    // Pane/group IDs are used as React keys — if they match the current
    // layout (likely, since the preset was saved from it), React reconciles
    // instead of unmounting/remounting. The terminal components keep their
    // old PTY refs, and killing orphaned PTYs causes "Process exited" on
    // the still-alive components. Fresh IDs force a full unmount → remount.
    const cloned: WorkspaceLayout = JSON.parse(JSON.stringify(preset.layout));

    const groupIdMap = new Map<string, string>();
    const newGroups: Record<string, PaneGroup> = {};
    for (const [oldGid, group] of Object.entries(cloned.groups)) {
      const newGid = crypto.randomUUID();
      groupIdMap.set(oldGid, newGid);
      const newPanes = group.panes.map((p) => ({ ...p, id: crypto.randomUUID() }));
      newGroups[newGid] = {
        ...group,
        id: newGid,
        panes: newPanes,
        activePaneId: newPanes[0]?.id ?? "",
      };
    }

    function remapTree(node: LayoutNode): LayoutNode {
      if (node.type === "group") {
        return { type: "group", groupId: groupIdMap.get(node.groupId) ?? node.groupId };
      }
      return {
        ...node,
        id: crypto.randomUUID(),
        children: [remapTree(node.children[0]), remapTree(node.children[1])],
      };
    }

    const restored: WorkspaceLayout = { root: remapTree(cloned.root), groups: newGroups };
    const firstGroup = findFirstGroupInSubtree(restored.root);

    // Restore explorer state if present in the preset
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    const explorerUpdate: Record<string, unknown> = {};
    if (preset.explorerState) {
      explorerUpdate.activePathIndex = {
        ...get().activePathIndex,
        [workspaceId]: preset.explorerState.activePathIndex,
      };
      setExpandedPaths(preset.explorerState.expandedPaths, ws?.paths);

      // Restore workspace paths (repos) if saved in the preset
      if (preset.explorerState.paths && preset.explorerState.paths.length > 0) {
        const currentPaths = ws?.paths ?? [];
        const savedPaths = preset.explorerState.paths;
        const pathsChanged =
          currentPaths.length !== savedPaths.length ||
          currentPaths.some((p, i) => p !== savedPaths[i]);
        if (pathsChanged) {
          api.setWorkspacePaths(workspaceId, savedPaths).then(() => {
            get().loadWorkspaces();
          }).catch(() => {});
        }
      }
    }

    set((s) => ({
      layouts: { ...s.layouts, [workspaceId]: restored },
      activeGroupIds: {
        ...s.activeGroupIds,
        [workspaceId]: firstGroup ?? s.activeGroupIds[workspaceId],
      },
      activePresetId: { ...s.activePresetId, [workspaceId]: presetId },
      ...explorerUpdate,
    }));

    // Fresh IDs mean React unmounts old terminals (removing pty-exit
    // listeners) before mounting new ones. Kill orphaned PTYs after
    // React has flushed the unmount — rAF fires after the paint.
    requestAnimationFrame(() => {
      for (const id of oldPtyIds) api.killPty(id).catch(() => {});
    });
  },

  deleteLayoutPreset: (workspaceId, presetId) => {
    set((s) => {
      const update: Partial<WorkspaceState> = {
        layoutPresets: {
          ...s.layoutPresets,
          [workspaceId]: (s.layoutPresets[workspaceId] ?? []).filter(
            (p) => p.id !== presetId,
          ),
        },
      };
      // Clear active preset if the deleted one was active
      if (s.activePresetId[workspaceId] === presetId) {
        const { [workspaceId]: _, ...rest } = s.activePresetId;
        update.activePresetId = rest;
      }
      return update;
    });
  },

  openFile: (workspaceId, filePath, options) => {
    // Close git diff overlay if open — opening a file should take precedence
    if (get().unifiedGitPanelOpen) {
      set({ unifiedGitPanelOpen: false, unifiedGitPanelPath: null, gitDiffScrollToFile: null, prReviewScrollToFile: null });
    }

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
        // Update line:col even if already focused (user Cmd+clicked a different line)
        if (options?.line) {
          get().transformPane(workspaceId, targetGroupId, existing.id, {
            initialLine: options.line,
            initialCol: options.col,
          });
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
      initialLine: options?.line,
      initialCol: options?.col,
    };
    get().addPaneToGroup(workspaceId, targetGroupId, pane);
  },

  revealFileInExplorer: (filePath) => {
    set({ revealedFilePath: filePath });
    // Auto-clear after the explorer has had time to expand + scroll
    setTimeout(() => set({ revealedFilePath: null }), 1000);
  },

  setGitDiffActiveTab: (tab) => {
    set({ gitDiffActiveTab: tab });
  },

  openUnifiedGitPanel: (rootPath, tab) => {
    set((prev) => ({
      unifiedGitPanelOpen: true,
      unifiedGitPanelPath: rootPath,
      // Only change tab if explicitly provided; otherwise keep current tab
      unifiedGitPanelTab: tab ?? prev.unifiedGitPanelTab,
    }));
    // Eagerly refresh PR status so the PR tab shows fresh data
    if (tab === "pr") {
      get().refreshPrStatusForPath(rootPath).catch(() => {});
    }
  },
  closeUnifiedGitPanel: () => set({
    unifiedGitPanelOpen: false,
    unifiedGitPanelPath: null,
    gitDiffScrollToFile: null,
    prReviewScrollToFile: null,
  }),
  setUnifiedGitPanelTab: (tab) => set({ unifiedGitPanelTab: tab }),

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

    // Helper: remove pane from source group WITHOUT killing the PTY.
    // closePane() kills the PTY which destroys terminal content during moves.
    function removePaneFromSource(): { groups: Record<string, PaneGroup>; root: LayoutNode } {
      const currentLayout = get().getOrCreateLayout(workspaceId);
      const src = currentLayout.groups[sourceGroupId];
      if (!src) return { groups: currentLayout.groups, root: currentLayout.root };

      const remaining = src.panes.filter((p) => p.id !== sourcePaneId);
      let groups = { ...currentLayout.groups };
      let root = currentLayout.root;

      if (remaining.length === 0 && sourceGroupId !== targetGroupId) {
        // Source group is now empty — collapse it from the tree
        const parentInfo = findParent(root, sourceGroupId);
        if (parentInfo) {
          const sibIdx = parentInfo.index === 0 ? 1 : 0;
          const sibling = parentInfo.parent.children[sibIdx];
          root = replaceNode(root, parentInfo.parent.id, sibling);
        }
        delete groups[sourceGroupId];
      } else if (remaining.length > 0) {
        groups[sourceGroupId] = {
          ...src,
          panes: remaining,
          activePaneId:
            src.activePaneId === sourcePaneId
              ? remaining[0].id
              : src.activePaneId,
        };
      }
      return { groups, root };
    }

    // "center" = move tab to target group (no split)
    if (position === "center") {
      if (sourceGroupId === targetGroupId) return;
      // Add pane to target, then remove from source (PTY stays alive)
      get().addPaneToGroup(workspaceId, targetGroupId, pane);
      const { groups: newGroups, root: newRoot } = removePaneFromSource();
      set((s) => ({
        layouts: {
          ...s.layouts,
          [workspaceId]: { root: newRoot, groups: newGroups },
        },
      }));
      return;
    }

    // For top/bottom/left/right: create a new group with this pane, split the target
    const direction: "horizontal" | "vertical" =
      position === "left" || position === "right" ? "horizontal" : "vertical";
    const newFirst = position === "top" || position === "left";

    // Create a new group for the dropped pane
    const newGroup: PaneGroup = {
      id: crypto.randomUUID(),
      panes: [pane],
      activePaneId: pane.id,
    };

    // Remove pane from source (PTY stays alive)
    let { groups: newGroups, root: newRoot } = removePaneFromSource();
    newGroups[newGroup.id] = newGroup;

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
      storage: workspacePersistStorage,
      partialize: (state) => ({
        activeWorkspaceId: state.activeWorkspaceId,
        activePathIndex: state.activePathIndex,
        layouts: state.layouts,
        activeGroupIds: state.activeGroupIds,
        layoutPresets: state.layoutPresets,
        activePresetId: state.activePresetId,
        gitDiffActiveTab: state.gitDiffActiveTab,
        unifiedGitPanelOpen: state.unifiedGitPanelOpen,
        unifiedGitPanelPath: state.unifiedGitPanelPath,
        unifiedGitPanelTab: state.unifiedGitPanelTab,
      }),
      merge: (persisted, current) => {
        const p = persisted as Partial<WorkspaceState> | undefined;
        return {
          ...current,
          activeWorkspaceId: p?.activeWorkspaceId ?? current.activeWorkspaceId,
          activePathIndex: p?.activePathIndex ?? current.activePathIndex,
          layouts: restoreLayouts(p?.layouts ?? {}),
          activeGroupIds: p?.activeGroupIds ?? current.activeGroupIds,
          layoutPresets: (p?.layoutPresets && typeof p.layoutPresets === "object") ? p.layoutPresets : {},
          activePresetId: (p?.activePresetId && typeof p.activePresetId === "object") ? p.activePresetId : {},
          gitDiffActiveTab: p?.gitDiffActiveTab ?? "unstaged",
          unifiedGitPanelOpen: p?.unifiedGitPanelOpen ?? false,
          unifiedGitPanelPath: p?.unifiedGitPanelPath ?? null,
          unifiedGitPanelTab: (p?.unifiedGitPanelTab === "pr" ? "pr" : "changes") as "changes" | "pr",
        };
      },
    }
  )
);

// Expose store accessor globally for the test bridge (only used when RALLY_TEST_MODE=1)
(window as any).__rallyStoreAccessor = () => useWorkspaceStore.getState();

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
