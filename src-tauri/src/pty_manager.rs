use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
pub struct PtyOutputPayload {
    pub data: Vec<u8>,
}

#[derive(Serialize, Clone)]
pub struct PtyExitPayload {
    pub code: Option<i32>,
}

#[derive(Serialize, Clone)]
pub struct PtyInfo {
    pub id: String,
    pub cwd: String,
    pub command: Option<String>,
    pub alive: bool,
}

struct PtySession {
    writer: Box<dyn Write + Send>,
    pair: portable_pty::PtyPair,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    cwd: String,
    command: Option<String>,
}

pub struct PtyManager {
    sessions: HashMap<String, PtySession>,
}

impl PtyManager {
    pub fn new() -> Self {
        PtyManager {
            sessions: HashMap::new(),
        }
    }

    pub fn spawn(
        &mut self,
        app_handle: AppHandle,
        cwd: String,
        command: Option<String>,
        cols: u16,
        rows: u16,
        exit_on_complete: bool,
    ) -> Result<String, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

        // Always spawn an interactive login shell — this ensures .zshrc/.zprofile
        // are fully loaded so tools like claude, node, etc. are on PATH.
        // If a command is provided, we write it to stdin after spawn.
        let mut cmd = CommandBuilder::new(&shell);
        cmd.arg("-l");
        cmd.cwd(&cwd);

        // Inherit environment
        for (key, value) in std::env::vars() {
            cmd.env(key, value);
        }
        // When launched as .app, PATH is minimal. Grab full PATH from a login shell.
        // Prepend ~/.rally/bin so Rally CLI tools (ship, etc.) are available.
        let rally_bin = std::env::var("HOME")
            .map(|h| format!("{}/.rally/bin", h))
            .unwrap_or_default();
        if let Ok(output) = std::process::Command::new(&shell)
            .args(["-lc", "echo $PATH"])
            .output()
        {
            if let Ok(path) = String::from_utf8(output.stdout) {
                let path = path.trim();
                if !path.is_empty() {
                    let full_path = if rally_bin.is_empty() {
                        path.to_string()
                    } else {
                        format!("{}:{}", rally_bin, path)
                    };
                    cmd.env("PATH", full_path);
                }
            }
        }
        // Remove env vars that prevent Claude Code from launching inside Rally PTYs
        cmd.env_remove("CLAUDECODE");
        cmd.env_remove("CLAUDE_CODE_ENTRYPOINT");
        // Set TERM for proper terminal behavior
        cmd.env("TERM", "xterm-256color");
        // Identify as Rally terminal — prevents Claude Code from inheriting
        // the parent's TERM_PROGRAM (e.g. "vscode") and making wrong assumptions
        // about terminal capabilities/dimensions
        cmd.env("TERM_PROGRAM", "Rally");
        cmd.env_remove("TERM_PROGRAM_VERSION");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn command: {}", e))?;
        let child = Arc::new(Mutex::new(child));

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to get PTY writer: {}", e))?;

        let pty_id = uuid::Uuid::new_v4().to_string();

        // Spawn reader thread
        let reader_id = pty_id.clone();
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

        let app_handle_clone = app_handle.clone();
        let child_clone = child.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        // EOF — process exited. Get the real exit code.
                        let code = child_clone
                            .lock()
                            .ok()
                            .and_then(|mut c| c.wait().ok())
                            .map(|status| status.exit_code() as i32);
                        let _ = app_handle_clone.emit(
                            &format!("pty-exit-{}", reader_id),
                            PtyExitPayload { code },
                        );
                        break;
                    }
                    Ok(n) => {
                        let _ = app_handle_clone.emit(
                            &format!("pty-output-{}", reader_id),
                            PtyOutputPayload {
                                data: buf[..n].to_vec(),
                            },
                        );
                    }
                    Err(e) => {
                        eprintln!("PTY read error for {}: {}", reader_id, e);
                        let _ = app_handle_clone.emit(
                            &format!("pty-exit-{}", reader_id),
                            PtyExitPayload { code: None },
                        );
                        break;
                    }
                }
            }
        });

        // If a command was requested, write it to stdin so it runs in the
        // fully-initialized shell (with .zshrc PATH etc.)
        let mut writer = writer;
        if let Some(ref cmd_str) = command {
            let input = if exit_on_complete {
                format!("{}; exit $?\n", cmd_str)
            } else {
                format!("{}\n", cmd_str)
            };
            let _ = writer.write_all(input.as_bytes());
        }

        self.sessions.insert(
            pty_id.clone(),
            PtySession {
                writer,
                pair,
                child,
                cwd,
                command,
            },
        );

        Ok(pty_id)
    }

    pub fn write(&mut self, pty_id: &str, data: &[u8]) -> Result<(), String> {
        let session = self
            .sessions
            .get_mut(pty_id)
            .ok_or_else(|| format!("PTY session not found: {}", pty_id))?;
        session
            .writer
            .write_all(data)
            .map_err(|e| format!("Failed to write to PTY: {}", e))?;
        session
            .writer
            .flush()
            .map_err(|e| format!("Failed to flush PTY: {}", e))?;
        Ok(())
    }

    pub fn resize(&mut self, pty_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self
            .sessions
            .get_mut(pty_id)
            .ok_or_else(|| format!("PTY session not found: {}", pty_id))?;
        session
            .pair
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to resize PTY: {}", e))?;
        Ok(())
    }

    pub fn kill(&mut self, pty_id: &str) -> Result<(), String> {
        if let Some(session) = self.sessions.remove(pty_id) {
            if let Ok(mut child) = session.child.lock() {
                let _ = child.kill();
            }
        }
        Ok(())
    }

    pub fn list(&self) -> Vec<PtyInfo> {
        self.sessions
            .iter()
            .map(|(id, session)| PtyInfo {
                id: id.clone(),
                cwd: session.cwd.clone(),
                command: session.command.clone(),
                alive: true,
            })
            .collect()
    }

    pub fn kill_all(&mut self) {
        let ids: Vec<String> = self.sessions.keys().cloned().collect();
        for id in ids {
            let _ = self.kill(&id);
        }
    }
}

// Tauri commands

pub type PtyState = Arc<Mutex<PtyManager>>;

#[tauri::command]
pub fn spawn_pty(
    app_handle: AppHandle,
    state: tauri::State<'_, PtyState>,
    cwd: String,
    command: Option<String>,
    cols: u16,
    rows: u16,
    exit_on_complete: Option<bool>,
) -> Result<String, String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.spawn(app_handle, cwd, command, cols, rows, exit_on_complete.unwrap_or(false))
}

#[tauri::command]
pub fn write_pty(
    state: tauri::State<'_, PtyState>,
    pty_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.write(&pty_id, &data)
}

#[tauri::command]
pub fn resize_pty(
    state: tauri::State<'_, PtyState>,
    pty_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.resize(&pty_id, cols, rows)
}

#[tauri::command]
pub fn kill_pty(
    state: tauri::State<'_, PtyState>,
    pty_id: String,
) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.kill(&pty_id)
}

#[tauri::command]
pub fn list_ptys(
    state: tauri::State<'_, PtyState>,
) -> Result<Vec<PtyInfo>, String> {
    let manager = state.lock().map_err(|e| e.to_string())?;
    Ok(manager.list())
}
