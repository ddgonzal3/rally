use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::process::Command;
use tauri::Emitter;

use base64::Engine;
use crate::git_ops;
use crate::git_watch::GitWatchState;
use crate::workspace::{self, ChangesSummary, CommitEntry, GitStatus, PrDetails, PrStatus, PushResult, Workspace};

fn emit_workspaces_updated(app: &tauri::AppHandle) {
    if let Err(e) = app.emit("rally-workspaces-updated", ()) {
        eprintln!("Failed to emit rally-workspaces-updated: {}", e);
    }
}

#[derive(Debug, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

const HIDDEN_DIRS: &[&str] = &["node_modules", ".git", ".angular", "dist", "target", ".nx", ".cache", "__pycache__"];

#[tauri::command]
pub fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let mut entries: Vec<FileEntry> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);

            // Skip hidden/large dirs
            if is_dir && HIDDEN_DIRS.contains(&name.as_str()) {
                return None;
            }

            Some(FileEntry {
                name,
                path: entry.path().to_string_lossy().to_string(),
                is_dir,
            })
        })
        .collect();

    // Sort: directories first, then alphabetical
    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// Get list of git-ignored file/directory names within a directory.
/// Uses `git check-ignore` to check each entry against .gitignore rules.
#[tauri::command]
pub fn list_gitignored(dir_path: String) -> Result<Vec<String>, String> {
    // Read directory entries
    let entries: Vec<String> = fs::read_dir(&dir_path)
        .map_err(|e| format!("Failed to read directory: {}", e))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();

    if entries.is_empty() {
        return Ok(Vec::new());
    }

    // Build list of full paths to check
    let paths: Vec<String> = entries.iter()
        .map(|name| format!("{}/{}", dir_path, name))
        .collect();

    // Run git check-ignore with all paths at once
    let mut cmd = Command::new("git");
    cmd.args(["check-ignore"])
        .args(&paths)
        .current_dir(&dir_path);

    let output = cmd.output();

    match output {
        Ok(out) => {
            // git check-ignore prints one ignored path per line.
            // Exit code 1 means no files are ignored (not an error).
            let stdout = String::from_utf8_lossy(&out.stdout);
            let ignored: Vec<String> = stdout.lines()
                .filter_map(|line| {
                    let trimmed = line.trim();
                    if trimmed.is_empty() { return None; }
                    // Extract just the filename from the full path
                    Path::new(trimmed)
                        .file_name()
                        .map(|f| f.to_string_lossy().to_string())
                })
                .collect();
            Ok(ignored)
        }
        Err(_) => {
            // git not available or not a git repo — no ignored files
            Ok(Vec::new())
        }
    }
}

#[derive(Debug, Serialize)]
pub struct GitRepoInfo {
    pub repo_url: String,
    pub branch: String,
    pub name: String,
}

/// Detect git info from an existing repo directory
#[tauri::command]
pub async fn detect_git_info(path: String) -> Result<GitRepoInfo, String> {
    let repo_url = git_ops::git_cmd(&path, &["remote", "get-url", "origin"]).await
        .unwrap_or_default();
    let branch = git_ops::git_cmd(&path, &["symbolic-ref", "--short", "HEAD"]).await
        .unwrap_or_else(|_| "main".to_string());
    let name = Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "workspace".to_string());

    Ok(GitRepoInfo { repo_url, branch, name })
}

#[tauri::command]
pub fn list_workspaces() -> Vec<Workspace> {
    workspace::load_workspaces()
}

#[tauri::command]
pub fn update_git_watch_roots(
    app: tauri::AppHandle,
    watch_state: tauri::State<'_, GitWatchState>,
    roots: Vec<String>,
) -> Result<(), String> {
    watch_state.update_roots(app, roots)
}

