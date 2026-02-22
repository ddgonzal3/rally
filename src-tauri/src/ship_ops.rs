use serde::{Deserialize, Serialize};
use std::fs;
use std::os::unix;
use std::path::PathBuf;

use crate::git_ops;

const SHIP_COMMAND_VERSION: &str = "<!-- rally-ship-v8 -->";
const SHIP_COMMAND_CONTENT: &str = include_str!("../resources/commands/ship.md");
const REVIEW_COMMAND_VERSION: &str = "<!-- rally-review-pr-v3 -->";
const REVIEW_COMMAND_CONTENT: &str = include_str!("../resources/commands/review-pr.md");

const GSHIP_SCRIPT: &str = include_str!("../resources/scripts/gship");
const GPR_SCRIPT: &str = include_str!("../resources/scripts/gpr");
const GMERGE_SCRIPT: &str = include_str!("../resources/scripts/gmerge");
const GFINISH_SCRIPT: &str = include_str!("../resources/scripts/gfinish");
const GSYNC_SCRIPT: &str = include_str!("../resources/scripts/gsync");
const GRB_SCRIPT: &str = include_str!("../resources/scripts/grb");

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
    pub verdict: String, // "auto_merge" | "manual_review" | "shipping"
    #[serde(default)]
    pub phase: Option<String>,
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

    // Install CLI scripts to ~/.rally/bin/
    let bin_dir = PathBuf::from(&home).join(".rally").join("bin");
    fs::create_dir_all(&bin_dir)
        .map_err(|e| format!("Failed to create ~/.rally/bin: {}", e))?;

    for (name, content) in &[
        ("gship", GSHIP_SCRIPT),
        ("gpr", GPR_SCRIPT),
        ("gmerge", GMERGE_SCRIPT),
        ("gfinish", GFINISH_SCRIPT),
        ("gsync", GSYNC_SCRIPT),
        ("grb", GRB_SCRIPT),
    ] {
        install_script(&bin_dir, name, content)?;
    }

    // Install `ship` CLI script to ~/.rally/bin/ (available in all Rally terminals)
    install_ship_script(&home)?;

    Ok(())
}

/// Install the `ship` shell script to ~/.rally/bin/.
/// Rally terminals have ~/.rally/bin on PATH, so `ship` is available everywhere.
fn install_ship_script(home: &str) -> Result<(), String> {
    let bin_dir = PathBuf::from(home).join(".rally").join("bin");
    fs::create_dir_all(&bin_dir)
        .map_err(|e| format!("Failed to create ~/.rally/bin: {}", e))?;

    let script = r#"#!/bin/zsh
repo=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$repo" ]; then echo "Not in a git repository"; exit 1; fi
mkdir -p ~/.rally/ship-triggers
printf '{"repo_path":"%s"}\n' "$repo" > ~/.rally/ship-triggers/$(date +%s).json
echo "Ship triggered for $(basename "$repo") — check Rally for progress"
"#;

    let script_path = bin_dir.join("ship");
    fs::write(&script_path, script)
        .map_err(|e| format!("Failed to write ship script: {}", e))?;

    // Make executable
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o755);
        fs::set_permissions(&script_path, perms)
            .map_err(|e| format!("Failed to chmod ship script: {}", e))?;
    }

    Ok(())
}

/// Install a script to ~/.rally/bin/ if it doesn't already exist.
/// Uses install-once strategy: never overwrites existing scripts.
fn install_script(bin_dir: &PathBuf, name: &str, content: &str) -> Result<(), String> {
    let script_path = bin_dir.join(name);
    if script_path.exists() {
        return Ok(()); // User may have customized — don't overwrite
    }
    fs::write(&script_path, content)
        .map_err(|e| format!("Failed to write {}: {}", name, e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o755);
        fs::set_permissions(&script_path, perms)
            .map_err(|e| format!("Failed to chmod {}: {}", name, e))?;
    }
    Ok(())
}

// --- Script editor: list + restore Rally scripts ---

#[derive(Debug, Clone, Serialize)]
pub struct RallyScriptInfo {
    pub name: String,
    pub path: String,
    pub category: String, // "script" or "command"
    pub is_modified: bool,
    pub description: String,
}

/// Known scripts: (filename, embedded_content, description)
fn known_scripts() -> Vec<(&'static str, &'static str, &'static str)> {
    vec![
        ("gship", GSHIP_SCRIPT, "Launch Claude Code to run /ship"),
        ("gpr", GPR_SCRIPT, "Push and create PR into main"),
        ("gmerge", GMERGE_SCRIPT, "Squash merge PR + sync local branch"),
        ("gfinish", GFINISH_SCRIPT, "Commit + push + merge after review"),
        ("gsync", GSYNC_SCRIPT, "Hard reset + rebase onto main"),
        ("grb", GRB_SCRIPT, "Safe rebase onto main with stash/pop"),
    ]
}

