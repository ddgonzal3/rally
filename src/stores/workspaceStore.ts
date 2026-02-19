import { create } from "zustand";
import type { Workspace, GitStatus, Pane } from "../lib/types";
import { createDefaultPanes } from "../lib/types";
import { api } from "../lib/tauri";

interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  gitStatuses: Record<string, GitStatus>;
  panes: Record<string, Pane[]>; // workspaceId -> panes
  loading: boolean;

  // Actions
  loadWorkspaces: () => Promise<void>;
  setActive: (id: string) => void;
  addWorkspace: (params: {
    name: string;
    path: string;
    repo_url: string;
    branch: string;
    main_branch?: string;
  }) => Promise<void>;
  removeWorkspace: (id: string) => Promise<void>;
  refreshGitStatus: (workspaceId: string) => Promise<void>;
  refreshAllGitStatuses: () => Promise<void>;

  // Pane operations
  addPane: (workspaceId: string, pane: Pane) => void;
  removePane: (workspaceId: string, paneId: string) => void;
  getPanes: (workspaceId: string) => Pane[];

  // Git operations
  syncWorkspace: (id: string) => Promise<string>;
  rebaseWorkspace: (id: string) => Promise<string>;
  commitWorkspace: (id: string, message: string) => Promise<string>;
  pushWorkspace: (id: string) => Promise<string>;
  createPr: (id: string, title?: string, body?: string) => Promise<string>;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  gitStatuses: {},
  panes: {},
  loading: false,

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
    set({
      workspaces: remaining,
      activeWorkspaceId:
        get().activeWorkspaceId === id
          ? remaining[0]?.id ?? null
          : get().activeWorkspaceId,
    });
  },

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

  addPane: (workspaceId, pane) => {
    set((s) => ({
      panes: {
        ...s.panes,
        [workspaceId]: [...(s.panes[workspaceId] ?? []), pane],
      },
    }));
  },

  removePane: (workspaceId, paneId) => {
    set((s) => ({
      panes: {
        ...s.panes,
        [workspaceId]: (s.panes[workspaceId] ?? []).filter(
          (p) => p.id !== paneId
        ),
      },
    }));
  },

  getPanes: (workspaceId) => {
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    const existing = get().panes[workspaceId];
    if (existing && existing.length > 0) return existing;
    // Initialize default panes if none exist
    if (ws) {
      const defaults = createDefaultPanes(ws.name);
      // Avoid setting state during render — just return defaults
      return defaults;
    }
    return [];
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
}));
