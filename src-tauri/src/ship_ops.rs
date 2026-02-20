use serde::{Deserialize, Serialize};
use std::fs;
use std::os::unix;
use std::path::PathBuf;

use crate::git_ops;

const SHIP_COMMAND_VERSION: &str = "<!-- rally-ship-v2 -->";
const SHIP_COMMAND_CONTENT: &str = include_str!("../resources/commands/ship.md");
const REVIEW_COMMAND_VERSION: &str = "<!-- rally-review-pr-v1 -->";
const REVIEW_COMMAND_CONTENT: &str = include_str!("../resources/commands/review-pr.md");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlaggedItem {
    pub file: String,
    pub line: u32,
    pub severity: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShipSignal {
    pub version: u32,
    pub timestamp: String,
    pub repo_path: String,
    pub branch: String,
    pub verdict: String, // "auto_merge" | "manual_review"
    pub pr_number: u32,
    pub pr_url: String,
    pub summary: String,
    pub flagged_items: Vec<FlaggedItem>,
}

fn signals_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".rally").join("ship-signals")
}

fn sanitize_repo_path(repo_path: &str) -> String {
    repo_path
        .strip_prefix('/')
        .unwrap_or(repo_path)
        .replace('/', "--")
}

fn signal_file_path(repo_path: &str) -> PathBuf {
    signals_dir().join(format!("{}.json", sanitize_repo_path(repo_path)))
}

/// Write a command file if missing or outdated.
fn install_command(target_dir: &PathBuf, filename: &str, version: &str, content: &str) -> Result<(), String> {
    let target = target_dir.join(filename);
    if target.exists() {
        if let Ok(existing) = fs::read_to_string(&target) {
            if existing.starts_with(version) {
                return Ok(()); // Already up to date
            }
        }
    }
    fs::write(&target, content)
        .map_err(|e| format!("Failed to write {} to {}: {}", filename, target.display(), e))?;
    Ok(())
}

/// Create a symlink at link_path → target_path.
/// Replaces existing symlinks if they point elsewhere. Skips if a real file exists
/// (user may have their own version).
fn symlink_command(target_path: &PathBuf, link_path: &PathBuf) -> Result<(), String> {
    if link_path.exists() || link_path.symlink_metadata().is_ok() {
        // Check if it's already a symlink pointing to our target
        if let Ok(existing_target) = fs::read_link(link_path) {
            if existing_target == *target_path {
                return Ok(()); // Already correct
            }
            // Symlink points elsewhere — replace it
            fs::remove_file(link_path)
                .map_err(|e| format!("Failed to remove old symlink: {}", e))?;
        } else {
            // It's a real file — don't overwrite the user's own file
            return Ok(());
        }
    }
    unix::fs::symlink(target_path, link_path)
        .map_err(|e| format!("Failed to create symlink: {}", e))?;
    Ok(())
}

/// Path to app's own commands directory: ~/.rally/commands/
pub fn rally_commands_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let dir = PathBuf::from(home).join(".rally").join("commands");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create commands dir: {}", e))?;
    Ok(dir)
}

/// Ensure default commands (ship.md, review-pr.md) are installed.
/// - Actual files live in ~/.rally/commands/ (app's domain)
/// - Symlinks in ~/.claude/commands/ point to them (so Claude Code finds them)
pub fn ensure_default_commands() -> Result<(), String> {
    // Ensure signals directory exists
    let sig_dir = signals_dir();
    fs::create_dir_all(&sig_dir).map_err(|e| format!("Failed to create signals dir: {}", e))?;

    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;

    // Write actual files to ~/.rally/commands/
    let app_dir = rally_commands_dir()?;
    install_command(&app_dir, "ship.md", SHIP_COMMAND_VERSION, SHIP_COMMAND_CONTENT)?;
    install_command(&app_dir, "review-pr.md", REVIEW_COMMAND_VERSION, REVIEW_COMMAND_CONTENT)?;

    // Symlink from ~/.claude/commands/ → ~/.rally/commands/
    let claude_dir = PathBuf::from(&home).join(".claude").join("commands");
    fs::create_dir_all(&claude_dir)
        .map_err(|e| format!("Failed to create ~/.claude/commands: {}", e))?;

    for filename in &["ship.md", "review-pr.md"] {
        symlink_command(&app_dir.join(filename), &claude_dir.join(filename))?;
    }

    Ok(())
}

/// Check if a ship signal file exists for the given repo path.
#[tauri::command]
pub fn check_ship_signal(repo_path: String) -> Result<Option<ShipSignal>, String> {
    let path = signal_file_path(&repo_path);
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read signal file: {}", e))?;
    let signal: ShipSignal = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse signal file: {}", e))?;
    Ok(Some(signal))
}

/// Delete the ship signal file for a repo.
#[tauri::command]
pub fn clear_ship_signal(repo_path: String) -> Result<(), String> {
    let path = signal_file_path(&repo_path);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete signal: {}", e))?;
    }
    Ok(())
}

/// Post-merge sync: checkout main, pull, delete merged branch locally.
#[tauri::command]
pub fn post_merge_sync(
    cwd: String,
    main_branch: String,
    merged_branch: String,
) -> Result<String, String> {
    git_ops::git_cmd(&cwd, &["checkout", &main_branch])?;
    git_ops::git_cmd(&cwd, &["pull"])?;

    // Delete the merged branch locally (ignore error if already gone)
    let _ = git_ops::git_cmd(&cwd, &["branch", "-d", &merged_branch]);

    Ok(format!(
        "Synced to {} and cleaned up {}",
        main_branch, merged_branch
    ))
}
