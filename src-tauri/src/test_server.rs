//! HTTP test server for driving Rally from automated tests.
//!
//! Only compiled when the `test-bridge` feature is enabled.
//!
//! ## Architecture
//!
//! The test server on port 9876 receives commands from the test client,
//! eval's JavaScript in the WebView, and returns results.
//!
//! Since Tauri's `eval()` is fire-and-forget, we use Tauri events as
//! the return path:
//!
//! 1. Client POSTs to /eval with `{"js": "..."}`
//! 2. Server evals wrapped JS in the WebView
//! 3. JS calls `__TAURI__.event.emit("test-bridge-result", {id, payload})`
//! 4. Rust event listener forwards to the pending channel
//! 5. /eval handler unblocks and responds

#[cfg(feature = "test-bridge")]
mod inner {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use tauri::Listener;
    use tauri::Manager;

    pub type ResultSenders =
        Arc<Mutex<HashMap<String, std::sync::mpsc::Sender<serde_json::Value>>>>;

    static APP_READY: AtomicBool = AtomicBool::new(false);

    pub fn mark_ready() {
        APP_READY.store(true, Ordering::SeqCst);
    }

    /// Set up event listener for test bridge results.
    pub fn setup_listener(app_handle: &tauri::AppHandle, pending: ResultSenders) {
        app_handle.listen("test-bridge-result", move |event| {
            let payload_str = event.payload();
            let parsed: serde_json::Value =
                match serde_json::from_str(payload_str) {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("[test-bridge] bad result payload: {}", e);
                        return;
                    }
                };

            let id = match parsed.get("id").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => {
                    eprintln!("[test-bridge] result missing 'id'");
                    return;
                }
            };

            let result = parsed
                .get("payload")
                .cloned()
                .unwrap_or(serde_json::json!({"error": "missing payload"}));

            if let Some(tx) = pending.lock().unwrap().remove(&id) {
                let _ = tx.send(result);
            }
        });
    }

    pub fn start(app_handle: tauri::AppHandle, pending: ResultSenders) {
        std::thread::spawn(move || {
            let server = match tiny_http::Server::http("127.0.0.1:9876") {
                Ok(s) => Arc::new(s),
                Err(e) => {
                    eprintln!("[test-bridge] Failed to start on :9876: {}", e);
                    return;
                }
            };
            eprintln!("[test-bridge] Listening on http://127.0.0.1:9876");

            let mut workers = Vec::new();
            for _ in 0..4 {
                let server = server.clone();
                let app = app_handle.clone();
                let pending = pending.clone();

                workers.push(std::thread::spawn(move || {
                    loop {
                        let mut request = match server.recv() {
                            Ok(req) => req,
                            Err(_) => break,
                        };

                        let url = request.url().to_string();
                        let method = request.method().as_str().to_uppercase();

                        let response =
                            route(&method, &url, &app, &pending, &mut request);

                        if let Err(e) = request.respond(response) {
                            eprintln!("[test-bridge] respond error: {}", e);
                        }
                    }
                }));
            }

            for w in workers {
                let _ = w.join();
            }
        });
    }

    fn route(
        method: &str,
        url: &str,
        app: &tauri::AppHandle,
        pending: &ResultSenders,
        request: &mut tiny_http::Request,
    ) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
        match (method, url) {
            ("GET", "/health") => {
                let ready = APP_READY.load(Ordering::SeqCst);
                ok_json(&format!(r#"{{"ready":{}}}"#, ready))
            }
            ("POST", "/eval") => handle_eval(app, pending, request),
            ("POST", "/invoke") => handle_invoke(app, pending, request),
            _ => err_json(404, &format!("not found: {} {}", method, url)),
        }
    }

    fn read_body(request: &mut tiny_http::Request) -> Result<String, String> {
        let mut body = String::new();
        request
            .as_reader()
            .read_to_string(&mut body)
            .map_err(|e| format!("read body: {}", e))?;
        Ok(body)
    }

    fn handle_eval(
        app: &tauri::AppHandle,
        pending: &ResultSenders,
        request: &mut tiny_http::Request,
    ) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
        let body = match read_body(request) {
            Ok(b) => b,
            Err(e) => return err_json(400, &e),
        };

        let parsed: serde_json::Value = match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(e) => return err_json(400, &format!("bad json: {}", e)),
        };

        let js = match parsed.get("js").and_then(|v| v.as_str()) {
            Some(s) => s.to_string(),
            None => return err_json(400, "missing 'js' field"),
        };

        let window = match app.get_webview_window("main") {
            Some(w) => w,
            None => return err_json(500, "no main window"),
        };

        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = std::sync::mpsc::channel();
        pending.lock().unwrap().insert(id.clone(), tx);

        // Wrap user JS: execute and emit result via Tauri event
        let wrapped = format!(
            r#"(async()=>{{try{{const __r=await(async()=>{{{js}}})();window.__TAURI__.event.emit("test-bridge-result",{{id:"{id}",payload:{{result:__r}}}})}}catch(e){{window.__TAURI__.event.emit("test-bridge-result",{{id:"{id}",payload:{{error:e.message||String(e)}}}})}}}})();"#,
            js = js,
            id = id,
        );

        if let Err(e) = window.eval(&wrapped) {
            pending.lock().unwrap().remove(&id);
            return err_json(500, &format!("eval failed: {}", e));
        }

        match rx.recv_timeout(Duration::from_secs(30)) {
            Ok(val) => ok_json(&val.to_string()),
            Err(_) => {
                pending.lock().unwrap().remove(&id);
                err_json(504, "eval timed out (30s)")
            }
        }
    }

    fn handle_invoke(
        app: &tauri::AppHandle,
        pending: &ResultSenders,
        request: &mut tiny_http::Request,
    ) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
        let body = match read_body(request) {
            Ok(b) => b,
            Err(e) => return err_json(400, &e),
        };

        let parsed: serde_json::Value = match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(e) => return err_json(400, &format!("bad json: {}", e)),
        };

        let command = match parsed.get("command").and_then(|v| v.as_str()) {
            Some(s) => s.to_string(),
            None => return err_json(400, "missing 'command' field"),
        };

        let args = parsed
            .get("args")
            .cloned()
            .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));

        let window = match app.get_webview_window("main") {
            Some(w) => w,
            None => return err_json(500, "no main window"),
        };

        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = std::sync::mpsc::channel();
        pending.lock().unwrap().insert(id.clone(), tx);

        let args_str = args.to_string();
        let invoke_js = format!(
            r#"(async()=>{{try{{const r=await window.__TAURI__.core.invoke("{cmd}",{args});window.__TAURI__.event.emit("test-bridge-result",{{id:"{id}",payload:{{result:r}}}})}}catch(e){{window.__TAURI__.event.emit("test-bridge-result",{{id:"{id}",payload:{{error:e.message||String(e)}}}})}}}})();"#,
            cmd = command,
            args = args_str,
            id = id,
        );

        if let Err(e) = window.eval(&invoke_js) {
            pending.lock().unwrap().remove(&id);
            return err_json(500, &format!("eval failed: {}", e));
        }

        match rx.recv_timeout(Duration::from_secs(30)) {
            Ok(val) => ok_json(&val.to_string()),
            Err(_) => {
                pending.lock().unwrap().remove(&id);
                err_json(504, "invoke timed out (30s)")
            }
        }
    }

    fn ok_json(body: &str) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
        tiny_http::Response::from_string(body)
            .with_status_code(200)
            .with_header(ct_json())
    }

    fn err_json(
        status: u16,
        msg: &str,
    ) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
        let body = serde_json::json!({"error": msg}).to_string();
        tiny_http::Response::from_string(body)
            .with_status_code(status)
            .with_header(ct_json())
    }

    fn ct_json() -> tiny_http::Header {
        "Content-Type: application/json"
            .parse::<tiny_http::Header>()
            .unwrap()
    }
}

#[cfg(feature = "test-bridge")]
pub use inner::{mark_ready, setup_listener, start, ResultSenders};
