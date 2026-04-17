use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::io::{FromRawFd, IntoRawFd};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

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
pub struct PtyForegroundPayload {
    pub process: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct PtyInfo {
    pub id: String,
    pub cwd: String,
    pub command: Option<String>,
    pub alive: bool,
}

#[derive(Serialize, Clone)]
pub struct PtyInventoryEntry {
    pub id: String,
    pub cwd: String,
    pub command: Option<String>,
    pub shell_pid: Option<u32>,
    pub rss_kb: u64,
    pub cpu_pct: f32,
    pub descendant_count: u32,
    pub foreground: Option<String>,
    pub uptime_s: u64,
}

#[derive(Serialize, Clone)]
pub struct AppStats {
    pub rss_kb: u64,
    pub threads: u32,
    pub fds: u32,
    pub uptime_s: u64,
}

#[derive(Serialize, Clone)]
pub struct ProcessInventory {
    pub rally: AppStats,
    pub ptys: Vec<PtyInventoryEntry>,
}

struct PtySession {
    write_tx: Option<mpsc::Sender<Vec<u8>>>,
    pair: portable_pty::PtyPair,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    foreground: Arc<Mutex<Option<String>>>,
    /// Shared flag — set to true to stop ALL threads for this session
    /// (monitor, reader, flusher, writer). Threads check this and exit.
    shutdown: Arc<AtomicBool>,
    /// Raw fd of the cloned PTY reader. Closed on kill() to unblock the
    /// reader thread's blocking read() call. -1 means already closed.
    reader_fd: Arc<AtomicI32>,
    monitor_paused: Arc<AtomicBool>,
    cwd: String,
    command: Option<String>,
    shell_pid: Option<u32>,
    spawned_at: Instant,
}

pub struct PtyManager {
    sessions: HashMap<String, PtySession>,
}

fn is_claude_title(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    lower == "claude" || lower.starts_with("claude ")
}

fn spawn_foreground_monitor(
    app_handle: AppHandle,
    pty_id: String,
    shell_pid: Option<u32>,
    foreground: Arc<Mutex<Option<String>>>,
    shutdown: Arc<AtomicBool>,
    monitor_paused: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        const STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(150);
        const STEADY_POLL_INTERVAL: Duration = Duration::from_millis(1000);
        const STARTUP_WINDOW: Duration = Duration::from_secs(2);
        const CLAUDE_LOST_THRESHOLD: u8 = 3;

        let started_at = Instant::now();
        let mut last_state: Option<String> = None;
        let mut claude_lost_polls = 0u8;
        let foreground_event = format!("pty-foreground-{}", pty_id);

        loop {
            if shutdown.load(Ordering::Relaxed) {
                break;
            }

            // Skip polling when paused (PTY not visible to user)
            if monitor_paused.load(Ordering::Relaxed) {
                thread::sleep(STEADY_POLL_INTERVAL);
                continue;
            }

            let sampled = match shell_pid {
                Some(pid) => foreground_child_name(pid),
                None => None,
            };

            let next_state = if last_state.as_deref().is_some_and(is_claude_title) {
                match sampled.as_deref() {
                    Some(name) if is_claude_title(name) => {
                        claude_lost_polls = 0;
                        sampled
                    }
                    _ => {
                        claude_lost_polls = claude_lost_polls.saturating_add(1);
                        if claude_lost_polls < CLAUDE_LOST_THRESHOLD {
                            last_state.clone()
                        } else {
                            claude_lost_polls = 0;
                            sampled
                        }
                    }
                }
            } else {
                claude_lost_polls = 0;
                sampled
            };

            if next_state != last_state {
                if let Ok(mut cached) = foreground.lock() {
                    *cached = next_state.clone();
                }
                let _ = app_handle.emit(
                    &foreground_event,
                    PtyForegroundPayload {
                        process: next_state.clone(),
                    },
                );
                last_state = next_state;
            }

            let interval = if started_at.elapsed() < STARTUP_WINDOW {
                STARTUP_POLL_INTERVAL
            } else {
                STEADY_POLL_INTERVAL
            };
            thread::sleep(interval);
        }
    });
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

        // Validate cwd — if empty or non-existent, fall back to home directory.
        // This prevents terminals from spawning in `/` (the app's process cwd)
        // when a workspace path is missing or has been deleted from disk.
        let effective_cwd = if cwd.is_empty() || !std::path::Path::new(&cwd).is_dir() {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
            eprintln!(
                "[pty_manager] cwd {:?} is empty or does not exist, falling back to {:?}",
                cwd, home
            );
            home
        } else {
            cwd
        };

        // Always spawn an interactive login shell — this ensures .zshrc/.zprofile
        // are fully loaded so tools like claude, node, etc. are on PATH.
        // If a command is provided, we write it to stdin after spawn.
        let mut cmd = CommandBuilder::new(&shell);
        cmd.arg("-l");
        cmd.cwd(&effective_cwd);

        // Inherit environment
        for (key, value) in std::env::vars() {
            cmd.env(key, value);
        }
        // When launched as .app, PATH is minimal. Grab full PATH from a login shell.
        // Prepend ~/.rally/bin so Rally CLI tools are available.
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
        // Identify as Rally terminal for app-specific checks, while preserving
        // macOS zsh OSC 7 cwd reporting (gated behind TERM_PROGRAM=Apple_Terminal).
        // This keeps cwd tracking working for restore after relaunch.
        cmd.env("RALLY_TERM_PROGRAM", "Rally");
        let term_program = if cfg!(target_os = "macos") {
            "Apple_Terminal"
        } else {
            "Rally"
        };
        cmd.env("TERM_PROGRAM", term_program);
        cmd.env_remove("TERM_PROGRAM_VERSION");
        // Disable macOS shell session save/restore — prevents the
        // "Restored session: ..." message on every new terminal.
        cmd.env("SHELL_SESSION_DID_INIT", "1");
        cmd.env_remove("TERM_SESSION_ID");
        // Suppress zsh's PROMPT_EOL_MARK — the reverse-video `%` character it
        // outputs at startup to indicate no trailing newline. In an embedded
        // terminal this just leaves a white-background box artifact at (0,0).
        cmd.env("PROMPT_EOL_MARK", "");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn command: {}", e))?;
        let child = Arc::new(Mutex::new(child));
        let shell_pid = child.lock().map_err(|e| e.to_string())?.process_id();

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to get PTY writer: {}", e))?;

        let pty_id = uuid::Uuid::new_v4().to_string();
        let foreground = Arc::new(Mutex::new(None));
        let shutdown = Arc::new(AtomicBool::new(false));
        let monitor_paused = Arc::new(AtomicBool::new(true));
        spawn_foreground_monitor(
            app_handle.clone(),
            pty_id.clone(),
            shell_pid,
            foreground.clone(),
            shutdown.clone(),
            monitor_paused.clone(),
        );

        // Spawn reader thread.
        // We dup() the master fd to create our own reader fd that we can
        // close on kill() to unblock the reader thread's blocking read().
        // portable-pty's try_clone_reader() does the same thing internally
        // but returns Box<dyn Read> which hides the fd from us.
        let reader_id = pty_id.clone();
        let master_raw = pair.master.as_raw_fd()
            .ok_or_else(|| "Failed to get master fd".to_string())?;
        let dup_fd = unsafe { libc::dup(master_raw) };
        if dup_fd < 0 {
            return Err(format!("Failed to dup master fd: {}", std::io::Error::last_os_error()));
        }
        let reader_fd = Arc::new(AtomicI32::new(dup_fd));
        let mut reader = unsafe { std::fs::File::from_raw_fd(dup_fd) };

        // Buffered PTY output: reader thread pushes raw data into a channel,
        // flusher thread drains it every ~16ms and emits a single batched IPC event.
        // This collapses thousands of tiny reads into ~60 events/second.
        let (tx, rx) = mpsc::channel::<Vec<u8>>();

        // Reader thread — pushes raw chunks into channel
        let child_clone = child.clone();
        let tx_exit = tx.clone();
        let shutdown_for_reader = shutdown.clone();
        let reader_fd_for_reader = reader_fd.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            // Prevent File::drop from closing the fd — kill() may have
            // already closed it, and we track ownership via reader_fd.
            let _ = reader.into_raw_fd();
            // Close fd if we still own it (natural exit, not killed).
            // swap ensures only one thread closes it.
            let fd = reader_fd_for_reader.swap(-1, Ordering::SeqCst);
            if fd >= 0 {
                unsafe { libc::close(fd); }
            }
            // Signal EOF to flusher by dropping tx (receiver will get Disconnected)
            drop(tx);
            // Signal all sibling threads (monitor, writer) that this PTY is done
            shutdown_for_reader.store(true, Ordering::Relaxed);
            let _ = tx_exit; // ensure tx_exit is moved but unused — drop both senders
        });

        // Flusher thread — drains channel every ~16ms, emits batched events
        let app_handle_clone = app_handle.clone();
        thread::spawn(move || {
            const FLUSH_INTERVAL: Duration = Duration::from_millis(16);
            let mut pending = Vec::new();
            let mut last_flush = Instant::now();
            let output_event = format!("pty-output-{}", reader_id);
            let exit_event = format!("pty-exit-{}", reader_id);

            loop {
                // Wait for data with a timeout so we can flush periodically
                match rx.recv_timeout(FLUSH_INTERVAL) {
                    Ok(chunk) => {
                        pending.extend(chunk);
                        // Drain any additional queued chunks without blocking
                        while let Ok(more) = rx.try_recv() {
                            pending.extend(more);
                        }
                        if last_flush.elapsed() >= FLUSH_INTERVAL {
                            let _ = app_handle_clone.emit(
                                &output_event,
                                PtyOutputPayload { data: std::mem::take(&mut pending) },
                            );
                            last_flush = Instant::now();
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        // Timeout — flush whatever we have
                        if !pending.is_empty() {
                            let _ = app_handle_clone.emit(
                                &output_event,
                                PtyOutputPayload { data: std::mem::take(&mut pending) },
                            );
                            last_flush = Instant::now();
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        // Reader is done — flush remaining data and emit exit
                        if !pending.is_empty() {
                            let _ = app_handle_clone.emit(
                                &output_event,
                                PtyOutputPayload { data: std::mem::take(&mut pending) },
                            );
                        }
                        let code = child_clone
                            .lock()
                            .ok()
                            .and_then(|mut c| c.wait().ok())
                            .map(|status| status.exit_code() as i32);
                        let _ = app_handle_clone.emit(&exit_event, PtyExitPayload { code });
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

        // Spawn a dedicated writer thread so write_pty doesn't hold the
        // global mutex during blocking I/O (write_all + flush).
        let (write_tx, write_rx) = mpsc::channel::<Vec<u8>>();
        let shutdown_for_writer = shutdown.clone();
        thread::spawn(move || {
            let mut writer = writer;
            loop {
                match write_rx.recv_timeout(Duration::from_secs(1)) {
                    Ok(data) => {
                        let _ = writer.write_all(&data);
                        // Drain any queued writes before flushing
                        while let Ok(more) = write_rx.try_recv() {
                            let _ = writer.write_all(&more);
                        }
                        let _ = writer.flush();
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if shutdown_for_writer.load(Ordering::Relaxed) {
                            break;
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });

        self.sessions.insert(
            pty_id.clone(),
            PtySession {
                write_tx: Some(write_tx),
                pair,
                child,
                foreground,
                shutdown,
                reader_fd,
                monitor_paused,
                cwd: effective_cwd,
                command,
                shell_pid,
                spawned_at: Instant::now(),
            },
        );

        Ok(pty_id)
    }

    pub fn write(&self, pty_id: &str, data: &[u8]) -> Result<(), String> {
        let session = self
            .sessions
            .get(pty_id)
            .ok_or_else(|| format!("PTY session not found: {}", pty_id))?;
        if let Some(ref tx) = session.write_tx {
            tx.send(data.to_vec())
                .map_err(|e| format!("Failed to send to PTY writer: {}", e))?;
        }
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
            session.shutdown.store(true, Ordering::SeqCst);
            // Kill the entire process group so child processes (watchers, build
            // tools, etc.) are cleaned up, not just the shell itself.
            // In a PTY the shell is the session/process-group leader, so
            // kill(-pid, SIGHUP) reaches all descendants in the group.
            if let Some(pid) = session.shell_pid {
                unsafe {
                    libc::killpg(pid as libc::pid_t, libc::SIGHUP);
                    libc::killpg(pid as libc::pid_t, libc::SIGTERM);
                }
            }
            // Also kill the direct child as a fallback
            if let Ok(mut child) = session.child.lock() {
                let _ = child.kill();
            }
            // Close the reader fd to unblock the reader thread's read() call.
            // The atomic swap ensures only one thread (kill or reader) closes it.
            let fd = session.reader_fd.swap(-1, Ordering::SeqCst);
            if fd >= 0 {
                unsafe { libc::close(fd); }
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

    /// Returns the name of the foreground child process running in the PTY shell,
    /// or None if the shell has no child (i.e. sitting at a prompt).
    pub fn foreground_process(&self, pty_id: &str) -> Result<Option<String>, String> {
        let session = self
            .sessions
            .get(pty_id)
            .ok_or_else(|| format!("PTY session not found: {}", pty_id))?;
        session
            .foreground
            .lock()
            .map_err(|e| e.to_string())
            .map(|cached| cached.clone())
    }

    pub fn pause_monitor(&self, pty_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .get(pty_id)
            .ok_or_else(|| format!("PTY session not found: {}", pty_id))?;
        session.monitor_paused.store(true, Ordering::Relaxed);
        Ok(())
    }

    pub fn resume_monitor(&self, pty_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .get(pty_id)
            .ok_or_else(|| format!("PTY session not found: {}", pty_id))?;
        session.monitor_paused.store(false, Ordering::Relaxed);
        Ok(())
    }

    pub fn kill_all(&mut self) {
        let ids: Vec<String> = self.sessions.keys().cloned().collect();
        for id in ids {
            let _ = self.kill(&id);
        }
    }

    pub fn kill_many(&mut self, ids: &[String]) {
        for id in ids {
            let _ = self.kill(id);
        }
    }

    pub fn inventory(&self) -> ProcessInventory {
        let self_pid = std::process::id();

        // One ps pass for all processes, build pid -> (ppid, rss_kb, cpu, etime_s) map
        let proc_map = read_proc_map();

        // Build parent -> children map for subtree walking
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for (&pid, proc_stat) in &proc_map {
            children.entry(proc_stat.ppid).or_default().push(pid);
        }

        let rally = AppStats {
            rss_kb: proc_map.get(&self_pid).map(|p| p.rss_kb).unwrap_or(0),
            threads: count_own_threads(self_pid),
            fds: count_own_fds(),
            uptime_s: proc_map.get(&self_pid).map(|p| p.etime_s).unwrap_or(0),
        };

        let ptys = self
            .sessions
            .iter()
            .map(|(id, session)| {
                let (rss_kb, cpu_pct, descendant_count) = match session.shell_pid {
                    Some(pid) => {
                        let stat = proc_map.get(&pid);
                        let rss = stat.map(|s| s.rss_kb).unwrap_or(0);
                        let cpu = stat.map(|s| s.cpu_pct).unwrap_or(0.0);
                        let count = count_descendants(pid, &children);
                        (rss, cpu, count)
                    }
                    None => (0, 0.0, 0),
                };
                let foreground = session
                    .foreground
                    .lock()
                    .ok()
                    .and_then(|guard| guard.clone());
                PtyInventoryEntry {
                    id: id.clone(),
                    cwd: session.cwd.clone(),
                    command: session.command.clone(),
                    shell_pid: session.shell_pid,
                    rss_kb,
                    cpu_pct,
                    descendant_count,
                    foreground,
                    uptime_s: session.spawned_at.elapsed().as_secs(),
                }
            })
            .collect();

        ProcessInventory { rally, ptys }
    }
}

#[derive(Default)]
struct ProcStat {
    ppid: u32,
    rss_kb: u64,
    cpu_pct: f32,
    etime_s: u64,
}

/// Run `ps -axo pid,ppid,rss,%cpu,etime` once and parse into a map.
/// Avoids spawning N `ps` processes when inventorying many PTYs.
fn read_proc_map() -> HashMap<u32, ProcStat> {
    let mut map = HashMap::new();
    let output = match std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,rss=,%cpu=,etime="])
        .output()
    {
        Ok(o) => o,
        Err(_) => return map,
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 5 {
            continue;
        }
        let Ok(pid) = parts[0].parse::<u32>() else { continue };
        let ppid = parts[1].parse::<u32>().unwrap_or(0);
        let rss_kb = parts[2].parse::<u64>().unwrap_or(0);
        let cpu_pct = parts[3].parse::<f32>().unwrap_or(0.0);
        let etime_s = parse_etime(parts[4]);
        map.insert(pid, ProcStat { ppid, rss_kb, cpu_pct, etime_s });
    }
    map
}

/// Parse ps etime format: `[[DD-]HH:]MM:SS` into seconds.
fn parse_etime(s: &str) -> u64 {
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (d.parse::<u64>().unwrap_or(0), r),
        None => (0, s),
    };
    let parts: Vec<&str> = rest.split(':').collect();
    let (h, m, sec) = match parts.len() {
        3 => (
            parts[0].parse::<u64>().unwrap_or(0),
            parts[1].parse::<u64>().unwrap_or(0),
            parts[2].parse::<u64>().unwrap_or(0),
        ),
        2 => (
            0,
            parts[0].parse::<u64>().unwrap_or(0),
            parts[1].parse::<u64>().unwrap_or(0),
        ),
        _ => (0, 0, 0),
    };
    days * 86400 + h * 3600 + m * 60 + sec
}

/// Count descendants of `root` by walking the children map.
fn count_descendants(root: u32, children: &HashMap<u32, Vec<u32>>) -> u32 {
    let mut count = 0u32;
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if let Some(kids) = children.get(&pid) {
            for &kid in kids {
                count += 1;
                stack.push(kid);
            }
        }
    }
    count
}

/// Count threads of this Rally process via `ps -M`.
/// `ps -M -p PID` prints a header + one row per thread.
fn count_own_threads(pid: u32) -> u32 {
    let output = match std::process::Command::new("ps")
        .args(["-M", "-p", &pid.to_string()])
        .output()
    {
        Ok(o) => o,
        Err(_) => return 0,
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Subtract header row
    let lines: Vec<&str> = stdout.lines().collect();
    if lines.len() <= 1 { 0 } else { (lines.len() - 1) as u32 }
}

/// Count open file descriptors of this Rally process by reading /dev/fd.
/// This only works for the current process on macOS.
fn count_own_fds() -> u32 {
    std::fs::read_dir("/dev/fd")
        .map(|rd| rd.filter_map(|e| e.ok()).count() as u32)
        .unwrap_or(0)
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
    let manager = state.lock().map_err(|e| e.to_string())?;
    manager.write(&pty_id, &data)
}

#[tauri::command]
pub fn write_pty_string(
    state: tauri::State<'_, PtyState>,
    pty_id: String,
    data: String,
) -> Result<(), String> {
    let manager = state.lock().map_err(|e| e.to_string())?;
    manager.write(&pty_id, data.as_bytes())
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

#[tauri::command]
pub fn kill_all_ptys(
    state: tauri::State<'_, PtyState>,
) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.kill_all();
    Ok(())
}

#[tauri::command]
pub fn get_pty_foreground_process(
    state: tauri::State<'_, PtyState>,
    pty_id: String,
) -> Result<Option<String>, String> {
    let manager = state.lock().map_err(|e| e.to_string())?;
    manager.foreground_process(&pty_id)
}

#[tauri::command]
pub fn pause_pty_monitor(
    state: tauri::State<'_, PtyState>,
    pty_id: String,
) -> Result<(), String> {
    let manager = state.lock().map_err(|e| e.to_string())?;
    manager.pause_monitor(&pty_id)
}

#[tauri::command]
pub fn resume_pty_monitor(
    state: tauri::State<'_, PtyState>,
    pty_id: String,
) -> Result<(), String> {
    let manager = state.lock().map_err(|e| e.to_string())?;
    manager.resume_monitor(&pty_id)
}

#[tauri::command]
pub fn get_process_inventory(
    state: tauri::State<'_, PtyState>,
) -> Result<ProcessInventory, String> {
    let manager = state.lock().map_err(|e| e.to_string())?;
    Ok(manager.inventory())
}

#[tauri::command]
pub fn kill_ptys(
    state: tauri::State<'_, PtyState>,
    pty_ids: Vec<String>,
) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.kill_many(&pty_ids);
    Ok(())
}

/// Check if a single PID is a Claude Code process (by name or node args).
fn is_claude_process(pid: &str) -> bool {
    let comm = std::process::Command::new("ps")
        .args(["-o", "comm=", "-p", pid])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    let basename = comm.rsplit('/').next().unwrap_or(&comm);

    if basename == "claude" {
        return true;
    }

    // Node processes might be running claude — check full args
    if basename == "node" {
        let args = std::process::Command::new("ps")
            .args(["-o", "args=", "-p", pid])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();

        if args.contains("/claude") {
            return true;
        }
    }

    false
}

/// Recursively search the process subtree for a Claude Code process.
fn has_claude_in_subtree(pid: u32, depth: u8) -> bool {
    if depth > 4 {
        return false;
    }

    let Ok(output) = std::process::Command::new("pgrep")
        .args(["-P", &pid.to_string()])
        .output()
    else {
        return false;
    };

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let child_pid = line.trim();
        if child_pid.is_empty() {
            continue;
        }

        if is_claude_process(child_pid) {
            return true;
        }

        if let Ok(cpid) = child_pid.parse::<u32>() {
            if has_claude_in_subtree(cpid, depth + 1) {
                return true;
            }
        }
    }

    false
}

/// Get the name of the foreground child process of a shell PID.
/// Walks the full process subtree to reliably detect Claude Code
/// even if it gets reparented or runs as a grandchild process.
fn foreground_child_name(shell_pid: u32) -> Option<String> {
    let pgrep = std::process::Command::new("pgrep")
        .args(["-P", &shell_pid.to_string()])
        .output()
        .ok()?;

    let pids_str = String::from_utf8_lossy(&pgrep.stdout);
    let child_pids: Vec<String> = pids_str
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    if child_pids.is_empty() {
        return None;
    }

    // Check entire subtree for claude (handles deep nesting / reparenting)
    if has_claude_in_subtree(shell_pid, 0) {
        return Some("claude".to_string());
    }

    // Fallback: return last direct child's basename
    let last_pid = child_pids.last()?;
    let comm = std::process::Command::new("ps")
        .args(["-o", "comm=", "-p", last_pid.as_str()])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    let basename = comm.rsplit('/').next().unwrap_or(&comm).to_string();
    if basename.is_empty() { None } else { Some(basename) }
}
