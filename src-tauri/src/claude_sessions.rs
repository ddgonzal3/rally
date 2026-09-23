//! Live Claude Code session facts.
//!
//! Claude Code writes `~/.claude/sessions/<pid>.json` for every interactive
//! and background session and keeps `status` (`idle` | `busy` | `waiting`)
//! plus `waitingFor` current. That file is the ground truth for "is this
//! agent working, blocked on me, or sitting at its prompt" — terminal
//! silence is not. Rally reads the directory and maps each session PID back
//! to the Rally PTY whose shell spawned it by walking the parent-PID chain.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

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
    /// Claude has replied at least once in this session. A fresh or
    /// `/clear`ed Claude has no conversation; one waiting on you does.
    pub has_conversation: bool,
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

/// Claude Code's transcript folder name for a cwd: every character that is
/// not ASCII alphanumeric becomes `-` (`/Users/me/flow` -> `-Users-me-flow`).
fn project_slug(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// A transcript line written by Claude itself. Local commands (`/clear`,
/// `/model`) log user and system lines but never an assistant one.
fn transcript_has_reply(path: &Path) -> bool {
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    BufReader::new(file).lines().map_while(Result::ok).any(|line| {
        line.contains("\"type\":\"assistant\"")
            && serde_json::from_str::<serde_json::Value>(&line)
                .ok()
                .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(|t| t == "assistant"))
                .unwrap_or(false)
    })
}

/// Session ids already known to have a conversation. A conversation never
/// goes away within a session (`/clear` starts a new id), so a hit is final
/// and the transcript is never re-read.
static CONVERSATIONS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn has_conversation(projects: Option<&Path>, cwd: &str, session_id: Option<&str>) -> bool {
    let (Some(projects), Some(id)) = (projects, session_id) else {
        return false;
    };
    if let Ok(guard) = CONVERSATIONS.lock() {
        if guard.as_ref().is_some_and(|set| set.contains(id)) {
            return true;
        }
    }
    let found = transcript_has_reply(&projects.join(project_slug(cwd)).join(format!("{id}.jsonl")));
    if found {
        if let Ok(mut guard) = CONVERSATIONS.lock() {
            guard.get_or_insert_with(HashSet::new).insert(id.to_string());
        }
    }
    found
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
    let projects = dir.parent().map(|p| p.join("projects"));

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
        let cwd = file.cwd.unwrap_or_default();
        let has_conversation = has_conversation(projects.as_deref(), &cwd, file.session_id.as_deref());
        out.push(ClaudeSessionInfo {
            pid: file.pid,
            session_id: file.session_id,
            cwd,
            status: file.status.unwrap_or_else(|| "unknown".to_string()),
            waiting_for: file.waiting_for,
            name: file.name,
            kind: file.kind,
            updated_at: file.updated_at.unwrap_or(0),
            started_at: file.started_at.unwrap_or(0),
            pty_id,
            has_conversation,
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
    fn project_slug_matches_claude_code() {
        assert_eq!(project_slug("/Users/splice/splice/flow4"), "-Users-splice-splice-flow4");
        assert_eq!(project_slug("/a/my.repo_x"), "-a-my-repo-x");
    }

    #[test]
    fn only_a_reply_counts_as_a_conversation() {
        let dir = std::env::temp_dir().join(format!("rally-transcript-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let cleared = dir.join("cleared.jsonl");
        fs::write(
            &cleared,
            "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"content\":\"caveat\"}}\n\
             {\"type\":\"user\",\"message\":{\"content\":\"<command-name>/clear</command-name> says \\\"type\\\":\\\"assistant\\\"\"}}\n\
             {\"type\":\"system\"}\n",
        )
        .unwrap();
        let talked = dir.join("talked.jsonl");
        fs::write(&talked, "{\"type\":\"user\",\"message\":{}}\n{\"type\":\"assistant\",\"message\":{}}\n").unwrap();
        assert!(!transcript_has_reply(&cleared));
        assert!(transcript_has_reply(&talked));
        assert!(!transcript_has_reply(&dir.join("missing.jsonl")));
        fs::remove_dir_all(&dir).unwrap();
    }

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
