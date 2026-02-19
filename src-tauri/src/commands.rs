use serde::Serialize;
use std::fs;
use std::path::Path;

use crate::git_ops;
use crate::workspace::{self, GitStatus, Workspace};

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

            // Skip hidden/large dirs
            if entry.file_type().ok()?.is_dir() && HIDDEN_DIRS.contains(&name.as_str()) {
                return None;
            }

            Some(FileEntry {
                name,
                path: entry.path().to_string_lossy().to_string(),
                is_dir: entry.file_type().ok()?.is_dir(),
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
pub fn detect_git_info(path: String) -> Result<GitRepoInfo, String> {
    let repo_url = git_ops::git_cmd(&path, &["remote", "get-url", "origin"])
        .unwrap_or_default();
    let branch = git_ops::git_cmd(&path, &["symbolic-ref", "--short", "HEAD"])
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
pub fn create_workspace(
    name: String,
    path: String,
    repo_url: String,
    branch: String,
    main_branch: Option<String>,
) -> Result<Workspace, String> {
    let mut workspaces = workspace::load_workspaces();

    let ws = Workspace {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        path,
        repo_url,
        branch,
        main_branch: main_branch.unwrap_or_else(|| "main".to_string()),
        processes: vec![],
    };

    workspaces.push(ws.clone());
    workspace::save_workspaces(&workspaces)?;
    Ok(ws)
}

#[tauri::command]
pub fn remove_workspace(id: String) -> Result<(), String> {
    let mut workspaces = workspace::load_workspaces();
    workspaces.retain(|w| w.id != id);
    workspace::save_workspaces(&workspaces)
}

#[tauri::command]
pub fn git_status(workspace_path: String) -> Result<GitStatus, String> {
    git_ops::status(&workspace_path)
}

#[tauri::command]
pub fn git_sync(workspace_path: String, branch: String, main_branch: String) -> Result<String, String> {
    git_ops::sync(&workspace_path, &branch, &main_branch)
}

#[tauri::command]
pub fn git_rebase(workspace_path: String, branch: String, main_branch: String) -> Result<String, String> {
    git_ops::rebase(&workspace_path, &branch, &main_branch)
}

#[tauri::command]
pub fn git_commit(workspace_path: String, message: String) -> Result<String, String> {
    git_ops::commit(&workspace_path, &message)
}

#[tauri::command]
pub fn git_push(workspace_path: String) -> Result<String, String> {
    git_ops::push(&workspace_path)
}

#[tauri::command]
pub fn git_create_pr(
    workspace_path: String,
    title: Option<String>,
    body: Option<String>,
) -> Result<String, String> {
    git_ops::create_pr(
        &workspace_path,
        title.as_deref(),
        body.as_deref(),
    )
}