#[tauri::command]
pub async fn create_workspace(
    app: tauri::AppHandle,
    name: String,
    paths: Vec<String>,
) -> Result<Workspace, String> {
    if paths.is_empty() {
        return Err("At least one path is required".to_string());
    }
    let mut workspaces = workspace::load_workspaces();

    // Auto-detect git info from the primary path
    let primary = &paths[0];
    let repo_url = git_ops::git_cmd(primary, &["remote", "get-url", "origin"]).await
        .unwrap_or_default();
    let branch = git_ops::git_cmd(primary, &["rev-parse", "--abbrev-ref", "HEAD"]).await
        .unwrap_or_else(|_| "main".to_string());

    let ws = Workspace {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        paths,
        repo_url,
        branch,
        main_branch: "main".to_string(),
        processes: vec![],
    };

    workspaces.push(ws.clone());
    workspace::save_workspaces(&workspaces)?;
    emit_workspaces_updated(&app);
    Ok(ws)
}

#[tauri::command]
pub fn remove_workspace(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut workspaces = workspace::load_workspaces();
    workspaces.retain(|w| w.id != id);
    workspace::save_workspaces(&workspaces)?;
    emit_workspaces_updated(&app);
    Ok(())
}

#[tauri::command]
pub fn reorder_workspace(
    app: tauri::AppHandle,
    id: String,
    to_index: usize,
) -> Result<(), String> {
    let mut workspaces = workspace::load_workspaces();
    if workspaces.len() <= 1 {
        return Ok(());
    }

    let from_index = workspaces
        .iter()
        .position(|w| w.id == id)
        .ok_or_else(|| format!("Workspace not found: {}", id))?;

    let target = to_index.min(workspaces.len() - 1);
    if from_index == target {
        return Ok(());
    }

    let workspace = workspaces.remove(from_index);
    workspaces.insert(target, workspace);

    workspace::save_workspaces(&workspaces)?;
    emit_workspaces_updated(&app);
    Ok(())
}

#[tauri::command]
pub fn rename_workspace(app: tauri::AppHandle, id: String, name: String) -> Result<(), String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("Workspace name cannot be empty".to_string());
    }
    let mut workspaces = workspace::load_workspaces();
    let ws = workspaces
        .iter_mut()
        .find(|w| w.id == id)
        .ok_or_else(|| format!("Workspace not found: {}", id))?;
    ws.name = trimmed;
    workspace::save_workspaces(&workspaces)?;
    emit_workspaces_updated(&app);
    Ok(())
}

#[tauri::command]
pub fn add_workspace_path(
    app: tauri::AppHandle,
    id: String,
    path: String,
) -> Result<Workspace, String> {
    let mut workspaces = workspace::load_workspaces();
    let ws = workspaces
        .iter_mut()
        .find(|w| w.id == id)
        .ok_or_else(|| format!("Workspace not found: {}", id))?;

    if !ws.paths.contains(&path) {
        ws.paths.push(path);
    }

    let result = ws.clone();
    workspace::save_workspaces(&workspaces)?;
    emit_workspaces_updated(&app);
    Ok(result)
}

#[tauri::command]
pub fn remove_workspace_path(
    app: tauri::AppHandle,
    id: String,
    path: String,
) -> Result<Workspace, String> {
    let mut workspaces = workspace::load_workspaces();
    let ws = workspaces
        .iter_mut()
        .find(|w| w.id == id)
        .ok_or_else(|| format!("Workspace not found: {}", id))?;

    ws.paths.retain(|p| p != &path);
    let result = ws.clone();
    workspace::save_workspaces(&workspaces)?;
    emit_workspaces_updated(&app);
    Ok(result)
}

#[tauri::command]
pub fn set_workspace_paths(
    app: tauri::AppHandle,
    id: String,
    paths: Vec<String>,
) -> Result<Workspace, String> {
    let mut workspaces = workspace::load_workspaces();
    let ws = workspaces
        .iter_mut()
        .find(|w| w.id == id)
        .ok_or_else(|| format!("Workspace not found: {}", id))?;

    ws.paths = paths;
    let result = ws.clone();
    workspace::save_workspaces(&workspaces)?;
    emit_workspaces_updated(&app);
    Ok(result)
}