/// Known commands: (filename, embedded_content, description)
fn known_commands() -> Vec<(&'static str, &'static str, &'static str)> {
    vec![
        ("ship.md", SHIP_COMMAND_CONTENT, "Full automated shipping workflow"),
        ("review-pr.md", REVIEW_COMMAND_CONTENT, "Thorough PR review process"),
    ]
}

/// List all Rally-managed scripts and commands with metadata.
#[tauri::command]
pub fn list_rally_scripts() -> Result<Vec<RallyScriptInfo>, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let bin_dir = PathBuf::from(&home).join(".rally").join("bin");
    let cmd_dir = PathBuf::from(&home).join(".rally").join("commands");

    let mut results = Vec::new();

    for (name, default_content, desc) in known_scripts() {
        let path = bin_dir.join(name);
        let is_modified = if path.exists() {
            fs::read_to_string(&path)
                .map(|c| c != default_content)
                .unwrap_or(true)
        } else {
            false // Not installed yet — not "modified"
        };
        results.push(RallyScriptInfo {
            name: name.to_string(),
            path: path.to_string_lossy().to_string(),
            category: "script".to_string(),
            is_modified,
            description: desc.to_string(),
        });
    }

    for (name, default_content, desc) in known_commands() {
        let path = cmd_dir.join(name);
        let is_modified = if path.exists() {
            fs::read_to_string(&path)
                .map(|c| c != default_content)
                .unwrap_or(true)
        } else {
            false
        };
        results.push(RallyScriptInfo {
            name: name.to_string(),
            path: path.to_string_lossy().to_string(),
            category: "command".to_string(),
            is_modified,
            description: desc.to_string(),
        });
    }

    Ok(results)
}

/// Restore a Rally script or command to its embedded default.
#[tauri::command]
pub fn restore_rally_script(name: String) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;

    // Check scripts first
    for (sname, content, _) in known_scripts() {
        if sname == name {
            let path = PathBuf::from(&home).join(".rally").join("bin").join(sname);
            fs::write(&path, content)
                .map_err(|e| format!("Failed to write {}: {}", sname, e))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let perms = std::fs::Permissions::from_mode(0o755);
                fs::set_permissions(&path, perms)
                    .map_err(|e| format!("Failed to chmod {}: {}", sname, e))?;
            }
            return Ok(());
        }
    }

    // Check commands
    for (cname, content, _) in known_commands() {
        if cname == name {
            let path = PathBuf::from(&home).join(".rally").join("commands").join(cname);
            fs::write(&path, content)
                .map_err(|e| format!("Failed to write {}: {}", cname, e))?;
            return Ok(());
        }
    }

    Err(format!("Unknown script: {}", name))
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

/// Check for ship trigger files written by the `ship` zsh alias.
/// Returns the repo_path from the first trigger found, or None.
/// Deletes the trigger file after reading it.
#[tauri::command]
pub fn check_ship_trigger() -> Result<Option<String>, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let dir = PathBuf::from(home).join(".rally").join("ship-triggers");
    if !dir.exists() {
        return Ok(None);
    }
    let entries = fs::read_dir(&dir).map_err(|e| format!("Failed to read trigger dir: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();
        if path.extension().map_or(false, |e| e == "json") {
            let content = fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read trigger: {}", e))?;
            // Delete trigger file immediately (consume it)
            let _ = fs::remove_file(&path);
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(repo_path) = val.get("repo_path").and_then(|v| v.as_str()) {
                    return Ok(Some(repo_path.to_string()));
                }
            }
        }
    }
    Ok(None)
}

/// Post-merge sync: checkout main, pull, then sync the feature branch
/// by resetting the now-merged commits and rebasing onto main.
/// Leaves the repo on the feature branch, synced with main.
#[tauri::command]
pub async fn post_merge_sync(
    cwd: String,
    main_branch: String,
    merged_branch: String,
) -> Result<String, String> {
    // 1. Update main with the merged changes
    git_ops::git_cmd(&cwd, &["checkout", &main_branch]).await?;
    git_ops::git_cmd(&cwd, &["pull"]).await?;

    // 2. Go back to the feature branch
    git_ops::git_cmd(&cwd, &["checkout", &merged_branch]).await?;

    // 3. Count how many commits the feature branch is ahead of main
    //    (these are the commits that were squash-merged and are now redundant)
    let count_output = git_ops::git_cmd(
        &cwd,
        &["rev-list", "--count", &format!("{}..{}", main_branch, merged_branch)],
    ).await?;
    let count: usize = count_output.trim().parse().unwrap_or(0);

    // 4. Reset those commits and rebase onto main (gsync)
    if count > 0 {
        git_ops::git_cmd(&cwd, &["reset", "--hard", &format!("HEAD~{}", count)]).await?;
    }
    git_ops::git_cmd(&cwd, &["rebase", &main_branch]).await?;

    // 5. Push the synced branch to remote so local and remote stay in sync
    //    (force-with-lease because the history was rewritten by reset+rebase)
    git_ops::git_cmd(&cwd, &["push", "--force-with-lease"]).await?;

    Ok(format!(
        "Synced {} with {} (reset {} commits, rebased, pushed)",
        merged_branch, main_branch, count
    ))
}
