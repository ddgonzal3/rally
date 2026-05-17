use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

const PARKED_FILE: &str = "parked.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParkedThread {
    pub id: String,
    pub repo: String,
    pub branch: String,
    pub session_id: Option<String>,
    pub summary: String,
    pub parked_at: u64,
    /// Origin URL captured at park time. Used on resume to detect cross-origin
    /// mismatches before attempting a checkout. `serde(default)` keeps older
    /// records (parked before v3) parseable.
    #[serde(default)]
    pub origin_url: String,
}

fn rally_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {}", e))?;
    let dir = PathBuf::from(home).join(".rally");
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {}", dir.display(), e))?;
    Ok(dir)
}

fn parked_path() -> Result<PathBuf, String> {
    Ok(rally_dir()?.join(PARKED_FILE))
}

/// Recover from poisoned-mutex state instead of silently bailing.
/// PoisonError still hands back the inner guard; we use the data and move on.
fn lock_store() -> MutexGuard<'static, ()> {
    STORE_LOCK.lock().unwrap_or_else(PoisonError::into_inner)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

static STORE_LOCK: Mutex<()> = Mutex::new(());

pub fn load_all() -> Vec<ParkedThread> {
    let _guard = lock_store();
    let Ok(path) = parked_path() else {
        return vec![];
    };
    if !path.exists() {
        return vec![];
    }
    let data = fs::read_to_string(&path).unwrap_or_default();
    serde_json::from_str(&data).unwrap_or_default()
}

/// Append a new parked thread. Generates id + parked_at if missing.
/// Replaces any existing entry for the same (repo, branch) pair.
pub fn append(input: ParkInput) -> Result<ParkedThread, String> {
    let _guard = lock_store();
    let path = parked_path()?;
    let mut threads: Vec<ParkedThread> = if path.exists() {
        let data = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        vec![]
    };

    threads.retain(|t| !(t.repo == input.repo && t.branch == input.branch));

    let thread = ParkedThread {
        id: uuid::Uuid::new_v4().to_string(),
        repo: input.repo,
        branch: input.branch,
        session_id: input.session_id,
        summary: input.summary,
        parked_at: now_secs(),
        origin_url: input.origin_url.unwrap_or_default(),
    };

    threads.push(thread.clone());

    let data = serde_json::to_string_pretty(&threads).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())?;

    Ok(thread)
}

pub fn remove(id: &str) -> Result<(), String> {
    let _guard = lock_store();
    let path = parked_path()?;
    if !path.exists() {
        return Ok(());
    }
    let data = fs::read_to_string(&path).unwrap_or_default();
    let mut threads: Vec<ParkedThread> = serde_json::from_str(&data).unwrap_or_default();
    threads.retain(|t| t.id != id);
    let new_data = serde_json::to_string_pretty(&threads).map_err(|e| e.to_string())?;
    fs::write(&path, new_data).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Deserialize)]
pub struct ParkInput {
    pub repo: String,
    pub branch: String,
    pub session_id: Option<String>,
    pub summary: String,
    #[serde(default)]
    pub origin_url: Option<String>,
}

#[tauri::command]
pub fn list_parked_threads() -> Vec<ParkedThread> {
    load_all()
}

#[tauri::command]
pub fn remove_parked_thread(id: String) -> Result<(), String> {
    remove(&id)
}
