//! Main-thread hang watchdog.
//!
//! Rally has frozen solid (beachball, no recovery) with the main thread
//! blocked inside AppKit, where nothing in the app can log. When that
//! happens the only evidence is a stack sample taken while it is stuck, and
//! a force-quit destroys it. This thread pings the main thread every few
//! seconds; if a ping goes unanswered for `STALL`, it samples Rally and its
//! WebKit content processes into `~/.rally/hangs/` once per hang, so every
//! freeze leaves a report behind.

use std::path::PathBuf;
use std::process::Command;
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const PING_EVERY: Duration = Duration::from_secs(2);
/// Long enough that a slow-but-alive main thread (a big layout) never counts.
/// A native menu or dialog held open this long can also trip it; the log's
/// "recovered after" line tells those apart from a real freeze.
const STALL: Duration = Duration::from_secs(8);
const SAMPLE_SECONDS: &str = "3";
/// WebKit content processes launched within this window of Rally's start
/// belong to Rally's windows (they are children of launchd, not Rally).
const WEBKIT_START_WINDOW_SECS: i64 = 30;

pub fn start(app: tauri::AppHandle) {
    #[cfg(feature = "test-bridge")]
    listen_for_debug_block(&app);
    let started = SystemTime::now();
    std::thread::Builder::new()
        .name("rally-hang-watchdog".into())
        .spawn(move || loop {
            std::thread::sleep(PING_EVERY);
            let (tx, rx) = mpsc::channel::<()>();
            if app.run_on_main_thread(move || {
                let _ = tx.send(());
            }).is_err()
            {
                return; // event loop gone: app is exiting
            }
            let sent = Instant::now();
            if rx.recv_timeout(STALL).is_ok() {
                continue;
            }
            let report = capture(started);
            match &report {
                Ok(path) => log(&format!("main thread unresponsive for {}s; report {}", STALL.as_secs(), path.display())),
                Err(e) => log(&format!("main thread unresponsive for {}s; report failed: {e}", STALL.as_secs())),
            }
            // One report per hang: wait for this ping to be answered (or the
            // app to die) before arming again.
            let _ = rx.recv();
            log(&format!("main thread recovered after {}s", sent.elapsed().as_secs()));
        })
        .expect("spawn hang watchdog");
}

/// Append to `~/.rally/hangs/log.txt` (and stderr). A freeze that ends in a
/// force-quit has an "unresponsive" line with no "recovered" after it.
fn log(line: &str) {
    eprintln!("[rally] {line}");
    let Ok(dir) = hangs_dir() else { return };
    let now = Command::new("/bin/date").arg("+%F %T").output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("log.txt")) {
        use std::io::Write;
        let _ = writeln!(f, "{now} pid {} {line}", std::process::id());
    }
}

/// Test-bridge only: the `rally-debug-block-main` event (payload: seconds)
/// blocks the main thread so the watchdog can be exercised end to end.
#[cfg(feature = "test-bridge")]
fn listen_for_debug_block(app: &tauri::AppHandle) {
    use tauri::Listener;
    let handle = app.clone();
    app.listen("rally-debug-block-main", move |event| {
        let seconds: u64 = event.payload().trim_matches('"').parse().unwrap_or(10);
        let _ = handle.run_on_main_thread(move || std::thread::sleep(Duration::from_secs(seconds)));
    });
}

fn hangs_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let dir = PathBuf::from(home).join(".rally").join("hangs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn capture(started: SystemTime) -> Result<PathBuf, String> {
    let dir = hangs_dir()?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let pid = std::process::id();

    let mut targets = vec![("rally".to_string(), pid)];
    targets.extend(webkit_processes(started));

    // Sample everything in parallel so the snapshots show the same moment.
    let children: Vec<_> = targets
        .iter()
        .filter_map(|(name, p)| {
            let file = dir.join(format!("hang-{stamp}-{name}-{p}.txt"));
            Command::new("/usr/bin/sample")
                .args([&p.to_string(), SAMPLE_SECONDS, "-file"])
                .arg(&file)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .ok()
        })
        .collect();
    for mut child in children {
        let _ = child.wait();
    }
    Ok(dir.join(format!("hang-{stamp}-rally-{pid}.txt")))
}

/// WebKit helper processes (WebContent, GPU, Networking) whose start time is
/// within `WEBKIT_START_WINDOW_SECS` of Rally's own start.
fn webkit_processes(started: SystemTime) -> Vec<(String, u32)> {
    let rally_start = started.duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let Ok(out) = Command::new("/bin/ps").args(["-axo", "pid=,lstart=,comm="]).env("LC_ALL", "C").output() else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid: u32 = parts.next()?.parse().ok()?;
            // lstart is 5 fields: "Mon Sep 28 23:02:32 2026"
            let lstart: Vec<&str> = parts.by_ref().take(5).collect();
            let comm = parts.collect::<Vec<_>>().join(" ");
            let name = ["WebContent", "GPU", "Networking"]
                .into_iter()
                .find(|n| comm.contains(&format!("com.apple.WebKit.{n}")))?;
            let start = parse_lstart(&lstart)?;
            ((start - rally_start).abs() <= WEBKIT_START_WINDOW_SECS).then(|| (format!("webkit-{}", name.to_lowercase()), pid))
        })
        .collect()
}

/// Parse `ps` lstart ("Mon Sep 28 23:02:32 2026", local time) to a Unix
/// timestamp via `date`, which knows the local zone.
fn parse_lstart(fields: &[&str]) -> Option<i64> {
    if fields.len() != 5 {
        return None;
    }
    let out = Command::new("/bin/date")
        .args(["-j", "-f", "%a %b %d %T %Y", &fields.join(" "), "+%s"])
        .env("LC_ALL", "C")
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}
