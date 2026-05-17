use std::io::{Read, Write};
use std::net::TcpListener;

use tauri::{Emitter, Manager};

use crate::parked_threads::{self, ParkInput};

const PORT: u16 = 21547;

/// Start a localhost-only HTTP server that accepts requests from the CLI and
/// from the rally-park Claude skill. Runs on a dedicated thread.
///
/// Routes:
///   POST /open  — body = absolute path; emits `rally-cli-open-file`
///   POST /park  — body = JSON ParkInput; appends to parked DB; emits `rally-thread-parked`
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

            match parse_route(&request) {
                Some(Route::Open(path)) => {
                    handle_open(&app_handle, &path);
                    write_ok(&mut stream);
                }
                Some(Route::Park(body)) => match handle_park(&app_handle, &body) {
                    Ok(json) => write_json(&mut stream, &json),
                    Err(msg) => write_bad_request(&mut stream, &msg),
                },
                None => {
                    write_bad_request(&mut stream, "Bad Request");
                }
            }
        }
    });
}

enum Route {
    Open(String),
    Park(String),
}

fn parse_route(request: &str) -> Option<Route> {
    let first_line = request.lines().next()?;
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }
    let method = parts[0];
    let uri = parts[1];
    if method != "POST" {
        return None;
    }

    let body = extract_body(request)?;

    match uri {
        "/open" => {
            let trimmed = body.trim();
            if trimmed.is_empty() || !trimmed.starts_with('/') {
                return None;
            }
            Some(Route::Open(trimmed.to_string()))
        }
        "/park" => Some(Route::Park(body.to_string())),
        _ => None,
    }
}

fn extract_body(request: &str) -> Option<&str> {
    let body_start = request
        .find("\r\n\r\n")
        .map(|i| i + 4)
        .or_else(|| request.find("\n\n").map(|i| i + 2))?;
    Some(&request[body_start..])
}

fn handle_open(app_handle: &tauri::AppHandle, path: &str) {
    let focused = app_handle
        .webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false));

    if let Some(win) = &focused {
        let _ = win.emit("rally-cli-open-file", path);
    } else {
        let _ = app_handle.emit("rally-cli-open-file", path);
    }

    let target = focused.or_else(|| app_handle.get_webview_window("main"));
    if let Some(win) = target {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn handle_park(app_handle: &tauri::AppHandle, body: &str) -> Result<String, String> {
    let input: ParkInput = serde_json::from_str(body.trim())
        .map_err(|e| format!("invalid JSON: {}", e))?;

    if input.repo.is_empty() || input.branch.is_empty() {
        return Err("repo and branch required".to_string());
    }

    let thread = parked_threads::append(input)?;
    let _ = app_handle.emit("rally-thread-parked", &thread);

    serde_json::to_string(&thread).map_err(|e| e.to_string())
}

fn write_ok(stream: &mut std::net::TcpStream) {
    let response = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK";
    let _ = stream.write_all(response.as_bytes());
}

fn write_json(stream: &mut std::net::TcpStream, json: &str) {
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        json.len(),
        json
    );
    let _ = stream.write_all(response.as_bytes());
}

fn write_bad_request(stream: &mut std::net::TcpStream, msg: &str) {
    let response = format!(
        "HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        msg.len(),
        msg
    );
    let _ = stream.write_all(response.as_bytes());
}
