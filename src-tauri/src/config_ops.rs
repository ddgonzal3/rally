use base64::Engine as _;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
pub struct ConfigFile {
    pub name: String,
    pub path: String,
    pub file_type: String, // "claude-md", "skill", "settings"
}

#[derive(Debug, Serialize)]
pub struct SkillInfo {
    pub name: String,
    pub path: String,
    pub content_preview: String,
}

fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string()))
}

#[tauri::command]
pub fn read_file_content(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path, e))
}

#[tauri::command]
pub fn read_file_base64(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| format!("Failed to read {}: {}", path, e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
pub fn write_file_content(path: String, content: String) -> Result<(), String> {
    // Ensure parent directory exists
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| format!("Failed to write {}: {}", path, e))
}

#[tauri::command]
pub fn list_claude_configs(workspace_path: Option<String>) -> Vec<ConfigFile> {
    let mut configs = Vec::new();

    // Global CLAUDE.md
    let global = home_dir().join(".claude").join("CLAUDE.md");
    if global.exists() {
        configs.push(ConfigFile {
            name: "Global CLAUDE.md".to_string(),
            path: global.to_string_lossy().to_string(),
            file_type: "claude-md".to_string(),
        });
    } else {
        // Still show it so users can create it
        configs.push(ConfigFile {
            name: "Global CLAUDE.md (create)".to_string(),
            path: global.to_string_lossy().to_string(),
            file_type: "claude-md".to_string(),
        });
    }

    // Project CLAUDE.md
    if let Some(ref ws_path) = workspace_path {
        let project = Path::new(ws_path).join("CLAUDE.md");
        configs.push(ConfigFile {
            name: "Project CLAUDE.md".to_string(),
            path: project.to_string_lossy().to_string(),
            file_type: "claude-md".to_string(),
        });
    }

    // Global settings.json
    let settings = home_dir().join(".claude").join("settings.json");
    if settings.exists() {
        configs.push(ConfigFile {
            name: "Claude Settings".to_string(),
            path: settings.to_string_lossy().to_string(),
            file_type: "settings".to_string(),
        });
    }

    configs
}

#[tauri::command]
pub fn list_skills(workspace_path: Option<String>) -> Vec<SkillInfo> {
    let mut skills = Vec::new();

    // Check global skills
    let global_skills = home_dir().join(".claude").join("skills");
    collect_skills(&global_skills, &mut skills);

    // Check project skills
    if let Some(ref ws_path) = workspace_path {
        let project_skills = Path::new(ws_path).join(".claude").join("skills");
        collect_skills(&project_skills, &mut skills);
    }

    skills
}

fn collect_skills(dir: &Path, skills: &mut Vec<SkillInfo>) {
    if !dir.is_dir() {
        return;
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e == "md").unwrap_or(false) {
                let content = fs::read_to_string(&path).unwrap_or_default();
                let preview = content.lines().take(3).collect::<Vec<_>>().join("\n");
                skills.push(SkillInfo {
                    name: path
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    path: path.to_string_lossy().to_string(),
                    content_preview: preview,
                });
            }
        }
    }
}
