//! Resolve the user's *real* shell PATH and locate binaries on it.
//!
//! When Rally is launched from Finder/Dock/Spotlight, macOS gives the process a
//! minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin` plus `path_helper` entries).
//! Homebrew's `/opt/homebrew/bin` is not in it, so `gh`, `node`, etc. are invisible.
//!
//! The previous approach (`$SHELL -lc 'echo $PATH'`) was subtly wrong: `-lc` is a
//! *login, non-interactive* shell, and zsh only sources `~/.zshrc` for
//! **interactive** shells. Most people (including this project's users) add
//! Homebrew to PATH in `.zshrc`, so the probe returned a PATH without it. The
//! failure was invisible: `git` still resolved (`/usr/bin/git` ships with macOS)
//! while `gh` did not, so PR status silently failed forever while everything
//! else worked — and it "worked on my machine" whenever Rally was launched from
//! a terminal, because the child shell then inherited an already-good PATH.
//!
//! Strategy, in order:
//!   1. Probe an **interactive** login shell (`-ilc`) with sentinel markers, so
//!      rc-file noise (banners, `echo`s from plugins) can't corrupt the result.
//!   2. Fall back to a non-interactive login shell (`-lc`).
//!   3. Fall back to the process's own PATH.
//!   4. Always union in well-known tool directories that exist on disk, so a
//!      broken/slow/exotic shell config can never hide Homebrew again.

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const SENTINEL_START: &str = "__RALLY_PATH_START__";
const SENTINEL_END: &str = "__RALLY_PATH_END__";

/// Interactive rc files can be slow (nvm, pyenv, conda…). Cap the probe so a
/// pathological shell config can't wedge startup; the fallbacks still apply.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Directories that must be searched even if the shell probe misses them.
/// `$HOME` is substituted for a leading `~`.
const WELL_KNOWN_DIRS: &[&str] = &[
    "~/.rally/bin",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "~/.local/bin",
    "~/.cargo/bin",
    "~/.bun/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

/// The resolved PATH, computed once per process.
pub fn full_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(compute_full_path)
}

/// Compute the PATH eagerly on a background thread so the first git/gh call
/// doesn't pay for a slow interactive rc file (and doesn't block a tokio worker).
pub fn warm() {
    std::thread::spawn(|| {
        let _ = full_path();
    });
}

fn compute_full_path() -> String {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let probed = probe_shell_path(&shell, true)
        .or_else(|| probe_shell_path(&shell, false))
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();
    merge_paths(&probed, WELL_KNOWN_DIRS, &home, |p| Path::new(p).is_dir())
}

/// Run `<shell> -ilc` (or `-lc`) and extract the PATH printed between sentinels.
/// Returns None on spawn failure, timeout, or unparseable output.
fn probe_shell_path(shell: &str, interactive: bool) -> Option<String> {
    let flags = if interactive { "-ilc" } else { "-lc" };
    let script = format!("printf '%s%s%s' '{SENTINEL_START}' \"$PATH\" '{SENTINEL_END}'");

    let mut child = Command::new(shell)
        .args([flags, &script])
        // An interactive shell with an inherited stdin can block on job control
        // or read from the terminal; give it nothing to read.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let deadline = Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return None,
        }
    }

    let output = child.wait_with_output().ok()?;
    parse_sentinel_path(&String::from_utf8_lossy(&output.stdout))
}

