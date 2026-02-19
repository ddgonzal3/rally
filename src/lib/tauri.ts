import { invoke } from "@tauri-apps/api/core";
import type { Workspace, GitStatus } from "./types";

export const api = {
  listWorkspaces: () => invoke<Workspace[]>("list_workspaces"),

  createWorkspace: (params: {
    name: string;
    path: string;
    repoUrl: string;
    branch: string;
    mainBranch?: string;
  }) => invoke<Workspace>("create_workspace", params),

  removeWorkspace: (id: string) => invoke<void>("remove_workspace", { id }),

  gitStatus: (workspacePath: string) =>
    invoke<GitStatus>("git_status", { workspacePath }),

  gitSync: (workspacePath: string, branch: string, mainBranch: string) =>
    invoke<string>("git_sync", { workspacePath, branch, mainBranch }),

  gitRebase: (workspacePath: string, branch: string, mainBranch: string) =>
    invoke<string>("git_rebase", { workspacePath, branch, mainBranch }),

  gitCommit: (workspacePath: string, message: string) =>
    invoke<string>("git_commit", { workspacePath, message }),

  gitPush: (workspacePath: string) =>
    invoke<string>("git_push", { workspacePath }),

  gitCreatePr: (workspacePath: string, title?: string, body?: string) =>
    invoke<string>("git_create_pr", { workspacePath, title, body }),

  detectGitInfo: (path: string) =>
    invoke<{ repo_url: string; branch: string; name: string }>("detect_git_info", { path }),

  // PTY operations
  spawnPty: (cwd: string, command: string | null, cols: number, rows: number) =>
    invoke<string>("spawn_pty", { cwd, command, cols, rows }),

  writePty: (ptyId: string, data: number[]) =>
    invoke<void>("write_pty", { ptyId, data }),

  resizePty: (ptyId: string, cols: number, rows: number) =>
    invoke<void>("resize_pty", { ptyId, cols, rows }),

  killPty: (ptyId: string) =>
    invoke<void>("kill_pty", { ptyId }),
};
