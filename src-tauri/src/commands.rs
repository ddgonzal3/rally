use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::process::Command;

use crate::git_ops;
use crate::workspace::{self, ChangesSummary, GitStatus, PrStatus, PushResult, Workspace};

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
    paths: Vec<String>,
) -> Result<Workspace, String> {
    if paths.is_empty() {
        return Err("At least one path is required".to_string());
    }
    let mut workspaces = workspace::load_workspaces();

    // Auto-detect git info from the primary path
    let primary = &paths[0];
    let repo_url = git_ops::git_cmd(primary, &["remote", "get-url", "origin"])
        .unwrap_or_default();
    let branch = git_ops::git_cmd(primary, &["rev-parse", "--abbrev-ref", "HEAD"])
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
    Ok(ws)
}

#[tauri::command]
pub fn remove_workspace(id: String) -> Result<(), String> {
    let mut workspaces = workspace::load_workspaces();
    workspaces.retain(|w| w.id != id);
    workspace::save_workspaces(&workspaces)
}

#[tauri::command]
pub fn add_workspace_path(id: String, path: String) -> Result<Workspace, String> {
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
    Ok(result)
}

#[tauri::command]
pub fn remove_workspace_path(id: String, path: String) -> Result<Workspace, String> {
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
    Ok(result)
}

#[tauri::command]
pub fn git_status(workspace_path: String, main_branch: String) -> Result<GitStatus, String> {
    git_ops::status(&workspace_path, &main_branch)
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
pub fn git_push(workspace_path: String) -> Result<PushResult, String> {
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

#[tauri::command]
pub fn git_pr_status(workspace_path: String) -> Result<PrStatus, String> {
    git_ops::pr_status(&workspace_path)
}

#[tauri::command]
pub fn git_merge_pr(workspace_path: String, method: String) -> Result<String, String> {
    git_ops::merge_pr(&workspace_path, &method)
}

#[tauri::command]
pub fn git_changes(workspace_path: String) -> Result<ChangesSummary, String> {
    git_ops::changes(&workspace_path)
}

#[tauri::command]
pub fn git_file_at_head(workspace_path: String, file_path: String) -> Result<String, String> {
    git_ops::file_at_head(&workspace_path, &file_path)
}

#[tauri::command]
pub fn git_stage_file(workspace_path: String, file_path: String) -> Result<(), String> {
    git_ops::stage_file(&workspace_path, &file_path)
}

#[tauri::command]
pub fn git_unstage_file(workspace_path: String, file_path: String) -> Result<(), String> {
    git_ops::unstage_file(&workspace_path, &file_path)
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskDef {
    pub command: String,
    pub label: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RallyConfig {
    #[serde(default)]
    tasks: std::collections::HashMap<String, TaskDef>,
    /// Opt-out list of built-in commands to hide (e.g. ["ship"]).
    /// If absent, all built-ins are shown.
    #[serde(default, rename = "excludeBuiltins")]
    exclude_builtins: Vec<String>,
}

// --- Task runner ---

#[derive(Debug, Serialize)]
pub struct TaskEntry {
    pub name: String,
    pub command: String,
    pub label: String,
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub builtin: bool,
    /// Path to the command's .md file (for viewing in the editor)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
}

/// Built-in commands that ship with the app.
fn builtin_commands() -> Vec<TaskEntry> {
    // Resolve the app's commands directory
    let cmd_dir = crate::ship_ops::rally_commands_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));

    vec![
        TaskEntry {
            name: "ship".to_string(),
            label: "/ship".to_string(),
            command: "claude:/ship".to_string(),
            cwd: None,
            builtin: true,
            file_path: Some(cmd_dir.join("ship.md").to_string_lossy().to_string()),
        },
        TaskEntry {
            name: "review-pr".to_string(),
            label: "/review-pr".to_string(),
            command: "claude:/review-pr".to_string(),
            cwd: None,
            builtin: true,
            file_path: Some(cmd_dir.join("review-pr.md").to_string_lossy().to_string()),
        },
        TaskEntry {
            name: "merge-pr".to_string(),
            label: "/merge-pr".to_string(),
            command: "claude:/merge-pr".to_string(),
            cwd: None,
            builtin: true,
            file_path: Some(cmd_dir.join("merge-pr.md").to_string_lossy().to_string()),
        },
    ]
}

#[tauri::command]
pub fn list_tasks(root_path: String) -> Result<Vec<TaskEntry>, String> {
    let rally_json = Path::new(&root_path).join("RALLY.json");

    let (config_tasks, exclude_builtins) = if rally_json.exists() {
        let content = fs::read_to_string(&rally_json)
            .map_err(|e| format!("Failed to read RALLY.json: {}", e))?;
        let config: RallyConfig = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse RALLY.json: {}", e))?;
        (config.tasks, config.exclude_builtins)
    } else {
        (std::collections::HashMap::new(), Vec::new())
    };

    let mut tasks: Vec<TaskEntry> = config_tasks
        .into_iter()
        .map(|(name, def)| TaskEntry {
            label: def.label.unwrap_or_else(|| name.clone()),
            name,
            command: def.command,
            cwd: def.cwd,
            builtin: false,
            file_path: None,
        })
        .collect();

    // Include all built-in commands except those in the exclude list
    for builtin in builtin_commands() {
        if !exclude_builtins.contains(&builtin.name) {
            tasks.push(builtin);
        }
    }

    tasks.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(tasks)
}

const RALLY_CMD_MARKER: &str = "<!-- auto-generated by rally -->";

#[tauri::command]
pub fn sync_claude_commands(root_path: String) -> Result<u32, String> {
    let rally_json = Path::new(&root_path).join("RALLY.json");
    if !rally_json.exists() {
        return Ok(0);
    }
    let content = fs::read_to_string(&rally_json)
        .map_err(|e| format!("Failed to read RALLY.json: {}", e))?;
    let config: RallyConfig = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse RALLY.json: {}", e))?;

    let cmds_dir = Path::new(&root_path).join(".claude").join("commands");
    fs::create_dir_all(&cmds_dir).map_err(|e| e.to_string())?;

    let mut written = 0u32;
    for (name, def) in &config.tasks {
        let filename = format!("_rally_{}.md", name);
        let filepath = cmds_dir.join(&filename);
        let label = def.label.as_deref().unwrap_or(name);
        let new_content = format!(
            "{}\n# {}\n\nRun the following command in the terminal:\n\n```bash\n{}\n```\n",
            RALLY_CMD_MARKER, label, def.command
        );

        let existing = fs::read_to_string(&filepath).unwrap_or_default();
        if existing != new_content {
            fs::write(&filepath, &new_content).map_err(|e| e.to_string())?;
            written += 1;
        }
    }

    // Clean up stale _rally_ commands
    if let Ok(dir) = fs::read_dir(&cmds_dir) {
        for entry in dir.flatten() {
            let fname = entry.file_name().to_string_lossy().to_string();
            if fname.starts_with("_rally_") && fname.ends_with(".md") {
                let task_name = &fname[6..fname.len() - 3];
                if !config.tasks.contains_key(task_name) {
                    if let Ok(c) = fs::read_to_string(entry.path()) {
                        if c.starts_with(RALLY_CMD_MARKER) {
                            let _ = fs::remove_file(entry.path());
                        }
                    }
                }
            }
        }
    }

    Ok(written)
}