#[tauri::command]
pub fn reorder_workspace_path(
    app: tauri::AppHandle,
    workspace_id: String,
    path: String,
    to_index: usize,
) -> Result<Workspace, String> {
    let mut workspaces = workspace::load_workspaces();
    let ws = workspaces
        .iter_mut()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| format!("Workspace not found: {}", workspace_id))?;

    if ws.paths.len() <= 1 {
        return Ok(ws.clone());
    }

    let from_index = ws
        .paths
        .iter()
        .position(|p| p == &path)
        .ok_or_else(|| format!("Path not found in workspace: {}", path))?;
    let target = to_index.min(ws.paths.len() - 1);
    if from_index == target {
        return Ok(ws.clone());
    }

    let moved = ws.paths.remove(from_index);
    ws.paths.insert(target, moved);
    let result = ws.clone();

    workspace::save_workspaces(&workspaces)?;
    emit_workspaces_updated(&app);
    Ok(result)
}

#[tauri::command]
pub async fn clone_repo(source_path: String, name: String) -> Result<String, String> {
    let source = std::path::Path::new(&source_path);
    let parent = source.parent().ok_or("Cannot determine parent directory")?;
    let target = parent.join(&name);

    if target.exists() {
        return Err(format!("Directory already exists: {}", target.display()));
    }

    let target_str = target.to_string_lossy().to_string();

    // Get the original remote URL before cloning
    let remote_url = crate::git_ops::git_cmd(&source_path, &["remote", "get-url", "origin"])
        .await
        .unwrap_or_default();

    // Clone from local source (fast, no network)
    crate::git_ops::git_cmd(
        &parent.to_string_lossy(),
        &["clone", &source_path, &name],
    )
    .await?;

    // Point remote at the real upstream (not the local sibling)
    if !remote_url.is_empty() {
        crate::git_ops::git_cmd(&target_str, &["remote", "set-url", "origin", &remote_url])
            .await?;
        // Update origin/HEAD to match the remote's default branch
        // (local clone inherits the source repo's HEAD, not GitHub's default)
        let _ = crate::git_ops::git_cmd(&target_str, &["remote", "set-head", "origin", "--auto"])
            .await;
    }

    Ok(target_str)
}

#[tauri::command]
pub async fn git_status(workspace_path: String, main_branch: String) -> Result<GitStatus, String> {
    git_ops::status(&workspace_path, &main_branch).await
}

/// Lightweight branch-name lookup. Runs only `git symbolic-ref --short HEAD`
/// so it's viable to call on a poll without the expense of a full status scan.
/// Used by minimal git mode to keep Claude panels showing the current branch
/// without running `git status --porcelain` on large repos.
#[tauri::command]
pub async fn git_branch(workspace_path: String) -> Result<String, String> {
    git_ops::current_branch(&workspace_path).await
}

#[tauri::command]
pub async fn git_pr_status(workspace_path: String) -> Result<PrStatus, String> {
    git_ops::pr_status(&workspace_path).await
}

#[tauri::command]
pub async fn git_pr_details(workspace_path: String) -> Result<PrDetails, String> {
    git_ops::pr_details(&workspace_path).await
}

#[tauri::command]
pub async fn git_pr_diff(workspace_path: String) -> Result<String, String> {
    git_ops::pr_diff(&workspace_path).await
}

#[tauri::command]
pub async fn git_edit_pr_title(workspace_path: String, title: String) -> Result<(), String> {
    git_ops::edit_pr_title(&workspace_path, &title).await
}

#[tauri::command]
pub async fn git_close_pr(workspace_path: String) -> Result<String, String> {
    git_ops::close_pr(&workspace_path).await
}

#[tauri::command]
pub async fn git_merge_pr(workspace_path: String, method: String) -> Result<String, String> {
    git_ops::merge_pr(&workspace_path, &method).await
}

#[tauri::command]
pub async fn git_changes(workspace_path: String) -> Result<ChangesSummary, String> {
    git_ops::changes(&workspace_path).await
}

#[tauri::command]
pub async fn git_file_at_head(workspace_path: String, file_path: String) -> Result<String, String> {
    git_ops::file_at_head(&workspace_path, &file_path).await
}

#[tauri::command]
pub async fn git_stage_file(workspace_path: String, file_path: String) -> Result<(), String> {
    git_ops::stage_file(&workspace_path, &file_path).await
}

