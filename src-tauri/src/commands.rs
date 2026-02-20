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

// --- Curated file explorer ---

#[derive(Debug, Serialize)]
pub struct CuratedEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskDef {
    pub command: String,
    pub label: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PlayConfig {
    #[serde(default)]
    include: Vec<String>,
    #[serde(default)]
    tasks: std::collections::HashMap<String, TaskDef>,
}

#[tauri::command]
pub fn list_curated_files(root_path: String) -> Result<Vec<CuratedEntry>, String> {
    let root = Path::new(&root_path);
    let mut entries = Vec::new();

    // Config files: CLAUDE.md, README variants, PLAY.json
    for name in &["CLAUDE.md", "README.md", "README", "README.txt"] {
        let p = root.join(name);
        if p.exists() {
            entries.push(CuratedEntry {
                name: name.to_string(),
                path: p.to_string_lossy().to_string(),
                is_dir: false,
                category: "config".to_string(),
            });
        }
    }

    // Skills: .claude/skills/*.md
    let skills_dir = root.join(".claude").join("skills");
    if skills_dir.is_dir() {
        if let Ok(dir) = fs::read_dir(&skills_dir) {
            for entry in dir.flatten() {
                let p = entry.path();
                if p.extension().map(|e| e == "md").unwrap_or(false) {
                    entries.push(CuratedEntry {
                        name: p.file_name().unwrap_or_default().to_string_lossy().to_string(),
                        path: p.to_string_lossy().to_string(),
                        is_dir: false,
                        category: "skill".to_string(),
                    });
                }
            }
        }
    }

    // Commands: .claude/commands/*.md
    let commands_dir = root.join(".claude").join("commands");
    if commands_dir.is_dir() {
        if let Ok(dir) = fs::read_dir(&commands_dir) {
            for entry in dir.flatten() {
                let p = entry.path();
                if p.extension().map(|e| e == "md").unwrap_or(false) {
                    entries.push(CuratedEntry {
                        name: p.file_name().unwrap_or_default().to_string_lossy().to_string(),
                        path: p.to_string_lossy().to_string(),
                        is_dir: false,
                        category: "command".to_string(),
                    });
                }
            }
        }
    }

    // PLAY.json includes
    let play_json = root.join("PLAY.json");
    if play_json.exists() {
        if let Ok(content) = fs::read_to_string(&play_json) {
            if let Ok(config) = serde_json::from_str::<PlayConfig>(&content) {
                for inc in &config.include {
                    // Strip trailing slashes before joining to avoid Path preserving them
                    let inc_clean = inc.trim_end_matches('/');
                    let resolved = root.join(inc_clean);
                    if resolved.exists() {
                        let resolved_str = resolved.to_string_lossy().to_string();
                        if entries.iter().any(|e| e.path == resolved_str) {
                            continue;
                        }
                        let name = inc_clean.to_string();
                        entries.push(CuratedEntry {
                            name,
                            path: resolved_str,
                            is_dir: resolved.is_dir(),
                            category: "include".to_string(),
                        });
                    }
                }
            }
        }
        // Add PLAY.json itself
        entries.push(CuratedEntry {
            name: "PLAY.json".to_string(),
            path: play_json.to_string_lossy().to_string(),
            is_dir: false,
            category: "config".to_string(),
        });
    }

    Ok(entries)
}

// --- Task runner ---

#[derive(Debug, Serialize)]
pub struct TaskEntry {
    pub name: String,
    pub command: String,
    pub label: String,
    pub cwd: Option<String>,
}

#[tauri::command]
pub fn list_tasks(root_path: String) -> Result<Vec<TaskEntry>, String> {
    let play_json = Path::new(&root_path).join("PLAY.json");
    if !play_json.exists() {
        return Ok(vec![]);
    }
    let content = fs::read_to_string(&play_json)
        .map_err(|e| format!("Failed to read PLAY.json: {}", e))?;
    let config: PlayConfig = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse PLAY.json: {}", e))?;

    let mut tasks: Vec<TaskEntry> = config
        .tasks
        .into_iter()
        .map(|(name, def)| TaskEntry {
            label: def.label.unwrap_or_else(|| name.clone()),
            name,
            command: def.command,
            cwd: def.cwd,
        })
        .collect();
    tasks.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(tasks)
}

const PLAY_CMD_MARKER: &str = "<!-- auto-generated by playbench -->";

#[tauri::command]
pub fn sync_claude_commands(root_path: String) -> Result<u32, String> {
    let play_json = Path::new(&root_path).join("PLAY.json");
    if !play_json.exists() {
        return Ok(0);
    }
    let content = fs::read_to_string(&play_json)
        .map_err(|e| format!("Failed to read PLAY.json: {}", e))?;
    let config: PlayConfig = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse PLAY.json: {}", e))?;

    let cmds_dir = Path::new(&root_path).join(".claude").join("commands");
    fs::create_dir_all(&cmds_dir).map_err(|e| e.to_string())?;

    let mut written = 0u32;
    for (name, def) in &config.tasks {
        let filename = format!("_play_{}.md", name);
        let filepath = cmds_dir.join(&filename);
        let label = def.label.as_deref().unwrap_or(name);
        let new_content = format!(
            "{}\n# {}\n\nRun the following command in the terminal:\n\n```bash\n{}\n```\n",
            PLAY_CMD_MARKER, label, def.command
        );

        let existing = fs::read_to_string(&filepath).unwrap_or_default();
        if existing != new_content {
            fs::write(&filepath, &new_content).map_err(|e| e.to_string())?;
            written += 1;
        }
    }

    // Clean up stale _play_ commands
    if let Ok(dir) = fs::read_dir(&cmds_dir) {
        for entry in dir.flatten() {
            let fname = entry.file_name().to_string_lossy().to_string();
            if fname.starts_with("_play_") && fname.ends_with(".md") {
                let task_name = &fname[6..fname.len() - 3];
                if !config.tasks.contains_key(task_name) {
                    if let Ok(c) = fs::read_to_string(entry.path()) {
                        if c.starts_with(PLAY_CMD_MARKER) {
                            let _ = fs::remove_file(entry.path());
                        }
                    }
                }
            }
        }
    }

    Ok(written)
}
