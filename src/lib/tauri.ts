import { invoke } from "@tauri-apps/api/core";
import type { Workspace, GitStatus, PrStatus, PrDetails, PushResult, ChangesSummary, CommitEntry, ScriptEntry, ShipSignal, RallyScriptInfo, SearchMatch, ReplaceOp, ReplaceResult, PtyInfo, RallyConfig, WorkspaceReadiness, BranchInfo } from "./types";

/** Open a URL in the user's default browser via Tauri shell plugin. */
export function openUrl(url: string) {
  if (!/^https?:\/\//i.test(url)) return;
  invoke("plugin:shell|open", { path: url }).catch((err) => {
    console.warn("shell:open failed, falling back to window.open:", err);
    try {
      window.open(url, "_blank");
    } catch (e) {
      console.error("window.open also failed:", e);
    }
  });
}

export const api = {
  listWorkspaces: () => invoke<Workspace[]>("list_workspaces"),

  updateGitWatchRoots: (roots: string[]) =>
    invoke<void>("update_git_watch_roots", { roots }),

  createWorkspace: (params: {
    name: string;
    paths: string[];
  }) => invoke<Workspace>("create_workspace", params),

  removeWorkspace: (id: string) => invoke<void>("remove_workspace", { id }),

  reorderWorkspace: (id: string, toIndex: number) =>
    invoke<void>("reorder_workspace", { id, toIndex }),

  renameWorkspace: (id: string, name: string) =>
    invoke<void>("rename_workspace", { id, name }),

  addWorkspacePath: (id: string, path: string) =>
    invoke<Workspace>("add_workspace_path", { id, path }),

  removeWorkspacePath: (id: string, path: string) =>
    invoke<Workspace>("remove_workspace_path", { id, path }),

  setWorkspacePaths: (id: string, paths: string[]) =>
    invoke<Workspace>("set_workspace_paths", { id, paths }),

  reorderWorkspacePath: (workspaceId: string, path: string, toIndex: number) =>
    invoke<Workspace>("reorder_workspace_path", { workspaceId, path, toIndex }),

  cloneRepo: (sourcePath: string, name: string) =>
    invoke<string>("clone_repo", { sourcePath, name }),

  gitStatus: (workspacePath: string, mainBranch: string) =>
    invoke<GitStatus>("git_status", { workspacePath, mainBranch }),

  gitPrStatus: (workspacePath: string) =>
    invoke<PrStatus>("git_pr_status", { workspacePath }),

  gitPrDetails: (workspacePath: string) =>
    invoke<PrDetails>("git_pr_details", { workspacePath }),

  gitPrDiff: (workspacePath: string) =>
    invoke<string>("git_pr_diff", { workspacePath }),

  gitEditPrTitle: (workspacePath: string, title: string) =>
    invoke<void>("git_edit_pr_title", { workspacePath, title }),

  gitClosePr: (workspacePath: string) =>
    invoke<string>("git_close_pr", { workspacePath }),

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

  gitDiff: (workspacePath: string, staged: boolean) =>
    invoke<string>("git_diff", { workspacePath, staged }),

  gitApplyPatch: (workspacePath: string, patch: string, reverse: boolean, cached: boolean) =>
    invoke<string>("git_apply_patch", { workspacePath, patch, reverse, cached }),

  gitCommitStaged: (workspacePath: string, message: string) =>
    invoke<string>("git_commit_staged", { workspacePath, message }),

  gitPush: (workspacePath: string) =>
    invoke<PushResult>("git_push", { workspacePath }),

  gitCreatePr: (workspacePath: string) =>
    invoke<string>("git_create_pr", { workspacePath }),

  gitCommitLog: (workspacePath: string, mainBranch: string, limit: number = 50) =>
    invoke<CommitEntry[]>("git_commit_log", { workspacePath, mainBranch, limit }),

  gitCommitDiff: (workspacePath: string, sha: string) =>
    invoke<string>("git_commit_diff", { workspacePath, sha }),

  gitDiffStat: (workspacePath: string) =>
    invoke<[number, number]>("git_diff_stat", { workspacePath }),

  gitFetch: (workspacePath: string) =>
    invoke<void>("git_fetch", { workspacePath }),

  gitPull: (workspacePath: string) =>
    invoke<string>("git_pull", { workspacePath }),

  gitForcePull: (workspacePath: string) =>
    invoke<string>("git_force_pull", { workspacePath }),

  gitRebaseOnMain: (workspacePath: string, mainBranch: string) =>
    invoke<string>("git_rebase_on_main", { workspacePath, mainBranch }),

  gitListBranches: (workspacePath: string) =>
    invoke<BranchInfo[]>("git_list_branches", { workspacePath }),

  gitCheckoutBranch: (workspacePath: string, branch: string) =>
    invoke<string>("git_checkout_branch", { workspacePath, branch }),

  gitCreateBranch: (workspacePath: string, branch: string) =>
    invoke<string>("git_create_branch", { workspacePath, branch }),

  gitDeleteBranch: (workspacePath: string, branch: string, force: boolean = false) =>
    invoke<string>("git_delete_branch", { workspacePath, branch, force }),

  detectGitInfo: (path: string) =>
    invoke<{ repo_url: string; branch: string; name: string }>("detect_git_info", { path }),

  fileExists: (path: string) =>
    invoke<boolean>("file_exists", { path }),

  revealInFinder: (path: string) =>
    invoke<void>("reveal_in_finder", { path }),

  trashFile: (path: string) =>
    invoke<void>("trash_file", { path }),

  renameFile: (oldPath: string, newPath: string) =>
    invoke<void>("rename_file", { oldPath, newPath }),

  listGitignored: (dirPath: string) =>
    invoke<string[]>("list_gitignored", { dirPath }),

  listScripts: (rootPath: string) =>
    invoke<ScriptEntry[]>("list_scripts", { rootPath }),

  readClipboardText: () =>
    invoke<string>("read_clipboard_text"),

  saveClipboardImage: (data: string, mimeType: string) =>
    invoke<string>("save_clipboard_image", { data, mimeType }),

  readFileContent: (path: string) =>
    invoke<string>("read_file_content", { path }),

  writeFileContent: (path: string, content: string) =>
    invoke<void>("write_file_content", { path, content }),

  createDirectory: (path: string) =>
    invoke<void>("create_directory", { path }),

  pathStatus: (path: string) =>
    invoke<{ exists: boolean; is_dir: boolean }>("path_status", { path }),

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

  listPtys: () =>
    invoke<PtyInfo[]>("list_ptys"),

  killAllPtys: () =>
    invoke<void>("kill_all_ptys"),

  getPtyForegroundProcess: (ptyId: string) =>
    invoke<string | null>("get_pty_foreground_process", { ptyId }),

  // Rally script editor
  listRallyScripts: () =>
    invoke<RallyScriptInfo[]>("list_rally_scripts"),

  restoreRallyScript: (name: string) =>
    invoke<void>("restore_rally_script", { name }),

  // Search operations
  searchInFiles: (paths: string[], query: string, caseSensitive: boolean, wholeWord: boolean, useRegex: boolean) =>
    invoke<SearchMatch[]>("search_in_files", { paths, query, caseSensitive, wholeWord, useRegex }),

  replaceInFiles: (replacements: ReplaceOp[]) =>
    invoke<ReplaceResult>("replace_in_files", { replacements }),

  listAllFiles: (paths: string[]) =>
    invoke<string[]>("list_all_files", { paths }),

  // Rally config
  readRallyConfig: (rootPath: string) =>
    invoke<RallyConfig>("read_rally_config", { rootPath }),

  // Workspace readiness
  checkWorkspaceReady: (rootPath: string) =>
    invoke<WorkspaceReadiness>("check_workspace_ready", { rootPath }),

};
