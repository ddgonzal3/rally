use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
struct ChatEventPayload {
    session_id: String,
    data: Value,
}

struct ChatSession {
    child: Child,
    stdin: ChildStdin,
}

pub struct ChatManager {
    sessions: HashMap<String, ChatSession>,
}

pub struct ChatManagerState(pub Mutex<ChatManager>);

impl ChatManager {
    pub fn new() -> Self {
        ChatManager {
            sessions: HashMap::new(),
        }
    }

    /// Resolve the path to the sidecar script.
    /// Production: `../Resources/sidecar/claude-sidecar.mjs` relative to the executable.
    /// Dev fallback: `sidecar/claude-sidecar.mjs` relative to cwd.
    fn sidecar_path() -> Result<String, String> {
        // Try production path first
        if let Ok(exe) = std::env::current_exe() {
            let prod_path = exe
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .join("../Resources/sidecar/claude-sidecar.mjs");
            if prod_path.exists() {
                return prod_path
                    .to_str()
                    .map(|s| s.to_string())
                    .ok_or_else(|| "Invalid sidecar path encoding".to_string());
            }
        }

        // Dev fallback
        let dev_path = std::path::Path::new("sidecar/claude-sidecar.mjs");
        if dev_path.exists() {
            return dev_path
                .canonicalize()
                .map_err(|e| format!("Failed to canonicalize dev sidecar path: {}", e))?
                .to_str()
                .map(|s| s.to_string())
                .ok_or_else(|| "Invalid dev sidecar path encoding".to_string());
        }

        Err("Sidecar script not found. Looked in production (../Resources/sidecar/) and dev (sidecar/) locations.".to_string())
    }

    /// Resolve the path to the `node` binary, using the same login-shell PATH
    /// expansion that pty_manager uses so node is available even when launched
    /// as a .app bundle (where PATH is minimal).
    fn node_path() -> String {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        if let Ok(output) = std::process::Command::new(&shell)
            .args(["-lc", "which node"])
            .output()
        {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() && std::path::Path::new(&path).exists() {
                return path;
            }
        }
        "node".to_string()
    }

    pub fn spawn(
        &mut self,
        app_handle: AppHandle,
        cwd: String,
        prompt: String,
    ) -> Result<String, String> {
        let sidecar = Self::sidecar_path()?;
        let node = Self::node_path();

        let mut child = Command::new(&node)
            .arg(&sidecar)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .current_dir(&cwd)
            .spawn()
            .map_err(|e| format!("Failed to spawn sidecar (node={}): {}", node, e))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to capture sidecar stdin".to_string())?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture sidecar stdout".to_string())?;

        let session_id = uuid::Uuid::new_v4().to_string();

        // Spawn reader thread — reads stdout line-by-line, parses JSON,
        // emits Tauri events. Uses a dedicated std::thread (not tokio)
        // because blocking reads on child stdout.
        let reader_session_id = session_id.clone();
        let reader_app_handle = app_handle.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let event_name = format!("chat-event-{}", reader_session_id);

            for line in reader.lines() {
                match line {
                    Ok(text) => {
                        let text = text.trim().to_string();
                        if text.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Value>(&text) {
                            Ok(data) => {
                                let _ = reader_app_handle.emit(
                                    &event_name,
                                    ChatEventPayload {
                                        session_id: reader_session_id.clone(),
                                        data,
                                    },
                                );
                            }
                            Err(e) => {
                                eprintln!(
                                    "[chat_manager] Failed to parse sidecar JSON: {} — line: {}",
                                    e, text
                                );
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!(
                            "[chat_manager] Sidecar stdout read error for {}: {}",
                            reader_session_id, e
                        );
                        break;
                    }
                }
            }

            // EOF — sidecar process ended. Emit synthetic exit event.
            let exit_data =
                serde_json::json!({"type": "result", "subtype": "exit"});
            let _ = reader_app_handle.emit(
                &event_name,
                ChatEventPayload {
                    session_id: reader_session_id.clone(),
                    data: exit_data,
                },
            );
        });

