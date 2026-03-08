use std::io::{Read, Write};
use std::net::TcpListener;

use tauri::{Emitter, Manager};

const PORT: u16 = 21547;

/// Start a localhost-only HTTP server that accepts file-open requests from the CLI.
/// Runs on a dedicated thread. Emits `rally-cli-open-file` events to the frontend.
pub fn start(app_handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind(format!("127.0.0.1:{}", PORT)) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("CLI server failed to bind on port {}: {}", PORT, e);
                return;
            }
        };

        for stream in listener.incoming() {
            let mut stream = match stream {
                Ok(s) => s,
                Err(_) => continue,
            };

            let mut buf = [0u8; 8192];
            let n = match stream.read(&mut buf) {
                Ok(n) if n > 0 => n,
                _ => continue,
            };

            let request = String::from_utf8_lossy(&buf[..n]);

            if let Some(path) = parse_request(&request) {
                // Emit event to the focused window (or all windows)
                let focused = app_handle
                    .webview_windows()
                    .into_values()
                    .find(|w| w.is_focused().unwrap_or(false));

                if let Some(win) = &focused {
                    let _ = win.emit("rally-cli-open-file", &path);
                } else {
                    // No focused window — emit app-wide
                    let _ = app_handle.emit("rally-cli-open-file", &path);
                }

                // Bring the window to the foreground
                let target = focused
                    .or_else(|| app_handle.get_webview_window("main"));
                if let Some(win) = target {
                    let _ = win.show();
                    let _ = win.set_focus();
                }

                let response = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK";
                let _ = stream.write_all(response.as_bytes());
            } else {
                let body = "Bad Request";
                let response = format!(
                    "HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
            }
        }
    });
}

/// Parse an HTTP request to extract the file path.
/// Supports: POST /open with the absolute path as the body.
fn parse_request(request: &str) -> Option<String> {
    let first_line = request.lines().next()?;
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }

    let method = parts[0];
    let uri = parts[1];

    if uri != "/open" {
        return None;
    }

    if method == "POST" {
        // Body is after the blank line
        let body_start = request.find("\r\n\r\n").map(|i| i + 4)
            .or_else(|| request.find("\n\n").map(|i| i + 2))?;
        let body = request[body_start..].trim();
        if body.is_empty() || !body.starts_with('/') {
            return None;
        }
        Some(body.to_string())
    } else {
        None
    }
}
