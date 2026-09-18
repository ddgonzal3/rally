//! Live Claude Code session facts.
//!
//! Claude Code writes `~/.claude/sessions/<pid>.json` for every interactive
//! and background session and keeps `status` (`idle` | `busy` | `waiting`)
//! plus `waitingFor` current. That file is the ground truth for "is this
//! agent working, blocked on me, or sitting at its prompt" — terminal
//! silence is not. Rally reads the directory and maps each session PID back
//! to the Rally PTY whose shell spawned it by walking the parent-PID chain.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use crate::pty_manager::{read_ppid_map, PtyState};

/// Max parent hops from a Claude PID to the PTY shell. Claude runs as
/// `zsh -> claude` (or `zsh -> node`), so 8 is generous.
const MAX_PPID_HOPS: usize = 8;

#[derive(Debug, Deserialize)]
struct SessionFile {
    pid: u32,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    cwd: Option<String>,
    status: Option<String>,
    #[serde(rename = "waitingFor")]
    waiting_for: Option<String>,
    name: Option<String>,
    kind: Option<String>,
    #[serde(rename = "updatedAt")]
    updated_at: Option<u64>,
    #[serde(rename = "startedAt")]
    started_at: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ClaudeSessionInfo {
    pub pid: u32,
    pub session_id: Option<String>,
    pub cwd: String,
    /// `idle` | `busy` | `waiting` | `unknown`
    pub status: String,
    pub waiting_for: Option<String>,
    pub name: Option<String>,
    pub kind: Option<String>,
    pub updated_at: u64,
    pub started_at: u64,
    /// Rally PTY that owns this session, if the process tree leads to one.
    pub pty_id: Option<String>,
}

fn sessions_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir).join("sessions"));
        }
    }
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".claude").join("sessions"))
}

/// Walk up the parent chain from `pid` until a PID in `shells` is found.
fn owning_pty(
    pid: u32,
    ppid_map: &HashMap<u32, u32>,
    shells: &HashMap<u32, String>,
) -> Option<String> {
    let mut current = pid;
    for _ in 0..MAX_PPID_HOPS {
        if let Some(pty_id) = shells.get(&current) {
            return Some(pty_id.clone());
        }
        let parent = *ppid_map.get(&current)?;
        if parent <= 1 {
            return None;
        }
        current = parent;
    }
    None
}

/// Read every live session file and attach the owning Rally PTY id.
/// Files whose PID is no longer running are ignored (Claude sweeps them
/// itself; we never delete user files).
pub fn list_sessions(shells: &HashMap<u32, String>) -> Vec<ClaudeSessionInfo> {
    let Some(dir) = sessions_dir() else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    // One `ps` pass for liveness + parent chain.
    let ppid_map = read_ppid_map();

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // Strict `<pid>.json` guard — the dir also holds `<pid>.<hash>.key`.
        if !name.ends_with(".json") || !name[..name.len() - 5].chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let Ok(content) = fs::read_to_string(entry.path()) else {
            continue;
        };
        let Ok(file) = serde_json::from_str::<SessionFile>(&content) else {
            continue;
        };
        if !ppid_map.contains_key(&file.pid) {
            continue; // stale file from a crashed session
        }
        let pty_id = owning_pty(file.pid, &ppid_map, shells);
        out.push(ClaudeSessionInfo {
            pid: file.pid,
            session_id: file.session_id,
            cwd: file.cwd.unwrap_or_default(),
            status: file.status.unwrap_or_else(|| "unknown".to_string()),
            waiting_for: file.waiting_for,
            name: file.name,
            kind: file.kind,
            updated_at: file.updated_at.unwrap_or(0),
            started_at: file.started_at.unwrap_or(0),
            pty_id,
        });
    }
    out
}

#[tauri::command]
pub async fn list_claude_sessions(
    state: tauri::State<'_, PtyState>,
) -> Result<Vec<ClaudeSessionInfo>, String> {
    // Snapshot shell PIDs under the lock, then do the slow `ps` + file reads
    // off the lock and off the async runtime.
    let shells = {
        let manager = state.lock().map_err(|e| e.to_string())?;
        manager.shell_pid_map()
    };
    tokio::task::spawn_blocking(move || list_sessions(&shells))
        .await
        .map_err(|e| format!("list_claude_sessions join error: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owning_pty_walks_parent_chain() {
        let mut ppid = HashMap::new();
        ppid.insert(300, 200); // claude -> node
        ppid.insert(200, 100); // node -> zsh
        ppid.insert(100, 1);
        let mut shells = HashMap::new();
        shells.insert(100, "pty-a".to_string());
        assert_eq!(owning_pty(300, &ppid, &shells).as_deref(), Some("pty-a"));
    }

    #[test]
    fn owning_pty_stops_at_init() {
        let mut ppid = HashMap::new();
        ppid.insert(300, 1);
        let shells: HashMap<u32, String> = HashMap::new();
        assert_eq!(owning_pty(300, &ppid, &shells), None);
    }

    #[test]
    fn owning_pty_gives_up_on_cycles() {
        let mut ppid = HashMap::new();
        ppid.insert(300, 200);
        ppid.insert(200, 300);
        let shells: HashMap<u32, String> = HashMap::new();
        assert_eq!(owning_pty(300, &ppid, &shells), None);
    }
}