/// Pull the PATH out of sentinel-delimited shell output, ignoring anything an
/// rc file printed before or after it.
fn parse_sentinel_path(stdout: &str) -> Option<String> {
    let start = stdout.find(SENTINEL_START)? + SENTINEL_START.len();
    let rest = &stdout[start..];
    let end = rest.find(SENTINEL_END)?;
    let path = rest[..end].trim();
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

/// Union `base` (colon-separated) with `extra` dirs, preserving order, dropping
/// duplicates and empty segments. `~` in `extra` is expanded with `home`.
/// `exists` decides whether an extra dir is worth appending (injected for tests).
fn merge_paths(
    base: &str,
    extra: &[&str],
    home: &str,
    exists: impl Fn(&str) -> bool,
) -> String {
    let mut out: Vec<String> = Vec::new();
    let push = |dir: String, out: &mut Vec<String>| {
        if dir.is_empty() || out.iter().any(|d| d == &dir) {
            return;
        }
        out.push(dir);
    };

    for dir in base.split(':') {
        push(dir.trim().to_string(), &mut out);
    }
    for dir in extra {
        let expanded = match dir.strip_prefix("~/") {
            Some(rest) if !home.is_empty() => format!("{}/{}", home.trim_end_matches('/'), rest),
            Some(_) => continue,
            None => (*dir).to_string(),
        };
        if exists(&expanded) {
            push(expanded, &mut out);
        }
    }
    out.join(":")
}

/// Locate an executable on the resolved PATH.
///
/// Returns an explicit error instead of falling back to the bare name: a bare
/// name makes the OS retry the lookup against the *process's* minimal PATH and
/// fail with a generic ENOENT ("No such file or directory"), which is what made
/// the missing-`gh` failure so hard to diagnose.
pub fn resolve_bin(name: &str) -> Result<String, String> {
    let path = full_path();
    for dir in path.split(':') {
        if dir.is_empty() {
            continue;
        }
        let candidate = format!("{}/{}", dir.trim_end_matches('/'), name);
        if is_executable(&candidate) {
            return Ok(candidate);
        }
    }
    Err(format!(
        "`{name}` not found on PATH. Rally resolved PATH as: {path}. \
         If {name} is installed (e.g. via Homebrew), make sure its directory is \
         exported from your shell profile."
    ))
}

fn is_executable(candidate: &str) -> bool {
    let p = Path::new(candidate);
    if !p.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return p
            .metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
    }
    #[cfg(not(unix))]
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_path_between_sentinels() {
        let out = format!("plugin banner\n{SENTINEL_START}/a:/b{SENTINEL_END}");
        assert_eq!(parse_sentinel_path(&out).unwrap(), "/a:/b");
    }

    #[test]
    fn ignores_rc_noise_after_sentinel() {
        let out = format!("{SENTINEL_START}/a{SENTINEL_END}\nnvm: something\n");
        assert_eq!(parse_sentinel_path(&out).unwrap(), "/a");
    }

    #[test]
    fn rejects_output_without_sentinels() {
        assert!(parse_sentinel_path("/usr/bin:/bin").is_none());
        assert!(parse_sentinel_path("").is_none());
    }

    #[test]
    fn rejects_empty_path_between_sentinels() {
        let out = format!("{SENTINEL_START}{SENTINEL_END}");
        assert!(parse_sentinel_path(&out).is_none());
    }

    #[test]
    fn merge_appends_missing_well_known_dirs() {
        // The exact regression: a login-shell PATH without Homebrew.
        let base = "/usr/bin:/bin";
        let merged = merge_paths(base, &["/opt/homebrew/bin"], "/Users/x", |_| true);
        assert_eq!(merged, "/usr/bin:/bin:/opt/homebrew/bin");
    }

    #[test]
    fn merge_does_not_duplicate_existing_dirs() {
        let merged = merge_paths(
            "/opt/homebrew/bin:/usr/bin",
            &["/opt/homebrew/bin", "/usr/bin"],
            "/Users/x",
            |_| true,
        );
        assert_eq!(merged, "/opt/homebrew/bin:/usr/bin");
    }

    #[test]
    fn merge_skips_nonexistent_dirs() {
        let merged = merge_paths("/usr/bin", &["/opt/homebrew/bin"], "/Users/x", |_| false);
        assert_eq!(merged, "/usr/bin");
    }

    #[test]
    fn merge_expands_tilde_with_home() {
        let merged = merge_paths("/usr/bin", &["~/.local/bin"], "/Users/x", |_| true);
        assert_eq!(merged, "/usr/bin:/Users/x/.local/bin");
    }

    #[test]
    fn merge_skips_tilde_when_home_unknown() {
        let merged = merge_paths("/usr/bin", &["~/.local/bin"], "", |_| true);
        assert_eq!(merged, "/usr/bin");
    }

    #[test]
    fn merge_drops_empty_segments() {
        let merged = merge_paths("/usr/bin::/bin:", &[], "/Users/x", |_| true);
        assert_eq!(merged, "/usr/bin:/bin");
    }

    #[test]
    fn resolve_bin_errors_mention_the_resolved_path() {
        let err = resolve_bin("definitely-not-a-real-binary-xyz").unwrap_err();
        assert!(err.contains("not found on PATH"));
        assert!(err.contains("definitely-not-a-real-binary-xyz"));
    }

    #[test]
    fn resolve_bin_finds_a_system_binary() {
        // /bin/sh exists on every supported platform and is in WELL_KNOWN_DIRS.
        assert!(resolve_bin("sh").is_ok());
    }
}
