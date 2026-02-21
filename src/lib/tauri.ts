import { invoke } from "@tauri-apps/api/core";
import type { Workspace, GitStatus, PushResult, PrStatus, ChangesSummary, ScriptEntry, ShipSignal } from "./types";

export const api = {
  listWorkspaces: () => invoke<Workspace[]>("list_workspaces"),

  updateGitWatchRoots: (roots: string[]) =>
    invoke<void>("update_git_watch_roots", { roots }),

  createWorkspace: (params: {
    name: string;
    paths: string[];
  }) => invoke<Workspace>("create_workspace", params),

  removeWorkspace: (id: string) => invoke<void>("remove_workspace", { id }),

  addWorkspacePath: (id: string, path: string) =>
    invoke<Workspace>("add_workspace_path", { id, path }),

  removeWorkspacePath: (id: string, path: string) =>
    invoke<Workspace>("remove_workspace_path", { id, path }),

  gitStatus: (workspacePath: string, mainBranch: string) =>
    invoke<GitStatus>("git_status", { workspacePath, mainBranch }),

  gitSync: (workspacePath: string, branch: string, mainBranch: string) =>
    invoke<string>("git_sync", { workspacePath, branch, mainBranch }),

  gitRebase: (workspacePath: string, branch: string, mainBranch: string) =>
    invoke<string>("git_rebase", { workspacePath, branch, mainBranch }),

  gitCommit: (workspacePath: string, message: string) =>
    invoke<string>("git_commit", { workspacePath, message }),

  gitPush: (workspacePath: string) =>
    invoke<PushResult>("git_push", { workspacePath }),

  gitCreatePr: (workspacePath: string, title?: string, body?: string) =>
    invoke<string>("git_create_pr", { workspacePath, title, body }),

  gitPrStatus: (workspacePath: string) =>
    invoke<PrStatus>("git_pr_status", { workspacePath }),

  gitMergePr: (workspacePath: string, method: string) =>
    invoke<string>("git_merge_pr", { workspacePath, method }),

  gitChanges: (workspacePath: string) =>
    invoke<ChangesSummary>("git_changes", { workspacePath }),

  gitFileAtHead: (workspacePath: string, filePath: string) =>
    invoke<string>("git_file_at_head", { workspacePath, filePath }),

  gitStageFile: (workspacePath: string, filePath: string) =>
    invoke<void>("git_stage_file", { workspacePath, filePath }),

  gitUnstageFile: (workspacePath: string, filePath: string) =>
    invoke<void>("git_unstage_file", { workspacePath, filePath }),

  gitDiscardFile: (workspacePath: string, filePath: string, isUntracked: boolean) =>
    invoke<void>("git_discard_file", { workspacePath, filePath, isUntracked }),

  detectGitInfo: (path: string) =>
    invoke<{ repo_url: string; branch: string; name: string }>("detect_git_info", { path }),

  revealInFinder: (path: string) =>
    invoke<void>("reveal_in_finder", { path }),

  trashFile: (path: string) =>
    invoke<void>("trash_file", { path }),

  listScripts: (rootPath: string) =>
    invoke<ScriptEntry[]>("list_scripts", { rootPath }),

  readFileContent: (path: string) =>
    invoke<string>("read_file_content", { path }),

  // Ship operations
  checkShipSignal: (repoPath: string) =>
    invoke<ShipSignal | null>("check_ship_signal", { repoPath }),

  clearShipSignal: (repoPath: string) =>
    invoke<void>("clear_ship_signal", { repoPath }),

  checkShipTrigger: () =>
    invoke<string | null>("check_ship_trigger"),

  postMergeSync: (cwd: string, mainBranch: string, mergedBranch: string) =>
    invoke<string>("post_merge_sync", { cwd, mainBranch, mergedBranch }),

  // PTY operations
  spawnPty: (cwd: string, command: string | null, cols: number, rows: number, exitOnComplete?: boolean) =>
    invoke<string>("spawn_pty", { cwd, command, cols, rows, exitOnComplete }),

  writePty: (ptyId: string, data: number[]) =>
    invoke<void>("write_pty", { ptyId, data }),

  resizePty: (ptyId: string, cols: number, rows: number) =>
    invoke<void>("resize_pty", { ptyId, cols, rows }),

  killPty: (ptyId: string) =>
    invoke<void>("kill_pty", { ptyId }),
};
