use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::process::Command;
use tauri::Emitter;

use crate::git_ops;
use crate::git_watch::GitWatchState;
use crate::workspace::{self, ChangesSummary, GitStatus, PrStatus, PushResult, Workspace};

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

const HIDDEN_DIRS: &[&str] = &["node_modules", ".git", ".angular", "dist", "target", ".nx"];

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

    if ws.paths.len() <= 1 {
        return Err("Cannot remove the last path from a workspace".to_string());
    }

    ws.paths.retain(|p| p != &path);
    let result = ws.clone();
    workspace::save_workspaces(&workspaces)?;
    emit_workspaces_updated(&app);
    Ok(result)
}

#[tauri::command]
pub async fn git_status(workspace_path: String, main_branch: String) -> Result<GitStatus, String> {
    git_ops::status(&workspace_path, &main_branch).await
}

#[tauri::command]
pub async fn git_pr_status(workspace_path: String) -> Result<PrStatus, String> {
    git_ops::pr_status(&workspace_path).await
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
pub async fn git_diff_stat(workspace_path: String) -> Result<(i64, i64), String> {
    git_ops::diff_stat(&workspace_path).await
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

#[derive(Debug, Deserialize)]
struct RallyConfig {
    #[serde(default, rename = "excludeBuiltins")]
    exclude_builtins: Vec<String>,
    #[serde(default, rename = "excludeScripts")]
    exclude_scripts: Vec<String>,
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

/// Built-in commands that ship with the app.
fn builtin_commands() -> Vec<ScriptEntry> {
    let cmd_dir = crate::ship_ops::rally_commands_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));

    vec![
        ScriptEntry {
            name: "ship".to_string(),
            label: "/ship".to_string(),
            command: "claude:/ship".to_string(),
            builtin: true,
            file_path: Some(cmd_dir.join("ship.md").to_string_lossy().to_string()),
        },
        ScriptEntry {
            name: "review-pr".to_string(),
            label: "/review-pr".to_string(),
            command: "claude:/review-pr".to_string(),
            builtin: true,
            file_path: Some(cmd_dir.join("review-pr.md").to_string_lossy().to_string()),
        },
    ]
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
            let lower = name.to_lowercase();

            // Only include script files
            if !SCRIPT_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
                return None;
            }
            // Skip excluded scripts
            if exclude.iter().any(|ex| ex == &name) {
                return None;
            }

            let full_path = entry.path().to_string_lossy().to_string();
            let interpreter = if lower.ends_with(".zsh") { "zsh" } else { "bash" };
            let command = format!("{} \"{}\"", interpreter, full_path);

            Some(ScriptEntry {
                name: name.clone(),
                label: name,
                command,
                builtin: false,
                file_path: Some(full_path),
            })
        })
        .collect();

    scripts.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    scripts
}

#[tauri::command]
pub fn list_scripts(root_path: String) -> Result<Vec<ScriptEntry>, String> {
    let rally_json = Path::new(&root_path).join("RALLY.json");

    let (exclude_builtins, exclude_scripts) = if rally_json.exists() {
        let content = fs::read_to_string(&rally_json)
            .map_err(|e| format!("Failed to read RALLY.json: {}", e))?;
        let config: RallyConfig = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse RALLY.json: {}", e))?;
        (config.exclude_builtins, config.exclude_scripts)
    } else {
        (Vec::new(), Vec::new())
    };

    let mut entries: Vec<ScriptEntry> = Vec::new();

    // Add built-in commands (filtered)
    for builtin in builtin_commands() {
        if !exclude_builtins.contains(&builtin.name) {
            entries.push(builtin);
        }
    }

    // Add discovered scripts (filtered)
    entries.extend(discover_scripts(&root_path, &exclude_scripts));

    Ok(entries)
}