#[tauri::command]
pub async fn git_unstage_file(workspace_path: String, file_path: String) -> Result<(), String> {
    git_ops::unstage_file(&workspace_path, &file_path).await
}

#[tauri::command]
pub async fn git_discard_file(
    workspace_path: String,
    file_path: String,
    is_untracked: bool,
) -> Result<(), String> {
    git_ops::discard_file(&workspace_path, &file_path, is_untracked).await
}

#[tauri::command]
pub async fn git_diff(workspace_path: String, staged: bool) -> Result<String, String> {
    git_ops::diff(&workspace_path, staged).await
}

#[tauri::command]
pub async fn git_apply_patch(workspace_path: String, patch: String, reverse: bool, cached: bool) -> Result<String, String> {
    git_ops::apply_patch(&workspace_path, &patch, reverse, cached).await
}

#[tauri::command]
pub async fn git_commit_staged(workspace_path: String, message: String) -> Result<String, String> {
    git_ops::commit_staged(&workspace_path, &message).await
}

#[tauri::command]
pub async fn git_push(workspace_path: String) -> Result<PushResult, String> {
    git_ops::push(&workspace_path).await
}

#[tauri::command]
pub async fn git_create_pr(workspace_path: String) -> Result<String, String> {
    git_ops::create_pr(&workspace_path, None, None).await
}

#[tauri::command]
pub async fn git_commit_log(workspace_path: String, main_branch: String, limit: u32) -> Result<Vec<CommitEntry>, String> {
    git_ops::commit_log(&workspace_path, &main_branch, limit).await
}

#[tauri::command]
pub async fn git_commit_diff(workspace_path: String, sha: String) -> Result<String, String> {
    git_ops::commit_diff(&workspace_path, &sha).await
}

#[tauri::command]
pub async fn git_diff_stat(workspace_path: String) -> Result<(i64, i64), String> {
    git_ops::diff_stat(&workspace_path).await
}

#[tauri::command]
pub async fn git_fetch(workspace_path: String) -> Result<(), String> {
    git_ops::fetch(&workspace_path).await
}

#[tauri::command]
pub async fn git_pull(workspace_path: String) -> Result<String, String> {
    git_ops::pull(&workspace_path).await
}

#[tauri::command]
pub async fn git_force_pull(workspace_path: String) -> Result<String, String> {
    git_ops::force_pull(&workspace_path).await
}

#[tauri::command]
pub async fn git_rebase_on_main(workspace_path: String, main_branch: String) -> Result<String, String> {
    git_ops::rebase_on_main(&workspace_path, &main_branch).await
}

#[tauri::command]
pub async fn git_sync(workspace_path: String, main_branch: String) -> Result<String, String> {
    git_ops::sync_branch(&workspace_path, &main_branch).await
}

#[tauri::command]
pub async fn git_stash(workspace_path: String) -> Result<String, String> {
    git_ops::stash(&workspace_path).await
}

#[tauri::command]
pub async fn git_stash_pop(workspace_path: String) -> Result<String, String> {
    git_ops::stash_pop(&workspace_path).await
}

#[tauri::command]
pub async fn git_stash_count(workspace_path: String) -> Result<u32, String> {
    git_ops::stash_count(&workspace_path).await
}

#[tauri::command]
pub async fn git_list_branches(workspace_path: String) -> Result<Vec<git_ops::BranchInfo>, String> {
    git_ops::list_branches(&workspace_path).await
}

#[tauri::command]
pub async fn git_checkout_branch(workspace_path: String, branch: String) -> Result<String, String> {
    git_ops::checkout_branch(&workspace_path, &branch).await
}

#[tauri::command]
pub async fn git_create_branch(workspace_path: String, branch: String) -> Result<String, String> {
    git_ops::create_branch(&workspace_path, &branch).await
}

#[tauri::command]
pub async fn git_delete_branch(workspace_path: String, branch: String, force: bool) -> Result<String, String> {
    git_ops::delete_branch(&workspace_path, &branch, force).await
}

#[tauri::command]
pub fn trash_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    trash::delete(&path).map_err(|e| format!("Failed to move to trash: {}", e))
}

