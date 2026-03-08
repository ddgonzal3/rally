import { create } from "zustand";
import { persist } from "zustand/middleware";
import { listen } from "@tauri-apps/api/event";
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
  RallyConfig,
  WorkspaceMode,
  ProductSession,
  ShellPanel,
  ThemeName,
  DetectedPort,
} from "../lib/types";
import { detectPorts } from "../lib/portDetection";
import {
  createDefaultLayout,
  replaceNode,
  findParent,
  findFirstGroupInSubtree,
} from "../lib/types";
import { api } from "../lib/tauri";
import { getExpandedPaths, setExpandedPaths } from "../components/FileExplorer";
import {
  clearWatcherStatusCache,
  inferScriptCompletionStatus,
  isWatcherScript,
  observeWatcherOutput,
} from "../lib/watcherStatus";

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

/**
 * Module-level buffer for ALL PTY output, keyed by ptyId.
 * Allows replaying output when a terminal remounts (e.g. after a split).
 * Limited to MAX_PTY_BUFFER_CHUNKS to prevent unbounded memory growth.
 */
const MAX_PTY_BUFFER_CHUNKS = 500;
const MAX_SHIP_BUFFER_CHUNKS = 500;
const MAX_SCRIPT_BUFFER_CHUNKS = 500;
export const ptyOutputBuffers = new Map<string, Uint8Array[]>();

function pushLimitedChunk(
  buffer: Uint8Array[],
  chunk: Uint8Array,
  maxChunks: number,
) {
  buffer.push(chunk);
  if (buffer.length > maxChunks) {
    buffer.splice(0, buffer.length - maxChunks);
  }
}

export function appendPtyBuffer(ptyId: string, chunk: Uint8Array) {
  let buf = ptyOutputBuffers.get(ptyId);
  if (!buf) {
    buf = [];
    ptyOutputBuffers.set(ptyId, buf);
  }
  pushLimitedChunk(buf, chunk, MAX_PTY_BUFFER_CHUNKS);
}

export function clearPtyBuffer(ptyId: string) {
  ptyOutputBuffers.delete(ptyId);
}

// --- Drawer hover-close timer ---
let _drawerHoverTimer: ReturnType<typeof setTimeout> | null = null;

export function cancelDrawerHoverClose() {
  if (_drawerHoverTimer) {
    clearTimeout(_drawerHoverTimer);
    _drawerHoverTimer = null;
  }
}

export function startDrawerHoverClose(close: () => void, delay = 120) {
  cancelDrawerHoverClose();
  _drawerHoverTimer = setTimeout(() => {
    _drawerHoverTimer = null;
    close();
  }, delay);
}

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
  "webview",
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
  workspaceModes: Record<string, WorkspaceMode>;
};

