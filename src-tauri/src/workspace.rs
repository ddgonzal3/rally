use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const WORKSPACES_FILE: &str = "workspaces.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: String,
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
    let path = config_dir().join(WORKSPACES_FILE);
    if !path.exists() {
        return vec![];
    }
    let data = fs::read_to_string(path).unwrap_or_default();
    serde_json::from_str(&data).unwrap_or_default()
}

pub fn save_workspaces(workspaces: &[Workspace]) -> Result<(), String> {
    let path = config_dir().join(WORKSPACES_FILE);
    let data = serde_json::to_string_pretty(workspaces).map_err(|e| e.to_string())?;
    fs::write(path, data).map_err(|e| e.to_string())
}
