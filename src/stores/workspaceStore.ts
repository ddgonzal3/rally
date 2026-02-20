import { create } from "zustand";
import { persist } from "zustand/middleware";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
  TaskRun,
} from "../lib/types";
import {
  createDefaultLayout,
  replaceNode,
  findParent,
  findFirstGroupInSubtree,
} from "../lib/types";
import { api } from "../lib/tauri";

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
  /** Per-root-path view mode for file explorer */
  explorerViewModes: Record<string, "files" | "curated">;
  /** Active task runs keyed by "rootPath:taskName" */
  taskRuns: Record<string, TaskRun>;
  loading: boolean;

  // Workspace actions
  loadWorkspaces: () => Promise<void>;
  setActive: (id: string) => void;
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
  /** Open a diff view for a repo path */
  openDiff: (workspaceId: string, rootPath: string) => void;
  setExplorerViewMode: (rootPath: string, mode: "files" | "curated") => void;

  // Task runner actions
  runTask: (rootPath: string, taskName: string, command: string, cwd?: string) => Promise<void>;
  stopTask: (rootPath: string, taskName: string) => Promise<void>;
  clearTask: (rootPath: string, taskName: string) => void;

  /** Move a pane from one group into a new split on a target group */
  dropPaneOnGroup: (
    workspaceId: string,
    sourceGroupId: string,
    sourcePaneId: string,
    targetGroupId: string,
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
        panes: group.panes.map((p) =>
          p.type === "claude"
            ? { ...p, type: "claude-launcher" as const, command: undefined }
            : p
        ),
      };
    }
    restored[wsId] = { root: layout.root, groups };
  }
  return restored;
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
  explorerViewModes: {},
  taskRuns: {},
  loading: false,

  // --- Workspace actions ---

  loadWorkspaces: async () => {
    set({ loading: true });
    const workspaces = await api.listWorkspaces();
    set({
      workspaces,
      loading: false,
      activeWorkspaceId:
        get().activeWorkspaceId ?? workspaces[0]?.id ?? null,
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
      set((s) => ({ prStatuses: { ...s.prStatuses, [path]: prStatus } }));
    } catch {
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
    const ws = get().workspaces.find((w) => w.paths.includes(path));
    if (ws) {
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

  setExplorerViewMode: (rootPath, mode) => {
    set((s) => ({
      explorerViewModes: { ...s.explorerViewModes, [rootPath]: mode },
    }));
  },

  // --- Task runner actions ---

  runTask: async (rootPath, taskName, command, cwd?) => {
    const key = `${rootPath}:${taskName}`;

    // Kill existing run if any
    const existing = get().taskRuns[key];
    if (existing && existing.status === "running") {
      await api.killPty(existing.ptyId);
    }

    const effectiveCwd = cwd ? `${rootPath}/${cwd}` : rootPath;
    const ptyId = await api.spawnPty(effectiveCwd, command, 120, 40, true);

    set((s) => ({
      taskRuns: {
        ...s.taskRuns,
        [key]: { taskName, ptyId, status: "running", exitCode: null, output: [] },
      },
    }));

    // Buffer PTY output
    const unlistenOutput = await listen<{ data: number[] }>(
      `pty-output-${ptyId}`,
      (event) => {
        const chunk = new Uint8Array(event.payload.data);
        set((s) => {
          const run = s.taskRuns[key];
          if (!run) return s;
          return {
            taskRuns: {
              ...s.taskRuns,
              [key]: { ...run, output: [...run.output, chunk] },
            },
          };
        });
      }
    );

    // Listen for exit event to update status
    const unlistenExit = await listen<{ code: number | null }>(
      `pty-exit-${ptyId}`,
      (event) => {
        const code = event.payload.code;
        set((s) => ({
          taskRuns: {
            ...s.taskRuns,
            [key]: {
              ...s.taskRuns[key],
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

  stopTask: async (rootPath, taskName) => {
    const key = `${rootPath}:${taskName}`;
    const run = get().taskRuns[key];
    if (!run) return;
    await api.killPty(run.ptyId);
    set((s) => ({
      taskRuns: {
        ...s.taskRuns,
        [key]: { ...run, status: "stopped" },
      },
    }));
  },

  clearTask: (rootPath, taskName) => {
    const key = `${rootPath}:${taskName}`;
    set((s) => {
      const { [key]: _, ...rest } = s.taskRuns;
      return { taskRuns: rest };
    });
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

    if (group.panes.length <= 1) {
      // Last pane in group — close the whole group
      get().closeGroup(workspaceId, groupId);
      return;
    }

    // Remove the pane from the group
    const newPanes = group.panes.filter((p) => p.id !== paneId);
    const newActive =
      group.activePaneId === paneId
        ? newPanes[0].id
        : group.activePaneId;
    set((s) => ({
      layouts: {
        ...s.layouts,
        [workspaceId]: {
          ...layout,
          groups: {
            ...layout.groups,
            [groupId]: { ...group, panes: newPanes, activePaneId: newActive },
          },
        },
      },
    }));
  },

  closeGroup: (workspaceId, groupId) => {
    const layout = get().getOrCreateLayout(workspaceId);
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

  addPaneToGroup: (workspaceId, groupId, pane) => {
    const layout = get().getOrCreateLayout(workspaceId);
    const group = layout.groups[groupId];
    if (!group) return;

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

    set((s) => ({
      activeGroupIds: { ...s.activeGroupIds, [workspaceId]: groupId },
      layouts: {
        ...s.layouts,
        [workspaceId]: {
          ...layout,
          groups: {
            ...layout.groups,
            [groupId]: { ...group, activePaneId: paneId },
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

    // Dedup: if an editor pane for this file already exists, focus it
    for (const [gid, group] of Object.entries(layout.groups)) {
      const existing = group.panes.find(
        (p) => p.type === "editor" && p.filePath === filePath
      );
      if (existing) {
        get().setActivePane(workspaceId, gid, existing.id);
        return;
      }
    }

    // Find target group in the "top" area of the layout
    let targetGroupId: string | null = null;
    const root = layout.root;
    if (root.type === "split" && root.direction === "vertical") {
      // Top subtree is children[0]
      targetGroupId = findFirstGroupInSubtree(root.children[0]);
    }
    // Fallback: use the first group found anywhere
    if (!targetGroupId) {
      targetGroupId = findFirstGroupInSubtree(root);
    }
    if (!targetGroupId) return;

    const fileName = filePath.split("/").pop() ?? filePath;
    const pane: Pane = {
      id: crypto.randomUUID(),
      type: "editor",
      title: fileName,
      filePath,
    };
    get().addPaneToGroup(workspaceId, targetGroupId, pane);
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
    }),
    {
      name: "playbench-state",
      partialize: (state) => ({
        activeWorkspaceId: state.activeWorkspaceId,
        activePathIndex: state.activePathIndex,
        layouts: state.layouts,
        activeGroupIds: state.activeGroupIds,
        explorerViewModes: state.explorerViewModes,
      }),
      merge: (persisted, current) => {
        const p = persisted as Partial<WorkspaceState> | undefined;
        return {
          ...current,
          activeWorkspaceId: p?.activeWorkspaceId ?? current.activeWorkspaceId,
          layouts: restoreLayouts(p?.layouts ?? {}),
          activeGroupIds: p?.activeGroupIds ?? current.activeGroupIds,
          explorerViewModes: p?.explorerViewModes ?? current.explorerViewModes,
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