const workspacePersistStorage = (() => {
  const PERSIST_DEBOUNCE_MS = 150;
  type PersistRefs = {
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
    workspaceModes: PersistedWorkspaceState["workspaceModes"];
    version: number;
  };
  let lastRefs: PersistRefs | null = null;
  let pending: {
    name: string;
    value: { state: PersistedWorkspaceState; version?: number };
    refs: PersistRefs;
  } | null = null;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  function buildRefs(
    state: PersistedWorkspaceState,
    version: number,
  ): PersistRefs {
    return {
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
      workspaceModes: state.workspaceModes,
      version,
    };
  }

  function sameRefs(
    a: PersistRefs | null,
    b: PersistRefs,
  ) {
    return !!a &&
      a.version === b.version &&
      a.activeWorkspaceId === b.activeWorkspaceId &&
      a.activePathIndex === b.activePathIndex &&
      a.layouts === b.layouts &&
      a.activeGroupIds === b.activeGroupIds &&
      a.layoutPresets === b.layoutPresets &&
      a.activePresetId === b.activePresetId &&
      a.gitDiffActiveTab === b.gitDiffActiveTab &&
      a.unifiedGitPanelOpen === b.unifiedGitPanelOpen &&
      a.unifiedGitPanelPath === b.unifiedGitPanelPath &&
      a.unifiedGitPanelTab === b.unifiedGitPanelTab &&
      a.workspaceModes === b.workspaceModes;
  }

  function flushPending() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (!pending) return;
    const next = pending;
    pending = null;
    localStorage.setItem(next.name, JSON.stringify(next.value));
    lastRefs = next.refs;
  }

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushPending);
    window.addEventListener("beforeunload", flushPending);
  }

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
      const refs = buildRefs(state, resolvedVersion);
      if (sameRefs(lastRefs, refs) || sameRefs(pending?.refs ?? null, refs)) {
        return;
      }
      pending = { name, value, refs };
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(flushPending, PERSIST_DEBOUNCE_MS);
    },
    removeItem: (name: string) => {
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      pending = null;
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
  /** Timestamp of last successful PR fetch per repo path */
  prStatusFetchedAt: Record<string, number>;
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
  /** Per-workspace bottom panel collapsed state */
  bottomPanelCollapsed: Record<string, boolean>;
  toggleBottomPanel: (workspaceId: string) => void;
  /** Set of pane IDs with unsaved editor changes */
  dirtyPanes: Set<string>;
  /** Workspace mode per workspace ID (product or dev) */
  workspaceModes: Record<string, WorkspaceMode>;
  /** PRD mode sessions keyed by workspace ID (in-memory only, not persisted) */
  productSessions: Record<string, ProductSession>;
  /** Bottom shell panel keyed by workspace ID (in-memory only) */
  shellPanels: Record<string, ShellPanel>;
  /** Cached RALLY.json configs per repo path (not persisted) */
  rallyConfigs: Record<string, RallyConfig>;
  /** Which script's drawer is currently open, or null */
  statusBarDrawer: { repoPath: string; scriptName: string; hoverMode: boolean } | null;
  /** Detected localhost ports keyed by workspace ID */
  detectedPorts: Record<string, DetectedPort[]>;
  addDetectedPort: (workspaceId: string, port: DetectedPort) => void;
  removePortsByPty: (ptyId: string) => void;
  removePortsByScript: (repoPath: string, scriptName: string) => void;
  /** Current UI theme */
  theme: ThemeName;
  setTheme: (theme: ThemeName) => void;

  // Dirty pane tracking
  markPaneDirty: (paneId: string) => void;
  markPaneClean: (paneId: string) => void;

  // Mode actions
  setWorkspaceMode: (workspaceId: string, mode: WorkspaceMode) => void;
  loadRallyConfig: (rootPath: string) => Promise<void>;

  // Status bar actions
  openStatusBarDrawer: (repoPath: string, scriptName: string, hoverMode?: boolean) => void;
  closeStatusBarDrawer: () => void;
  closeDrawerIfHover: () => void;
  addToStatusBar: (rootPath: string, scriptName: string) => Promise<void>;
  removeFromStatusBar: (rootPath: string, scriptName: string) => Promise<void>;

  // Product session actions
  setProductSession: (workspaceId: string, session: ProductSession) => void;
  clearProductSession: (workspaceId: string) => void;

  // Shell panel actions
  toggleShellPanel: (workspaceId: string, rootPath: string) => Promise<void>;
  hideShellPanel: (workspaceId: string) => void;

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
  syncBranch: (path: string, mainBranch: string) => Promise<string>;
  // Layout actions
  getOrCreateLayout: (workspaceId: string) => WorkspaceLayout;
  splitGroup: (
    workspaceId: string,
    groupId: string,
    direction: SplitDirection,
    cwd?: string,
    paneOverride?: Partial<Pane>
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
    ratio: number,
    syncPeers?: boolean
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
  /** Rename a saved layout preset */
  renameLayoutPreset: (workspaceId: string, presetId: string, newName: string) => void;
  /** Reorder layout presets */
  reorderLayoutPresets: (workspaceId: string, presetIds: string[]) => void;
  /** Delete a saved layout preset */
  deleteLayoutPreset: (workspaceId: string, presetId: string) => void;
  /** Open a file in an editor pane in the top area of the layout */
  openFile: (workspaceId: string, filePath: string, options?: { line?: number; col?: number; skipReveal?: boolean }) => void;
  /** Open a webview pane to display a URL or local HTML file */
  openWebView: (workspaceId: string, url: string) => void;
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

  /** Open a plain terminal tab in the active (or first) group. */
  openTerminalInActiveGroup: (workspaceId: string, cwd: string) => void;

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
  if (typeof raw.webviewUrl === "string") pane.webviewUrl = raw.webviewUrl;
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

/** Convert a pane to claude-launcher if it should be one, stripping ptyId/scriptBufferKey. */
function sanitizePaneForPreset(pane: Pane): Pane {
  const { ptyId: _, scriptBufferKey: _2, ...rest } = pane;
  if (!shouldRestoreAsClaudeLauncher(rest)) return rest;
  return {
    id: rest.id,
    type: "claude-launcher" as const,
    title: rest.type === "claude" ? rest.title : "Claude Code",
    ...(rest.cwd ? { cwd: rest.cwd } : {}),
  };
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

/**
 * Depth-first traversal of a layout tree producing an ordered list of groups.
 * Position 0 = top-left (first leaf), etc. Used for positional matching when
 * restoring layout presets so we can preserve PTYs across layout switches.
 */
function flattenLayoutGroups(layout: WorkspaceLayout): PaneGroup[] {
  const groups: PaneGroup[] = [];
  function walk(node: LayoutNode) {
    if (node.type === "group") {
      const g = layout.groups[node.groupId];
      if (g) groups.push(g);
    } else {
      walk(node.children[0]);
      walk(node.children[1]);
    }
  }
  walk(layout.root);
  return groups;
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
    a.tracking_ahead === b.tracking_ahead &&
    a.tracking_behind === b.tracking_behind &&
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
  prStatusFetchedAt: {},
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
  bottomPanelCollapsed: {},
  dirtyPanes: new Set(),
  workspaceModes: {},
  productSessions: {},
  shellPanels: {},
  rallyConfigs: {},
  statusBarDrawer: null,
  detectedPorts: {},
  addDetectedPort: (workspaceId, port) => {
    set((s) => {
      const existing = s.detectedPorts[workspaceId] ?? [];
      const isDup = existing.some(
        (p) =>
          p.port === port.port &&
          p.source.type === port.source.type &&
          (port.source.type === "pane"
            ? (p.source as { type: "pane"; ptyId: string }).ptyId === port.source.ptyId
            : (p.source as { type: "script"; repoPath: string; scriptName: string }).scriptName ===
              (port.source as { type: "script"; repoPath: string; scriptName: string }).scriptName),
      );
      if (isDup) return s;
      return {
        detectedPorts: { ...s.detectedPorts, [workspaceId]: [...existing, port] },
      };
    });
  },
  removePortsByPty: (ptyId) => {
    set((s) => {
      const updated: Record<string, DetectedPort[]> = {};
      let changed = false;
      for (const [wsId, ports] of Object.entries(s.detectedPorts)) {
        const filtered = ports.filter(
          (p) => !(p.source.type === "pane" && p.source.ptyId === ptyId),
        );
        updated[wsId] = filtered.length !== ports.length ? filtered : ports;
        if (filtered.length !== ports.length) changed = true;
      }
      return changed ? { detectedPorts: updated } : s;
    });
  },
  removePortsByScript: (repoPath, scriptName) => {
    set((s) => {
      const updated: Record<string, DetectedPort[]> = {};
      let changed = false;
      for (const [wsId, ports] of Object.entries(s.detectedPorts)) {
        const filtered = ports.filter(
          (p) =>
            !(p.source.type === "script" && p.source.repoPath === repoPath && p.source.scriptName === scriptName),
        );
        updated[wsId] = filtered.length !== ports.length ? filtered : ports;
        if (filtered.length !== ports.length) changed = true;
      }
      return changed ? { detectedPorts: updated } : s;
    });
  },
  theme: (localStorage.getItem('rally:theme') as ThemeName) || 'dark',
  setTheme: (theme) => {
    localStorage.setItem('rally:theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
    // Force WebKit to repaint backdrop-filter composited layers —
    // toggling display forces full layout invalidation
    document.body.style.display = 'none';
    // Reading offsetHeight forces a synchronous reflow
    void document.body.offsetHeight;
    document.body.style.display = '';
    set({ theme });
  },

  toggleBottomPanel: (workspaceId) => {
    set((s) => ({
      bottomPanelCollapsed: {
        ...s.bottomPanelCollapsed,
        [workspaceId]: !s.bottomPanelCollapsed[workspaceId],
      },
    }));
  },

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

  // --- Mode actions ---

  setWorkspaceMode: (workspaceId, mode) => {
    set((s) => ({ workspaceModes: { ...s.workspaceModes, [workspaceId]: mode } }));
  },

  loadRallyConfig: async (rootPath) => {
    try {
      const config = await api.readRallyConfig(rootPath);
      set((s) => ({ rallyConfigs: { ...s.rallyConfigs, [rootPath]: config } }));
    } catch (e) {
      console.error(`Failed to load RALLY.json for ${rootPath}:`, e);
    }
  },

  // --- Status bar actions ---

  openStatusBarDrawer: (repoPath, scriptName, hoverMode = false) => {
    const current = get().statusBarDrawer;
    const isSame = current?.repoPath === repoPath && current?.scriptName === scriptName;

    if (hoverMode) {
      // Don't override a click-mode drawer for the same script
      if (isSame && !current!.hoverMode) return;
      set({ statusBarDrawer: { repoPath, scriptName, hoverMode: true } });
      return;
    }

    // Click: if same script in click mode, toggle off; otherwise open in click mode
    if (isSame && !current!.hoverMode) {
      set({ statusBarDrawer: null });
    } else {
      set({ statusBarDrawer: { repoPath, scriptName, hoverMode: false } });
    }
  },

  closeStatusBarDrawer: () => {
    cancelDrawerHoverClose();
    set({ statusBarDrawer: null });
  },

  closeDrawerIfHover: () => {
    const current = get().statusBarDrawer;
    if (current?.hoverMode) {
      set({ statusBarDrawer: null });
    }
  },

  addToStatusBar: async (rootPath, scriptName) => {
    const config = get().rallyConfigs[rootPath];
    const current = config?.statusBar ?? [];
    if (current.includes(scriptName)) return;
    const updated = [...current, scriptName];
    await api.updateRallyConfigStatusBar(rootPath, updated);
    // Refresh cached config
    await get().loadRallyConfig(rootPath);
  },

  removeFromStatusBar: async (rootPath, scriptName) => {
    const config = get().rallyConfigs[rootPath];
    const current = config?.statusBar ?? [];
    const updated = current.filter((s: string) => s !== scriptName);
    await api.updateRallyConfigStatusBar(rootPath, updated);
    await get().loadRallyConfig(rootPath);
  },

  // --- Product session actions ---

  setProductSession: (workspaceId, session) => {
    set((s) => ({
      productSessions: { ...s.productSessions, [workspaceId]: session },
    }));
  },
  clearProductSession: (workspaceId) => {
    set((s) => {
      const { [workspaceId]: _, ...rest } = s.productSessions;
      return { productSessions: rest };
    });
  },

  // --- Shell panel actions ---

  toggleShellPanel: async (workspaceId, rootPath) => {
    const s = get();
    const existing = s.shellPanels[workspaceId];
    if (existing) {
      // Toggle visibility
      set({
        shellPanels: {
          ...s.shellPanels,
          [workspaceId]: { ...existing, visible: !existing.visible },
        },
      });
      return;
    }
    // Spawn a new shell PTY
    const ptyId = await api.spawnPty(rootPath, null, 80, 24);
    set({
      shellPanels: {
        ...get().shellPanels,
        [workspaceId]: { ptyId, visible: true },
      },
    });
  },
  hideShellPanel: (workspaceId) => {
    const s = get();
    const existing = s.shellPanels[workspaceId];
    if (existing) {
      set({
        shellPanels: {
          ...s.shellPanels,
          [workspaceId]: { ...existing, visible: false },
        },
      });
    }
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
    const { layouts, workspaceModes, productSessions, shellPanels, ...rest } = get();
    const newLayouts = { ...layouts };
    delete newLayouts[id];
    const newModes = { ...workspaceModes };
    delete newModes[id];
    const newSessions = { ...productSessions };
    delete newSessions[id];
    const newShells = { ...shellPanels };
    delete newShells[id];
    set({
      ...rest,
      workspaces: remaining,
      layouts: newLayouts,
      workspaceModes: newModes,
      productSessions: newSessions,
      shellPanels: newShells,
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

    const changedPaths: string[] = [];
    set((s) => {
      let changed = false;
      const next = { ...s.gitStatuses };
      for (const result of results) {
        if (!result) continue;
        const prev = s.gitStatuses[result.path];
        if (!prev || !gitStatusEqual(prev, result.status)) {
          next[result.path] = result.status;
          changed = true;
          changedPaths.push(result.path);
        }
      }
      return changed ? { gitStatuses: next } : s;
    });

    // When git status changes (push, commit, branch switch, etc.),
    // refresh PR status for affected paths so PRs show up immediately
    if (changedPaths.length > 0) {
      for (const path of changedPaths) {
        get().refreshPrStatusForPath(path).catch(() => {});
      }
    }
  },

  refreshPrStatusForPath: async (path) => {
    try {
      const prStatus = await api.gitPrStatus(path);
      // Skip update if nothing changed — prevents unnecessary re-renders
      const prev = get().prStatuses[path];
      if (prStatusEqual(prev ?? null, prStatus)) {
        set((s) => ({ prStatusFetchedAt: { ...s.prStatusFetchedAt, [path]: Date.now() } }));
        return;
      }
      set((s) => ({
        prStatuses: { ...s.prStatuses, [path]: prStatus },
        prStatusFetchedAt: { ...s.prStatusFetchedAt, [path]: Date.now() },
      }));
    } catch {
      // Keep existing PR status on error (e.g. rate limit, network blip).
      // Only clear if there was no previous status at all.
      const prev = get().prStatuses[path];
      if (prev !== undefined) return;
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
      const nextFetchedAt = { ...s.prStatusFetchedAt };
      for (const result of results) {
        if (result.error) {
          // Keep existing PR status on error (e.g. rate limit, network blip).
          // Only clear if there was no previous status at all.
          if (s.prStatuses[result.path] !== undefined) continue;
          next[result.path] = null;
          changed = true;
          continue;
        }
        const prev = s.prStatuses[result.path];
        nextFetchedAt[result.path] = Date.now();
        if (prStatusEqual(prev ?? null, result.prStatus)) continue;
        next[result.path] = result.prStatus;
        changed = true;
      }
      return changed
        ? { prStatuses: next, prStatusFetchedAt: nextFetchedAt }
        : { prStatusFetchedAt: nextFetchedAt };
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

  syncBranch: async (path, mainBranch) => {
    try {
      const result = await api.gitSync(path, mainBranch);
      await get().refreshGitStatusForPath(path, mainBranch);
      return result;
    } catch (e) {
      // Refresh status even on failure
      get().refreshGitStatusForPath(path, mainBranch).catch(() => {});
      const msg = String(e);
      if (msg.includes("dirty")) {
        throw new Error("Commit or stash changes first");
      }
      if (msg.includes("CONFLICT") || msg.includes("conflict")) {
        throw new Error("Rebase had conflicts — aborted automatically");
      }
      if (msg.includes("Already on main")) {
        throw new Error("Already on main branch");
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
          pushLimitedChunk(shipOutputBuffer, chunk, MAX_SHIP_BUFFER_CHUNKS);
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
          root: normalizeLayoutTree(newRoot),
          groups: { ...layout.groups, [newGroup.id]: newGroup },
        },
      },
    }));
  },

  openTerminalInActiveGroup: (workspaceId, cwd) => {
    const layout = get().getOrCreateLayout(workspaceId);
    const activeGroupId = get().activeGroupIds[workspaceId];

    const folderName = cwd.split("/").pop() ?? "Terminal";
    const pane: Pane = {
      id: crypto.randomUUID(),
      type: "terminal",
      title: folderName,
      cwd,
    };

    // Try the active group first, then find the first group in the tree
    const targetGroupId = activeGroupId && layout.groups[activeGroupId]
      ? activeGroupId
      : findFirstGroupInSubtree(layout.root);

    if (targetGroupId) {
      get().addPaneToGroup(workspaceId, targetGroupId, pane);
    } else {
      // Fallback: create as bottom (shouldn't normally happen)
      get().openTerminalInBottom(workspaceId, cwd);
    }
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
    const isWatcher = isWatcherScript(scriptName);

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
    clearWatcherStatusCache(key);
    scriptOutputBuffers.set(key, []);

    set((s) => ({
      scriptRuns: {
        ...s.scriptRuns,
        [key]: {
          scriptName,
          ptyId,
          status: "running",
          exitCode: null,
          watcherBuildStatus: isWatcher ? "building" : undefined,
        },
      },
    }));

    // Buffer PTY output in module-level array (not Zustand state)
    const decoder = new TextDecoder("utf-8", { fatal: false });
    // Throttle watcher status updates to avoid excessive Zustand set() calls
    // and React re-renders when a noisy watcher fires many chunks per second.
    let pendingWatcherStatus: typeof undefined | string = undefined;
    let watcherStatusRafId = 0;
    const flushWatcherStatus = () => {
      watcherStatusRafId = 0;
      if (pendingWatcherStatus === undefined) return;
      const nextStatus = pendingWatcherStatus as string;
      pendingWatcherStatus = undefined;
      const currentRun = get().scriptRuns[key];
      if (currentRun && currentRun.watcherBuildStatus !== nextStatus) {
        set((s) => {
          const run = s.scriptRuns[key];
          if (!run) return s;
          return {
            scriptRuns: {
              ...s.scriptRuns,
              [key]: {
                ...run,
                status: "running",
                exitCode: null,
                watcherBuildStatus: nextStatus as any,
              },
            },
          };
        });
      }
    };
    // Throttle the custom event dispatch too — high-frequency watchers can
    // fire hundreds of events per second, each triggering a DOM dispatch.
    // Accumulate new chunks between rAF dispatches so the drawer can write
    // them directly instead of tracking buffer indices (which break when
    // pushLimitedChunk splices old entries from the front).
    let outputEventRafId = 0;
    let pendingChunksForEvent: Uint8Array[] = [];

    const unlistenOutput = await listen<{ data: number[] }>(
      `pty-output-${ptyId}`,
      (event) => {
        const chunk = new Uint8Array(event.payload.data);
        const text = decoder.decode(chunk, { stream: true });
        const buf = scriptOutputBuffers.get(key);
        if (buf) {
          pushLimitedChunk(buf, chunk, MAX_SCRIPT_BUFFER_CHUNKS);
          pendingChunksForEvent.push(chunk);
          // Notify drawer that watcher output changed — throttled to once per frame
          if (!outputEventRafId) {
            outputEventRafId = requestAnimationFrame(() => {
              outputEventRafId = 0;
              const chunks = pendingChunksForEvent;
              pendingChunksForEvent = [];
              document.dispatchEvent(new CustomEvent("rally:watcher-output", { detail: { key, chunks } }));
            });
          }
        }
        if (isWatcher) {
          const nextWatcherBuildStatus = observeWatcherOutput(key, text);
          pendingWatcherStatus = nextWatcherBuildStatus;
          if (!watcherStatusRafId) {
            watcherStatusRafId = requestAnimationFrame(flushWatcherStatus);
          }
        }
        // Detect localhost ports in script output
        if (text.includes("localhost") || text.includes("127.0.0.1") || /\bport\s+\d/i.test(text)) {
          const ports = detectPorts(text);
          if (ports.length > 0) {
            // Find workspace containing this rootPath
            const ws = get().workspaces.find((w) => w.paths.includes(rootPath));
            if (ws) {
              for (const p of ports) {
                get().addDetectedPort(ws.id, {
                  ...p,
                  source: { type: "script", repoPath: rootPath, scriptName },
                  detectedAt: Date.now(),
                });
              }
            }
          }
        }
      }
    );

    const finalizeRun = () => {
      const current = get().scriptRuns[key];
      if (!current || current.status !== "running") return;
      get().removePortsByScript(rootPath, scriptName);
      const finalStatus = inferScriptCompletionStatus(key, scriptName);
      set((s) => ({
        scriptRuns: {
          ...s.scriptRuns,
          [key]: {
            ...s.scriptRuns[key],
            status: finalStatus,
            exitCode: finalStatus === "error" ? 1 : 0,
            watcherBuildStatus: isWatcher
              ? (s.scriptRuns[key].watcherBuildStatus ?? (finalStatus === "error" ? "error" : "success"))
              : s.scriptRuns[key].watcherBuildStatus,
          },
        },
      }));
    };

    const markRunning = () => {
      const current = get().scriptRuns[key];
      if (!current || current.status === "running") return;
      set((s) => ({
        scriptRuns: {
          ...s.scriptRuns,
          [key]: {
            ...s.scriptRuns[key],
            status: "running",
            exitCode: null,
            watcherBuildStatus: isWatcher ? "building" : s.scriptRuns[key].watcherBuildStatus,
          },
        },
      }));
    };

    let sawForegroundProcess = false;
    const syncForegroundProcess = (proc: string | null) => {
      if (proc !== null) {
        sawForegroundProcess = true;
        markRunning();
        return;
      }
      if (!sawForegroundProcess) return;
      sawForegroundProcess = false;
      finalizeRun();
    };

    const unlistenForeground = await listen<{ process: string | null }>(
      `pty-foreground-${ptyId}`,
      (event) => {
        syncForegroundProcess(event.payload.process);
      }
    );

    api.getPtyForegroundProcess(ptyId)
      .then((proc) => syncForegroundProcess(proc))
      .catch(() => {
        /* PTY might be gone */
      });

    const startupFallbackTimer = setTimeout(() => {
      if (sawForegroundProcess) return;
      api.getPtyForegroundProcess(ptyId)
        .then((proc) => {
          if (proc !== null) {
            syncForegroundProcess(proc);
            return;
          }
          const buf = scriptOutputBuffers.get(key);
          if (buf && buf.length > 0) finalizeRun();
        })
        .catch(() => {
          /* PTY might be gone */
        });
    }, 2500);

    // Listen for PTY exit (shell itself exits — e.g. user types `exit`)
    const unlistenExit = await listen<{ code: number | null }>(
      `pty-exit-${ptyId}`,
      (event) => {
        clearTimeout(startupFallbackTimer);
        const code = event.payload.code;
        const current = get().scriptRuns[key];
        // Only update if still running (poll may have already marked it)
        if (current && current.status === "running") {
          const finalStatus = isWatcher
            ? inferScriptCompletionStatus(key, scriptName)
            : code === 0 ? "success" : "error";
          set((s) => ({
            scriptRuns: {
              ...s.scriptRuns,
              [key]: {
                ...s.scriptRuns[key],
                status: finalStatus,
                exitCode: code,
                watcherBuildStatus: isWatcher
                  ? (s.scriptRuns[key].watcherBuildStatus ?? (finalStatus === "error" ? "error" : "success"))
                  : s.scriptRuns[key].watcherBuildStatus,
              },
            },
          }));
        }
        unlistenForeground();
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

    // Clean up detected ports from this script
    get().removePortsByScript(rootPath, scriptName);

    // Only update if the run still exists (clearScript may have already removed it)
    set((s) => {
      if (!s.scriptRuns[key]) return s;
      return {
        scriptRuns: {
          ...s.scriptRuns,
          [key]: { ...s.scriptRuns[key], status: "stopped" },
        },
      };
    });
  },

  clearScript: (rootPath, scriptName) => {
    const key = `${rootPath}:${scriptName}`;
    clearWatcherStatusCache(key);
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
    if (existing) {
      // Normalize persisted layouts so H(V,V) becomes V(H,H)
      const normalized = normalizeLayoutTree(existing.root);
      if (normalized !== existing.root) {
        const updated = { ...existing, root: normalized };
        set((s) => ({
          layouts: { ...s.layouts, [workspaceId]: updated },
        }));
        return updated;
      }
      return existing;
    }
    const layout = createDefaultLayout();
    set((s) => ({
      layouts: { ...s.layouts, [workspaceId]: layout },
    }));
    return layout;
  },

  splitGroup: (workspaceId, groupId, direction, cwd?, paneOverride?) => {
    const layout = get().getOrCreateLayout(workspaceId);
    // Create a new group with a terminal pane (or override)
    const newPane: Pane = {
      id: crypto.randomUUID(),
      type: "terminal",
      title: "Terminal",
      ...(cwd ? { cwd } : {}),
      ...paneOverride,
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
          root: normalizeLayoutTree(newRoot),
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
        // Bottom row — collapse the panel instead of manipulating ratio.
        const topGroupId = findFirstGroupInSubtree(layout.root.type === "split" ? layout.root.children[0] : layout.root);
        set((s) => ({
          activeGroupIds: {
            ...s.activeGroupIds,
            [workspaceId]: topGroupId ?? s.activeGroupIds[workspaceId],
          },
          bottomPanelCollapsed: {
            ...s.bottomPanelCollapsed,
            [workspaceId]: true,
          },
          layouts: {
            ...s.layouts,
            [workspaceId]: {
              ...layout,
              groups: {
                ...layout.groups,
                [groupId]: { ...group, panes: [], activePaneId: "", paneHistory: [] },
              },
            },
          },
        }));
        if (topGroupId) {
          setTimeout(() => {
            window.dispatchEvent(
              new CustomEvent("rally-focus-group", { detail: topGroupId }),
            );
          }, 0);
        }
      } else {
        // Group has siblings — collapse it so the sibling expands.
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
      // Focus the most recently used tab from history
      const mruPick = [...newHistory].reverse().find((id) => remainingIds.has(id));
      if (mruPick) {
        newActive = mruPick;
      } else {
        // Fallback: left neighbor → right neighbor → first remaining
        const closedIndex = group.panes.findIndex((p) => p.id === paneId);
        const leftNeighbor = closedIndex > 0 ? group.panes[closedIndex - 1] : null;
        const rightNeighbor = closedIndex < group.panes.length - 1 ? group.panes[closedIndex + 1] : null;
        newActive = (leftNeighbor ?? rightNeighbor)?.id ?? newPanes[0]?.id ?? "";
      }
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
        [workspaceId]: { root: normalizeLayoutTree(newRoot), groups: newGroups },
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

  updateSplitRatio: (workspaceId, splitId, ratio, syncPeersFlag) => {
    const layout = get().getOrCreateLayout(workspaceId);
    let clamped = Math.max(0.15, Math.min(0.85, ratio));
    const targetSplit = findSplitById(layout.root, splitId);
    if (!targetSplit) return;
    // Snap column dividers to peer positions in adjacent rows
    if (targetSplit.direction === "horizontal") {
      clamped = snapToPeerRatio(layout.root, splitId, clamped);
    }
    if (Math.abs(targetSplit.ratio - clamped) < 0.0001) {
      return;
    }
    let newRoot = replaceNode(layout.root, splitId, {
      ...targetSplit,
      ratio: clamped,
    });
    // Sync row dividers across columns so heights stay aligned.
    // Column dividers (horizontal splits) are always independent per row.
    if (targetSplit.direction === "vertical") {
      newRoot = syncPeerVerticalSplits(newRoot, splitId, clamped);
    }
    // Option+drag: sync column dividers across rows
    if (syncPeersFlag && targetSplit.direction === "horizontal") {
      newRoot = syncPeerHorizontalSplits(newRoot, splitId, clamped);
    }
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
      groups[gId] = { ...group, panes: group.panes.map(sanitizePaneForPreset) };
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
      groups[gId] = { ...group, panes: group.panes.map(sanitizePaneForPreset) };
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

    // Collect ALL old PTY IDs from the current layout. We'll remove
    // preserved ones before killing the rest.
    const oldPtyIds = new Set<string>();
    const currentLayout = get().layouts[workspaceId];
    if (currentLayout) {
      for (const group of Object.values(currentLayout.groups)) {
        for (const pane of group.panes) {
          if (pane.ptyId) oldPtyIds.add(pane.ptyId);
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

    // Sanitize cloned panes: convert terminal panes that should be claude-launchers.
    // This fixes presets saved before the shouldRestoreAsClaudeLauncher check was added.
    for (const group of Object.values(cloned.groups)) {
      group.panes = group.panes.map(sanitizePaneForPreset);
    }

    // --- PTY preservation: match old panes to new panes by position + type + cwd ---
    const preservedPtyIds = new Set<string>();
    if (currentLayout) {
      const oldGroups = flattenLayoutGroups(currentLayout);
      const newGroups = flattenLayoutGroups(cloned);
      const consumedOldPanes = new Set<string>(); // old pane IDs already matched
      const claudeTypes = new Set(["claude", "claude-launcher"]);

      for (let gi = 0; gi < Math.min(oldGroups.length, newGroups.length); gi++) {
        const oldGroup = oldGroups[gi];
        const newGroup = newGroups[gi];

        for (const newPane of newGroup.panes) {
          // Find a matching old pane in the same positional group
          const match = oldGroup.panes.find((oldPane) => {
            if (consumedOldPanes.has(oldPane.id)) return false;
            if (!oldPane.ptyId) return false;
            // Type compatibility: claude/claude-launcher match each other
            const typeCompatible =
              (claudeTypes.has(oldPane.type) && claudeTypes.has(newPane.type)) ||
              oldPane.type === newPane.type;
            if (!typeCompatible) return false;
            if ((oldPane.cwd ?? "") !== (newPane.cwd ?? "")) return false;
            return true;
          });

          if (match) {
            consumedOldPanes.add(match.id);
            preservedPtyIds.add(match.ptyId!);
            newPane.ptyId = match.ptyId;
            // Upgrade launcher → claude if old pane was running
            if (newPane.type === "claude-launcher" && match.type === "claude") {
              newPane.type = "claude";
            }
          }
        }
      }
    }

    // Remove preserved PTYs from the kill set
    for (const id of preservedPtyIds) {
      oldPtyIds.delete(id);
    }

    const groupIdMap = new Map<string, string>();
    const remappedGroups: Record<string, PaneGroup> = {};
    for (const [oldGid, group] of Object.entries(cloned.groups)) {
      const newGid = crypto.randomUUID();
      groupIdMap.set(oldGid, newGid);
      const newPanes = group.panes.map((p) => ({ ...p, id: crypto.randomUUID() }));
      remappedGroups[newGid] = {
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

    const restored: WorkspaceLayout = { root: remapTree(cloned.root), groups: remappedGroups };
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
    // listeners) before mounting new ones. Kill only ORPHANED PTYs
    // (not preserved ones) after React has flushed the unmount.
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

  renameLayoutPreset: (workspaceId, presetId, newName) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    set((s) => ({
      layoutPresets: {
        ...s.layoutPresets,
        [workspaceId]: (s.layoutPresets[workspaceId] ?? []).map((p) =>
          p.id === presetId ? { ...p, name: trimmed } : p
        ),
      },
    }));
  },

  reorderLayoutPresets: (workspaceId, presetIds) => {
    set((s) => {
      const existing = s.layoutPresets[workspaceId] ?? [];
      const byId = new Map(existing.map((p) => [p.id, p]));
      const reordered = presetIds.map((id) => byId.get(id)).filter(Boolean) as typeof existing;
      return {
        layoutPresets: { ...s.layoutPresets, [workspaceId]: reordered },
      };
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

    // Reveal the file in the explorer (expand ancestors, scroll into view)
    // and ensure the explorer panel is visible — skip when opened directly from the explorer
    if (!options?.skipReveal) {
      get().revealFileInExplorer(filePath);
      document.dispatchEvent(new Event("rally-ensure-explorer-visible"));
    }
  },

  openWebView: (workspaceId, url) => {
    const layout = get().getOrCreateLayout(workspaceId);

    // Find target group (top area of layout, same as openFile)
    let targetGroupId: string | null = null;
    const root = layout.root;
    if (root.type === "split" && root.direction === "vertical") {
      targetGroupId = findFirstGroupInSubtree(root.children[0]);
    }
    if (!targetGroupId) {
      targetGroupId = findFirstGroupInSubtree(root);
    }
    if (!targetGroupId) return;

    // Dedup: if a webview with this URL is already open in the target group, focus it
    const targetGroup = layout.groups[targetGroupId];
    if (targetGroup) {
      const existing = targetGroup.panes.find(
        (p) => p.type === "webview" && p.webviewUrl === url,
      );
      if (existing) {
        get().setActivePane(workspaceId, targetGroupId, existing.id);
        return;
      }
    }

    // Derive a readable title from the URL
    let title: string;
    if (url.startsWith("http://") || url.startsWith("https://")) {
      try {
        const u = new URL(url);
        title = u.host + (u.pathname !== "/" ? u.pathname : "");
      } catch {
        title = url;
      }
    } else {
      // Local file path — use filename
      title = url.split("/").pop() ?? url;
    }

    const pane: Pane = {
      id: crypto.randomUUID(),
      type: "webview",
      title,
      webviewUrl: url,
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
    // Refresh PR status only if stale (>60s since last successful fetch)
    const lastFetch = get().prStatusFetchedAt[rootPath] ?? 0;
    if (Date.now() - lastFetch > 60_000) {
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
          [workspaceId]: { root: normalizeLayoutTree(newRoot), groups: newGroups },
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
        [workspaceId]: { root: normalizeLayoutTree(newRoot), groups: newGroups },
      },
    }));
  },

  dropFileOnGroup: (workspaceId, targetGroupId, filePaths, position) => {
    if (filePaths.length === 0) return;

    // If dropping onto a terminal/claude pane, write paths into the PTY
    // instead of opening editor tabs (matches Finder drop behavior in App.tsx)
    if (position === "center") {
      const layout = get().layouts[workspaceId];
      if (layout) {
        const group = layout.groups[targetGroupId];
        if (group) {
          const activePane = group.panes.find((p) => p.id === group.activePaneId);
          if (activePane?.ptyId && (activePane.type === "terminal" || activePane.type === "claude")) {
            const escaped = filePaths.map((p) => p.includes(" ") ? `'${p}'` : p).join(" ");
            api.writePty(activePane.ptyId, Array.from(new TextEncoder().encode(escaped)));
            return;
          }
        }
      }
    }

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
          root: normalizeLayoutTree(newRoot),
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
        workspaceModes: state.workspaceModes,
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
          workspaceModes: (p?.workspaceModes && typeof p.workspaceModes === "object") ? p.workspaceModes as Record<string, WorkspaceMode> : {},
        };
      },
    }
  )
);

// Expose store accessor globally for the test bridge (only used when RALLY_TEST_MODE=1)
(window as any).__rallyStoreAccessor = () => useWorkspaceStore.getState();

/**
 * Returns true if any Claude pane in the given workspace has an active Claude
 * process (detected via foreground process polling — title is set to "claude"
 * when Claude Code is running).
 */
export function isClaudeActiveInWorkspace(workspaceId: string | null): boolean {
  if (!workspaceId) return false;
  const state = useWorkspaceStore.getState();
  const layout = state.layouts[workspaceId];
  if (!layout) return false;
  for (const group of Object.values(layout.groups)) {
    for (const pane of group.panes) {
      if (pane.type === "claude" && pane.title === "claude") return true;
    }
  }
  return false;
}

/**
 * Normalize layout tree so column dividers are independent per row.
 * Transforms H(V(A,C), V(B,D)) → V(H(A,B), H(C,D)) recursively.
 * After normalization, row heights are controlled by a single V-split (inherently linked)
 * and column widths are separate H-splits per row (inherently independent).
 */
function normalizeLayoutTree(node: LayoutNode): LayoutNode {
  if (node.type === "group") return node;

  // Recursively normalize children first
  const c0 = normalizeLayoutTree(node.children[0]);
  const c1 = normalizeLayoutTree(node.children[1]);

  // Check for H(V, V) pattern
  if (
    node.direction === "horizontal" &&
    c0.type === "split" && c0.direction === "vertical" &&
    c1.type === "split" && c1.direction === "vertical"
  ) {
    // H(r_h, V(r_v1, A, C), V(r_v2, B, D))
    // → V(r_v1, H(r_h, A, B), H(r_h, C, D))
    return {
      type: "split",
      id: c0.id,
      direction: "vertical",
      ratio: c0.ratio,
      children: [
        {
          type: "split",
          id: node.id,
          direction: "horizontal",
          ratio: node.ratio,
          children: [c0.children[0], c1.children[0]],
        },
        {
          type: "split",
          id: c1.id,
          direction: "horizontal",
          ratio: node.ratio,
          children: [c0.children[1], c1.children[1]],
        },
      ],
    };
  }

  // No transformation needed, but children may have changed
  if (c0 !== node.children[0] || c1 !== node.children[1]) {
    return { ...node, children: [c0, c1] };
  }
  return node;
}

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

/**
 * Collect all vertical split IDs reachable from a node by walking through
 * horizontal splits. Stops at the first vertical split on each branch.
 */
function collectPeerVerticalSplits(node: LayoutNode): string[] {
  if (node.type === "group") return [];
  if (node.direction === "vertical") return [node.id];
  return [
    ...collectPeerVerticalSplits(node.children[0]),
    ...collectPeerVerticalSplits(node.children[1]),
  ];
}

/**
 * Collect all horizontal split IDs reachable from a node by walking through
 * vertical splits. Stops at the first horizontal split on each branch.
 */
function collectPeerHorizontalSplits(node: LayoutNode): string[] {
  if (node.type === "group") return [];
  if (node.direction === "horizontal") return [node.id];
  return [
    ...collectPeerHorizontalSplits(node.children[0]),
    ...collectPeerHorizontalSplits(node.children[1]),
  ];
}

/** Snap threshold — ratio difference within which column dividers snap to peer positions */
const SNAP_THRESHOLD = 0.01;

/**
 * Find peer horizontal splits and snap to their ratio if close enough.
 */
function snapToPeerRatio(
  root: LayoutNode,
  splitId: string,
  ratio: number
): number {
  // Walk up to find the nearest vertical ancestor
  let currentId = splitId;
  let ancestor: Extract<LayoutNode, { type: "split" }> | null = null;
  while (true) {
    const parentInfo = findParent(root, currentId);
    if (!parentInfo) break;
    if (parentInfo.parent.direction === "vertical") {
      ancestor = parentInfo.parent;
      break;
    }
    currentId = parentInfo.parent.id;
  }
  if (!ancestor) return ratio;

  const peerIds = collectPeerHorizontalSplits(ancestor);
  for (const peerId of peerIds) {
    if (peerId === splitId) continue;
    const peer = findSplitById(root, peerId);
    if (peer && Math.abs(ratio - peer.ratio) < SNAP_THRESHOLD) {
      return peer.ratio;
    }
  }
  return ratio;
}

/**
 * Sync peer splits so dividers stay aligned.
 * Vertical splits sync under the nearest horizontal ancestor (row dividers align across columns).
 * Horizontal splits sync under the nearest vertical ancestor (column dividers align across rows).
 */
function syncPeers(
  root: LayoutNode,
  changedSplitId: string,
  ratio: number,
  direction: "vertical" | "horizontal"
): LayoutNode {
  const oppositeDirection = direction === "vertical" ? "horizontal" : "vertical";
  const collectPeers = direction === "vertical" ? collectPeerVerticalSplits : collectPeerHorizontalSplits;

  // Walk up to find the nearest opposite-direction ancestor
  let currentId = changedSplitId;
  let ancestor: Extract<LayoutNode, { type: "split" }> | null = null;
  while (true) {
    const parentInfo = findParent(root, currentId);
    if (!parentInfo) break;
    if (parentInfo.parent.direction === oppositeDirection) {
      ancestor = parentInfo.parent;
      break;
    }
    currentId = parentInfo.parent.id;
  }
  if (!ancestor) return root;

  const peerIds = collectPeers(ancestor);

  let result = root;
  for (const peerId of peerIds) {
    if (peerId === changedSplitId) continue;
    const peer = findSplitById(result, peerId);
    if (peer) {
      result = replaceNode(result, peerId, { ...peer, ratio });
    }
  }
  return result;
}

function syncPeerVerticalSplits(
  root: LayoutNode, changedSplitId: string, ratio: number
): LayoutNode {
  return syncPeers(root, changedSplitId, ratio, "vertical");
}

function syncPeerHorizontalSplits(
  root: LayoutNode, changedSplitId: string, ratio: number
): LayoutNode {
  return syncPeers(root, changedSplitId, ratio, "horizontal");
}