        // Send the start command to the sidecar
        let mut session = ChatSession { child, stdin };
        let start_cmd = serde_json::json!({
            "cmd": "start",
            "prompt": prompt,
            "cwd": cwd,
        });
        Self::write_to_stdin(&mut session.stdin, &start_cmd)?;

        self.sessions.insert(session_id.clone(), session);

        Ok(session_id)
    }

    pub fn send_message(&mut self, session_id: &str, text: &str) -> Result<(), String> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Chat session not found: {}", session_id))?;

        let cmd = serde_json::json!({
            "cmd": "user_message",
            "text": text,
        });
        Self::write_to_stdin(&mut session.stdin, &cmd)
    }

    pub fn respond_to_permission(
        &mut self,
        session_id: &str,
        request_id: &str,
        decision: &str,
        message: Option<&str>,
    ) -> Result<(), String> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Chat session not found: {}", session_id))?;

        let mut cmd = serde_json::json!({
            "cmd": "permission_response",
            "request_id": request_id,
            "decision": decision,
        });
        if let Some(msg) = message {
            cmd["message"] = Value::String(msg.to_string());
        }
        Self::write_to_stdin(&mut session.stdin, &cmd)
    }

    pub fn cancel(&mut self, session_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Chat session not found: {}", session_id))?;

        let cmd = serde_json::json!({"cmd": "cancel"});
        Self::write_to_stdin(&mut session.stdin, &cmd)
    }

    pub fn end(&mut self, session_id: &str) -> Result<(), String> {
        // Send cancel first (best-effort), then kill and remove
        if let Some(session) = self.sessions.get_mut(session_id) {
            let cmd = serde_json::json!({"cmd": "cancel"});
            let _ = Self::write_to_stdin(&mut session.stdin, &cmd);
        }

        if let Some(mut session) = self.sessions.remove(session_id) {
            let _ = session.child.kill();
        }

        Ok(())
    }

    /// Kill all sidecar processes. Called on app exit.
    pub fn kill_all(&mut self) {
        let ids: Vec<String> = self.sessions.keys().cloned().collect();
        for id in ids {
            let _ = self.end(&id);
        }
    }

    fn write_to_stdin(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
        let mut serialized =
            serde_json::to_string(value).map_err(|e| format!("Failed to serialize JSON: {}", e))?;
        serialized.push('\n');
        stdin
            .write_all(serialized.as_bytes())
            .map_err(|e| format!("Failed to write to sidecar stdin: {}", e))?;
        stdin
            .flush()
            .map_err(|e| format!("Failed to flush sidecar stdin: {}", e))?;
        Ok(())
    }
}

// --- Tauri Commands ---

#[tauri::command]
pub fn start_chat_session(
    app_handle: AppHandle,
    state: tauri::State<'_, ChatManagerState>,
    cwd: String,
    prompt: String,
) -> Result<String, String> {
    let mut manager = state.0.lock().map_err(|e| e.to_string())?;
    manager.spawn(app_handle, cwd, prompt)
}

#[tauri::command]
pub fn send_chat_message(
    state: tauri::State<'_, ChatManagerState>,
    session_id: String,
    text: String,
) -> Result<(), String> {
    let mut manager = state.0.lock().map_err(|e| e.to_string())?;
    manager.send_message(&session_id, &text)
}

#[tauri::command]
pub fn respond_to_permission(
    state: tauri::State<'_, ChatManagerState>,
    session_id: String,
    request_id: String,
    decision: String,
    message: Option<String>,
) -> Result<(), String> {
    let mut manager = state.0.lock().map_err(|e| e.to_string())?;
    manager.respond_to_permission(
        &session_id,
        &request_id,
        &decision,
        message.as_deref(),
    )
}

#[tauri::command]
pub fn cancel_chat_session(
    state: tauri::State<'_, ChatManagerState>,
    session_id: String,
) -> Result<(), String> {
    let mut manager = state.0.lock().map_err(|e| e.to_string())?;
    manager.cancel(&session_id)
}

#[tauri::command]
pub fn end_chat_session(
    state: tauri::State<'_, ChatManagerState>,
    session_id: String,
) -> Result<(), String> {
    let mut manager = state.0.lock().map_err(|e| e.to_string())?;
    manager.end(&session_id)
}
