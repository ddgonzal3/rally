use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

const WORKSPACES_FILE: &str = "workspaces.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub paths: Vec<String>,
    pub repo_url: String,
    pub branch: String,
    pub main_branch: String,
    pub processes: Vec<ProcessConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessConfig {
    pub name: String,
    pub command: String,
    pub cwd: Option<String>,
    pub auto_start: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStatus {
    pub branch: String,
    pub dirty: bool,
    pub ahead: u32,
    pub behind: u32,
    pub modified_files: Vec<String>,
    pub untracked_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushResult {
    pub output: String,
    pub method: String, // "push" | "force-with-lease" | "set-upstream"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrStatus {
    pub number: u32,
    pub title: String,
    pub url: String,
    pub state: String,      // "OPEN" | "CLOSED" | "MERGED"
    pub is_draft: bool,
    pub mergeable: String,  // "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
    pub review_decision: Option<String>, // "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED"
    pub checks_status: Option<String>,   // "pass" | "fail" | "pending"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangedFile {
    pub path: String,
    pub status: String, // "M" modified, "A" added, "D" deleted, "R" renamed
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangesSummary {
    pub staged: Vec<ChangedFile>,
    pub unstaged: Vec<ChangedFile>,
    pub untracked: Vec<String>,
}

fn config_dir() -> PathBuf {
    dirs_next().unwrap_or_else(|| PathBuf::from("."))
}

fn dirs_next() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let dir = PathBuf::from(home).join(".playbench");
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

pub fn load_workspaces() -> Vec<Workspace> {
    let file_path = config_dir().join(WORKSPACES_FILE);
    if !file_path.exists() {
        return vec![];
    }
    let data = fs::read_to_string(&file_path).unwrap_or_default();

    // Try direct deserialization first (new format with `paths`)
    if let Ok(workspaces) = serde_json::from_str::<Vec<Workspace>>(&data) {
        return workspaces;
    }

    // Migration: old format had `path: String` instead of `paths: Vec<String>`
    let mut arr: Vec<Value> = match serde_json::from_str(&data) {
        Ok(v) => v,
        Err(_) => return vec![],
    };

    let mut migrated = false;
    for obj in arr.iter_mut() {
        if let Some(map) = obj.as_object_mut() {
            if let Some(path_val) = map.remove("path") {
                if let Some(path_str) = path_val.as_str() {
                    map.insert("paths".to_string(), Value::Array(vec![Value::String(path_str.to_string())]));
                    migrated = true;
                }
            }
        }
    }

    let workspaces: Vec<Workspace> = serde_json::from_value(Value::Array(arr)).unwrap_or_default();

    // Persist migrated data so we don't re-migrate
    if migrated {
        let _ = save_workspaces(&workspaces);
    }

    workspaces
}

pub fn save_workspaces(workspaces: &[Workspace]) -> Result<(), String> {
    let path = config_dir().join(WORKSPACES_FILE);
    let data = serde_json::to_string_pretty(workspaces).map_err(|e| e.to_string())?;
    fs::write(path, data).map_err(|e| e.to_string())
}