#[tauri::command]
pub fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    let p = Path::new(&old_path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", old_path));
    }
    if Path::new(&new_path).exists() {
        return Err(format!("Already exists: {}", new_path));
    }
    fs::rename(&old_path, &new_path).map_err(|e| format!("Failed to rename: {}", e))
}

#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        Command::new("open").arg(&path).spawn().map_err(|e| e.to_string())?;
    } else {
        Command::new("open").arg("-R").arg(&path).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Kill the process listening on a given port using lsof + kill
#[tauri::command]
pub fn kill_port(port: u16) -> Result<(), String> {
    // Use lsof to find the PID listening on the port
    let output = Command::new("lsof")
        .args(["-ti", &format!(":{}", port)])
        .output()
        .map_err(|e| format!("Failed to run lsof: {}", e))?;

    let pids = String::from_utf8_lossy(&output.stdout);
    let pids: Vec<&str> = pids.trim().split('\n').filter(|s| !s.is_empty()).collect();

    if pids.is_empty() {
        return Err(format!("No process found on port {}", port));
    }

    for pid in &pids {
        Command::new("kill")
            .args(["-9", pid])
            .output()
            .map_err(|e| format!("Failed to kill PID {}: {}", pid, e))?;
    }

    Ok(())
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct SetupConfig {
    #[serde(default)]
    pub check: Option<String>,
    #[serde(default)]
    pub run: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct RallyConfig {
    #[serde(default, rename = "excludeScripts")]
    exclude_scripts: Vec<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub setup: Option<SetupConfig>,
    #[serde(default, rename = "statusBar")]
    pub status_bar: Vec<String>,
    #[serde(default, rename = "statusBarRight")]
    pub status_bar_right: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceReadiness {
    pub ready: bool,
    pub issues: Vec<String>,
}

#[tauri::command]
pub fn read_rally_config(root_path: String) -> Result<RallyConfig, String> {
    let rally_json = Path::new(&root_path).join("RALLY.json");
    if !rally_json.exists() {
        return Ok(RallyConfig {
            exclude_scripts: Vec::new(),
            mode: None,
            setup: None,
            status_bar: Vec::new(),
            status_bar_right: Vec::new(),
        });
    }
    let content = fs::read_to_string(&rally_json)
        .map_err(|e| format!("Failed to read RALLY.json: {}", e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse RALLY.json: {}", e))
}

#[tauri::command]
pub fn update_rally_config_status_bar(root_path: String, scripts: Vec<String>) -> Result<(), String> {
    let rally_json = Path::new(&root_path).join("RALLY.json");
    let mut config: serde_json::Value = if rally_json.exists() {
        let content = fs::read_to_string(&rally_json)
            .map_err(|e| format!("Failed to read RALLY.json: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse RALLY.json: {}", e))?
    } else {
        serde_json::json!({})
    };
    config["statusBar"] = serde_json::json!(scripts);
    let pretty = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize RALLY.json: {}", e))?;
    fs::write(&rally_json, pretty + "\n")
        .map_err(|e| format!("Failed to write RALLY.json: {}", e))?;
    Ok(())
}

// --- Workspace readiness ---

/// Check readiness heuristics for a single directory. Returns issue strings
/// prefixed with the given label (empty for root).
fn check_dir_readiness(dir: &Path, label: &str) -> Vec<String> {
    let mut issues: Vec<String> = Vec::new();
    let prefix = if label.is_empty() {
        String::new()
    } else {
        format!("{}: ", label)
    };

    // package.json exists but no node_modules/
    if dir.join("package.json").exists() && !dir.join("node_modules").is_dir() {
        issues.push(format!("{}Dependencies not installed", prefix));
    }

    // Cargo.toml exists but no target/
    if dir.join("Cargo.toml").exists() && !dir.join("target").is_dir() {
        issues.push(format!("{}Rust project not built", prefix));
    }

    // CMakeLists.txt exists but no build/
    if dir.join("CMakeLists.txt").exists() && !dir.join("build").is_dir() {
        issues.push(format!("{}C++ project not built", prefix));
    }

    // .env.example exists but no .env
    if dir.join(".env.example").exists() && !dir.join(".env").exists() {
        issues.push(format!("{}Environment not configured", prefix));
    }

    // Python: requirements.txt or pyproject.toml but no venv
    let has_python = dir.join("requirements.txt").exists() || dir.join("pyproject.toml").exists();
    if has_python && !dir.join("venv").is_dir() && !dir.join(".venv").is_dir() {
        issues.push(format!("{}Python env not set up", prefix));
    }

    issues
}

#[tauri::command]
pub async fn check_workspace_ready(root_path: String) -> Result<WorkspaceReadiness, String> {
    // Run on a blocking thread so we don't stall the main/async runtime
    tokio::task::spawn_blocking(move || {
        let root = Path::new(&root_path);
        let mut issues: Vec<String> = Vec::new();

        // Check root directory
        issues.extend(check_dir_readiness(root, ""));

        // Check immediate subdirectories (monorepo support)
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.filter_map(|e| e.ok()) {
                if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                // Skip hidden dirs and common non-project dirs
                if name.starts_with('.') || HIDDEN_DIRS.contains(&name.as_str()) {
                    continue;
                }
                issues.extend(check_dir_readiness(&entry.path(), &name));
            }
        }

        // Check GitHub CLI auth — use `gh auth token` (local keyring only, no network)
        // instead of `gh auth status` which hits the GitHub API and can take 8+ seconds
        if let Ok(output) = Command::new("gh").args(["auth", "token"]).output() {
            if !output.status.success() {
                issues.push("GitHub CLI not authenticated (run gh auth login)".to_string());
            }
        }

        // Custom check from RALLY.json setup.check
        let rally_json = root.join("RALLY.json");
        if rally_json.exists() {
            if let Ok(content) = fs::read_to_string(&rally_json) {
                if let Ok(config) = serde_json::from_str::<RallyConfig>(&content) {
                    if let Some(setup) = &config.setup {
                        if let Some(check_cmd) = &setup.check {
                            let output = Command::new("sh")
                                .args(["-c", check_cmd])
                                .current_dir(&root_path)
                                .output();
                            if let Ok(out) = output {
                                if !out.status.success() {
                                    let stderr = String::from_utf8_lossy(&out.stderr);
                                    let msg = stderr.trim();
                                    if msg.is_empty() {
                                        issues.push("Setup check failed".to_string());
                                    } else {
                                        issues.push(msg.to_string());
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        Ok(WorkspaceReadiness {
            ready: issues.is_empty(),
            issues,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

// --- Scripts & commands ---

const SCRIPT_EXTENSIONS: &[&str] = &[".sh", ".bash", ".zsh"];

#[derive(Debug, Serialize)]
pub struct ScriptEntry {
    pub name: String,
    pub command: String,
    pub label: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub builtin: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
}

/// Whether a filename looks like a runnable shell script.
fn is_script_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    SCRIPT_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

/// Strip the directory and script extension to produce a display label
/// (e.g. `tools/ci/check.sh` → `check`).
fn script_label(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string());
    base.trim_end_matches(".bash")
        .trim_end_matches(".zsh")
        .trim_end_matches(".sh")
        .to_string()
}

/// Build a `ScriptEntry` for a resolved script file.
///
/// `name` is the identity the UI matches against config entries: the basename
/// for scripts auto-discovered from `scripts/`, or the verbatim config string
/// (often a relative path) for entries declared in RALLY.json.
fn make_script_entry(abs_path: &Path, name: String) -> ScriptEntry {
    let full_path = abs_path.to_string_lossy().to_string();
    let interpreter = if full_path.to_lowercase().ends_with(".zsh") {
        "zsh"
    } else {
        "bash"
    };
    let label = script_label(&name);
    ScriptEntry {
        command: format!("{} \"{}\"", interpreter, full_path),
        name,
        label,
        builtin: false,
        file_path: Some(full_path),
    }
}

/// Discover script files from the `scripts/` directory at the repo root.
fn discover_scripts(root_path: &str, exclude: &[String]) -> Vec<ScriptEntry> {
    let scripts_dir = Path::new(root_path).join("scripts");
    if !scripts_dir.is_dir() {
        return Vec::new();
    }

    let mut scripts: Vec<ScriptEntry> = fs::read_dir(&scripts_dir)
        .into_iter()
        .flatten() // Result<ReadDir> → ReadDir
        .flatten() // DirEntry results
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();

            // Only include script files
            if !is_script_file(&name) {
                return None;
            }
            // Skip excluded scripts
            if exclude.iter().any(|ex| ex == &name) {
                return None;
            }

            Some(make_script_entry(&entry.path(), name))
        })
        .collect();

    scripts.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    scripts
}

/// Resolve a RALLY.json script reference to a concrete file.
///
/// Resolution order:
///   1. As a path relative to the repo root (`tools/build.sh`, `scripts/check.sh`).
///   2. Fallback to `scripts/<basename>` — keeps bare filenames (and stale
///      paths) working against the conventional `scripts/` directory.
///
/// The returned entry's `name` is the verbatim config string so the frontend
/// can match it back to the RALLY.json `statusBar` entry.
fn resolve_config_script(root: &Path, reference: &str) -> Option<ScriptEntry> {
    if !is_script_file(reference) {
        return None;
    }

    // 1. Relative path from the repo root.
    let direct = root.join(reference);
    if direct.is_file() {
        return Some(make_script_entry(&direct, reference.to_string()));
    }

    // 2. Fallback: scripts/<basename>.
    let basename = Path::new(reference).file_name()?.to_string_lossy().to_string();
    let in_scripts = root.join("scripts").join(&basename);
    if in_scripts.is_file() {
        return Some(make_script_entry(&in_scripts, reference.to_string()));
    }

    None
}

#[tauri::command]
pub fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

/// Read text from the system clipboard using macOS pbpaste.
/// Avoids WebKit's clipboard permission popup that navigator.clipboard.readText() triggers.
#[tauri::command]
pub fn read_clipboard_text() -> Result<String, String> {
    let output = Command::new("pbpaste")
        .output()
        .map_err(|e| format!("Failed to run pbpaste: {}", e))?;
    if !output.status.success() {
        return Err("pbpaste failed".to_string());
    }
    String::from_utf8(output.stdout)
        .map_err(|e| format!("Clipboard content is not valid UTF-8: {}", e))
}

/// Save base64-encoded image data to a temp file.
/// Returns the absolute path to the saved file.
#[tauri::command]
pub fn save_clipboard_image(data: String, mime_type: String) -> Result<String, String> {
    let ext = match mime_type.as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        _ => "png", // default to png
    };

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    let dir = std::env::temp_dir().join("rally-clipboard");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let filename = format!(
        "paste-{}.{}",
        uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or("img"),
        ext
    );
    let path = dir.join(&filename);
    fs::write(&path, &bytes).map_err(|e| format!("Failed to write image: {}", e))?;

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn list_scripts(root_path: String) -> Result<Vec<ScriptEntry>, String> {
    let root = Path::new(&root_path);
    let rally_json = root.join("RALLY.json");

    let config: RallyConfig = if rally_json.exists() {
        let content = fs::read_to_string(&rally_json)
            .map_err(|e| format!("Failed to read RALLY.json: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse RALLY.json: {}", e))?
    } else {
        RallyConfig {
            exclude_scripts: Vec::new(),
            mode: None,
            setup: None,
            status_bar: Vec::new(),
            status_bar_right: Vec::new(),
        }
    };

    let mut entries: Vec<ScriptEntry> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    // 1. Scripts auto-discovered from the `scripts/` directory (keyed by basename).
    for entry in discover_scripts(&root_path, &config.exclude_scripts) {
        seen.insert(entry.name.clone());
        entries.push(entry);
    }

    // 2. RALLY.json status-bar references resolved as relative paths (with a
    //    `scripts/` fallback). Skip any already covered by discovery.
    for reference in config.status_bar.iter().chain(config.status_bar_right.iter()) {
        if seen.contains(reference) {
            continue;
        }
        if let Some(entry) = resolve_config_script(root, reference) {
            seen.insert(reference.clone());
            entries.push(entry);
        }
    }

    Ok(entries)
}
