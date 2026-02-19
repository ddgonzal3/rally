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
    child: Box<dyn portable_pty::Child + Send>,
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

        let mut cmd = if let Some(ref cmd_str) = command {
            // Run commands through a login shell so PATH is fully loaded
            let mut builder = CommandBuilder::new(&shell);
            builder.arg("-l");
            builder.arg("-c");
            builder.arg(cmd_str);
            builder.cwd(&cwd);
            builder
        } else {
            // Default: spawn user's shell
            let mut builder = CommandBuilder::new(&shell);
            builder.arg("-l"); // login shell
            builder.cwd(&cwd);
            builder
        };

        // Inherit environment
        for (key, value) in std::env::vars() {
            cmd.env(key, value);
        }
        // Remove env vars that prevent Claude Code from launching inside Workbench PTYs
        cmd.env_remove("CLAUDECODE");
        cmd.env_remove("CLAUDE_CODE_ENTRYPOINT");
        // Set TERM for proper terminal behavior
        cmd.env("TERM", "xterm-256color");
        // Identify as Workbench terminal — prevents Claude Code from inheriting
        // the parent's TERM_PROGRAM (e.g. "vscode") and making wrong assumptions
        // about terminal capabilities/dimensions
        cmd.env("TERM_PROGRAM", "Workbench");
        cmd.env_remove("TERM_PROGRAM_VERSION");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn command: {}", e))?;

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
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        // EOF — process exited
                        let _ = app_handle_clone.emit(
                            &format!("pty-exit-{}", reader_id),
                            PtyExitPayload { code: None },
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
        if let Some(mut session) = self.sessions.remove(pty_id) {
            let _ = session.child.kill();
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
) -> Result<String, String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.spawn(app_handle, cwd, command, cols, rows)
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
