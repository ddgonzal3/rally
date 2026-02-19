import { create } from "zustand";
import type {
  Workspace,
  GitStatus,
  Pane,
  WorkspaceLayout,
  LayoutNode,
  SplitDirection,
  PaneGroup,
} from "../lib/types";
import {
  createDefaultLayout,
  replaceNode,
  findParent,
} from "../lib/types";
import { api } from "../lib/tauri";

interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  gitStatuses: Record<string, GitStatus>;
  layouts: Record<string, WorkspaceLayout>;
  loading: boolean;

  // Workspace actions
  loadWorkspaces: () => Promise<void>;
  setActive: (id: string) => void;
  addWorkspace: (params: {
    name: string;
    path: string;
    repoUrl: string;
    branch: string;
    mainBranch?: string;
  }) => Promise<void>;
  removeWorkspace: (id: string) => Promise<void>;

  // Git actions
  refreshGitStatus: (workspaceId: string) => Promise<void>;
  refreshAllGitStatuses: () => Promise<void>;
  syncWorkspace: (id: string) => Promise<string>;
  rebaseWorkspace: (id: string) => Promise<string>;
  commitWorkspace: (id: string, message: string) => Promise<string>;
  pushWorkspace: (id: string) => Promise<string>;
  createPr: (id: string, title?: string, body?: string) => Promise<string>;

  // Layout actions
  getOrCreateLayout: (workspaceId: string) => WorkspaceLayout;
  splitGroup: (
    workspaceId: string,
    groupId: string,
    direction: SplitDirection
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
  /** Move a pane from one group into a new split on a target group */
  dropPaneOnGroup: (
    workspaceId: string,
    sourceGroupId: string,
    sourcePaneId: string,
    targetGroupId: string,
    position: "top" | "bottom" | "left" | "right" | "center"
  ) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  gitStatuses: {},
  layouts: {},
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

  addWorkspace: async (params) => {
    await api.createWorkspace(params);
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

  // --- Git actions ---

  refreshGitStatus: async (workspaceId) => {
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    try {
      const status = await api.gitStatus(ws.path);
      set((s) => ({
        gitStatuses: { ...s.gitStatuses, [workspaceId]: status },
      }));
    } catch (e) {
      console.error(`Failed to get git status for ${ws.name}:`, e);
    }
  },

  refreshAllGitStatuses: async () => {
    const workspaces = get().workspaces;
    await Promise.all(workspaces.map((w) => get().refreshGitStatus(w.id)));
  },

  syncWorkspace: async (id) => {
    const ws = get().workspaces.find((w) => w.id === id);
    if (!ws) throw new Error("Workspace not found");
    const result = await api.gitSync(ws.path, ws.branch, ws.main_branch);
    await get().refreshGitStatus(id);
    return result;
  },

  rebaseWorkspace: async (id) => {
    const ws = get().workspaces.find((w) => w.id === id);
    if (!ws) throw new Error("Workspace not found");
    const result = await api.gitRebase(ws.path, ws.branch, ws.main_branch);
    await get().refreshGitStatus(id);
    return result;
  },

  commitWorkspace: async (id, message) => {
    const ws = get().workspaces.find((w) => w.id === id);
    if (!ws) throw new Error("Workspace not found");
    const result = await api.gitCommit(ws.path, message);
    await get().refreshGitStatus(id);
    return result;
  },

  pushWorkspace: async (id) => {
    const ws = get().workspaces.find((w) => w.id === id);
    if (!ws) throw new Error("Workspace not found");
    const result = await api.gitPush(ws.path);
    await get().refreshGitStatus(id);
    return result;
  },

  createPr: async (id, title, body) => {
    const ws = get().workspaces.find((w) => w.id === id);
    if (!ws) throw new Error("Workspace not found");
    return api.gitCreatePr(ws.path, title, body);
  },

  // --- Layout actions ---

  getOrCreateLayout: (workspaceId) => {
    const existing = get().layouts[workspaceId];
    if (existing) return existing;
    const layout = createDefaultLayout();
    set((s) => ({
      layouts: { ...s.layouts, [workspaceId]: layout },
    }));
    return layout;
  },

  splitGroup: (workspaceId, groupId, direction) => {
    const layout = get().getOrCreateLayout(workspaceId);
    // Create a new group with a terminal pane
    const newPane: Pane = {
      id: crypto.randomUUID(),
      type: "terminal",
      title: "Terminal",
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
}));

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
