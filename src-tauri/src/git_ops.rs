use std::sync::OnceLock;
use std::time::Duration;

use tokio::process::Command;

use crate::workspace::{ChangedFile, ChangesSummary, GitStatus, PrStatus, PushResult};

/// Get the full login shell PATH, cached for the process lifetime.
/// When launched as a .app bundle, macOS gives a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin).
/// Tools like `gh` installed via Homebrew (/opt/homebrew/bin) won't be found.
/// This resolves the full PATH from a login shell, just like pty_manager does for PTY sessions.
fn full_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        if let Ok(output) = std::process::Command::new(&shell)
            .args(["-lc", "echo $PATH"])
            .output()
        {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return path;
            }
        }
        // Fallback: current PATH (works when launched from terminal)
        std::env::var("PATH").unwrap_or_default()
    })
}

/// Run a git command in a given directory and return stdout (async)
pub async fn git_cmd(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .env("PATH", full_path())
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("git {} failed: {}", args.join(" "), stderr))
    }
}

/// Run gh CLI command in a given directory (async, with timeout for network ops)
async fn gh(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        Command::new("gh")
            .args(args)
            .env("PATH", full_path())
            .current_dir(cwd)
            .output(),
    )
    .await
    .map_err(|_| format!("gh {} timed out after 30s", args.join(" ")))?
    .map_err(|e| format!("Failed to run gh: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("gh {} failed: {}", args.join(" "), stderr))
    }
}

pub async fn status(cwd: &str, main_branch: &str) -> Result<GitStatus, String> {
    let branch = git_cmd(cwd, &["symbolic-ref", "--short", "HEAD"]).await?;

    let status_output = git_cmd(cwd, &["status", "--porcelain"]).await?;
    let modified: Vec<String> = status_output
        .lines()
        .filter(|l| !l.starts_with("??"))
        .map(|l| l[3..].to_string())
        .collect();
    let untracked: Vec<String> = status_output
        .lines()
        .filter(|l| l.starts_with("??"))
        .map(|l| l[3..].to_string())
        .collect();

    let dirty = !modified.is_empty() || !untracked.is_empty();

    // Count ahead/behind vs origin/<main_branch>
    let remote_ref = format!("HEAD...origin/{}", main_branch);
    let (ahead, behind) = match git_cmd(cwd, &["rev-list", "--left-right", "--count", &remote_ref]).await {
        Ok(counts) => {
            let parts: Vec<&str> = counts.split_whitespace().collect();
            if parts.len() == 2 {
                (
                    parts[0].parse().unwrap_or(0),
                    parts[1].parse().unwrap_or(0),
                )
            } else {
                (0, 0)
            }
        }
        Err(_) => (0, 0),
    };

    Ok(GitStatus {
        branch,
        dirty,
        ahead,
        behind,
        modified_files: modified,
        untracked_files: untracked,
    })
}

/// Sync: checkout main, pull, rebase branch on top
pub async fn sync(cwd: &str, branch: &str, main_branch: &str) -> Result<String, String> {
    git_cmd(cwd, &["checkout", main_branch]).await?;
    git_cmd(cwd, &["pull"]).await?;
    git_cmd(cwd, &["rebase", main_branch, branch]).await?;
    Ok(format!("Synced {} onto {}", branch, main_branch))
}

/// Rebase: stash, checkout main, pull, rebase, pop stash
pub async fn rebase(cwd: &str, branch: &str, main_branch: &str) -> Result<String, String> {
    git_cmd(cwd, &["checkout", branch]).await?;

    // Check if there are changes to stash
    let status = git_cmd(cwd, &["status", "--porcelain"]).await?;
    let has_changes = !status.is_empty();

    if has_changes {
        git_cmd(cwd, &["stash"]).await?;
    }

    git_cmd(cwd, &["checkout", main_branch]).await?;
    git_cmd(cwd, &["pull"]).await?;
    git_cmd(cwd, &["checkout", branch]).await?;

    if let Err(e) = git_cmd(cwd, &["rebase", main_branch]).await {
        return Err(format!("Rebase failed (resolve conflicts manually): {}", e));
    }

    if has_changes {
        if let Err(e) = git_cmd(cwd, &["stash", "pop"]).await {
            return Err(format!("Rebased successfully but stash pop had conflicts: {}", e));
        }
    }

    Ok(format!("Rebased {} onto {}", branch, main_branch))
}

/// Commit staged changes
pub async fn commit(cwd: &str, message: &str) -> Result<String, String> {
    git_cmd(cwd, &["add", "-u"]).await?;
    git_cmd(cwd, &["commit", "-m", message]).await
}

/// Push current branch with smart fallback:
/// 1. Try normal push
/// 2. If rejected (diverged after rebase) → force-with-lease
/// 3. If no upstream → set-upstream
pub async fn push(cwd: &str) -> Result<PushResult, String> {
    let branch = git_cmd(cwd, &["symbolic-ref", "--short", "HEAD"]).await?;

    // Try normal push first (with timeout for network ops)
    match tokio::time::timeout(
        Duration::from_secs(30),
        git_cmd(cwd, &["push"]),
    ).await {
        Ok(Ok(out)) => return Ok(PushResult {
            output: if out.is_empty() { format!("Pushed {} to origin", branch) } else { out },
            method: "push".to_string(),
        }),
        Ok(Err(e)) => {
            // Check if it's a diverged/rejected error (common after rebase)
            let err_lower = e.to_lowercase();
            if err_lower.contains("rejected")
                || err_lower.contains("non-fast-forward")
                || err_lower.contains("diverged")
                || err_lower.contains("failed to push")
            {
                // Try force-with-lease (safe force push)
                match git_cmd(cwd, &["push", "--force-with-lease"]).await {
                    Ok(out) => return Ok(PushResult {
                        output: if out.is_empty() {
                            format!("Force-pushed {} (with lease)", branch)
                        } else {
                            out
                        },
                        method: "force-with-lease".to_string(),
                    }),
                    Err(e2) => return Err(format!("Push --force-with-lease failed: {}", e2)),
                }
            }

            // Check if it's a no-upstream error
            if err_lower.contains("no upstream")
                || err_lower.contains("has no upstream")
                || err_lower.contains("set-upstream")
            {
                match git_cmd(cwd, &["push", "--set-upstream", "origin", &branch]).await {
                    Ok(out) => return Ok(PushResult {
                        output: if out.is_empty() {
                            format!("Pushed {} and set upstream", branch)
                        } else {
                            out
                        },
                        method: "set-upstream".to_string(),
                    }),
                    Err(e2) => return Err(format!("Push --set-upstream failed: {}", e2)),
                }
            }

            // Unknown push error
            Err(e)
        }
        Err(_) => Err("git push timed out after 30s".to_string()),
    }
}

/// Create a PR using gh CLI
pub async fn create_pr(cwd: &str, title: Option<&str>, body: Option<&str>) -> Result<String, String> {
    let mut args = vec!["pr", "create"];

    if let Some(t) = title {
        args.push("--title");
        args.push(t);
    }
    if let Some(b) = body {
        args.push("--body");
        args.push(b);
    }
    if title.is_none() && body.is_none() {
        args.push("--fill");
    }

    gh(cwd, &args).await
}

/// Get PR status for the current branch. Returns None-equivalent error if no PR exists.
pub async fn pr_status(cwd: &str) -> Result<PrStatus, String> {
    let json_str = gh(
        cwd,
        &[
            "pr", "view", "--json",
            "number,title,url,state,isDraft,mergeable,reviewDecision,statusCheckRollup",
        ],
    ).await?;

    let v: serde_json::Value =
        serde_json::from_str(&json_str).map_err(|e| format!("Failed to parse PR JSON: {}", e))?;

    // Parse statusCheckRollup into a summary status
    let checks_status = match v.get("statusCheckRollup") {
        Some(serde_json::Value::Array(checks)) if !checks.is_empty() => {
            let all_pass = checks
                .iter()
                .all(|c| c.get("conclusion").and_then(|v| v.as_str()) == Some("SUCCESS"));
            let any_fail = checks.iter().any(|c| {
                let conclusion = c.get("conclusion").and_then(|v| v.as_str()).unwrap_or("");
                conclusion == "FAILURE" || conclusion == "ERROR"
            });
            if any_fail {
                Some("fail".to_string())
            } else if all_pass {
                Some("pass".to_string())
            } else {
                Some("pending".to_string())
            }
        }
        _ => None,
    };

    Ok(PrStatus {
        number: v["number"].as_u64().unwrap_or(0) as u32,
        title: v["title"].as_str().unwrap_or("").to_string(),
        url: v["url"].as_str().unwrap_or("").to_string(),
        state: v["state"].as_str().unwrap_or("OPEN").to_string(),
        is_draft: v["isDraft"].as_bool().unwrap_or(false),
        mergeable: v["mergeable"].as_str().unwrap_or("UNKNOWN").to_string(),
        review_decision: v["reviewDecision"].as_str().map(|s| s.to_string()),
        checks_status,
    })
}

/// Merge a PR using gh CLI
pub async fn merge_pr(cwd: &str, method: &str) -> Result<String, String> {
    let method_flag = match method {
        "rebase" => "--rebase",
        "merge" => "--merge",
        _ => "--squash", // default to squash
    };

    gh(cwd, &["pr", "merge", method_flag]).await
}

/// Get detailed changes: staged, unstaged, and untracked files.
/// Parses `git status --porcelain` two-column format.
/// NOTE: Cannot use git_cmd() here because it trims output, which strips
/// the leading space that distinguishes unstaged-only files (e.g. " M file").
pub async fn changes(cwd: &str) -> Result<ChangesSummary, String> {
    let raw = Command::new("git")
        .args(&["status", "--porcelain"])
        .env("PATH", full_path())
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("Failed to run git status: {}", e))?;
    if !raw.status.success() {
        let stderr = String::from_utf8_lossy(&raw.stderr).trim().to_string();
        return Err(format!("git status --porcelain failed: {}", stderr));
    }
    let output = String::from_utf8_lossy(&raw.stdout).to_string();
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();

    for line in output.lines() {
        if line.len() < 3 { continue; }
        let index_status = line.chars().nth(0).unwrap_or(' ');
        let work_status = line.chars().nth(1).unwrap_or(' ');
        let path = line[3..].to_string();

        if index_status == '?' {
            untracked.push(path);
            continue;
        }

        // Staged changes (index column)
        if index_status != ' ' && index_status != '?' {
            staged.push(ChangedFile {
                path: path.clone(),
                status: index_status.to_string(),
            });
        }

        // Unstaged changes (working tree column)
        if work_status != ' ' && work_status != '?' {
            unstaged.push(ChangedFile {
                path: path.clone(),
                status: work_status.to_string(),
            });
        }
    }

    Ok(ChangesSummary { staged, unstaged, untracked })
}

/// Get file content at HEAD revision.
pub async fn file_at_head(cwd: &str, file_path: &str) -> Result<String, String> {
    // Get relative path from repo root
    let repo_root = git_cmd(cwd, &["rev-parse", "--show-toplevel"]).await?;
    let full_path = if file_path.starts_with('/') {
        file_path.to_string()
    } else {
        format!("{}/{}", cwd, file_path)
    };
    let rel = full_path
        .strip_prefix(&repo_root)
        .unwrap_or(&full_path)
        .trim_start_matches('/');
    let spec = format!("HEAD:{}", rel);
    git_cmd(cwd, &["show", &spec]).await
}

/// Stage a file.
pub async fn stage_file(cwd: &str, file_path: &str) -> Result<(), String> {
    git_cmd(cwd, &["add", "--", file_path]).await?;
    Ok(())
}

/// Unstage a file.
pub async fn unstage_file(cwd: &str, file_path: &str) -> Result<(), String> {
    if git_cmd(cwd, &["restore", "--staged", "--", file_path]).await.is_err() {
        // Fallback for older git versions without `restore`.
        git_cmd(cwd, &["reset", "HEAD", "--", file_path]).await?;
    }
    Ok(())
}

/// Discard local changes for a file.
/// - Tracked file: restore working tree from index/HEAD
/// - Untracked file: remove from working tree
pub async fn discard_file(cwd: &str, file_path: &str, is_untracked: bool) -> Result<(), String> {
    if is_untracked {
        git_cmd(cwd, &["clean", "-f", "--", file_path]).await?;
        return Ok(());
    }

    if git_cmd(cwd, &["restore", "--", file_path]).await.is_err() {
        // Fallback for older git versions without `restore`.
        git_cmd(cwd, &["checkout", "--", file_path]).await?;
    }
    Ok(())
}

/// Apply a patch via stdin to `git apply`.
/// `reverse` = true for reverting changes, `cached` = true for staging hunks.
pub async fn apply_patch(cwd: &str, patch: &str, reverse: bool, cached: bool) -> Result<String, String> {
    let mut args = vec!["apply"];
    if reverse {
        args.push("--reverse");
    }
    if cached {
        args.push("--cached");
    }
    let mut child = tokio::process::Command::new("git")
        .args(&args)
        .env("PATH", full_path())
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn git apply: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        stdin
            .write_all(patch.as_bytes())
            .await
            .map_err(|e| format!("Failed to write patch to stdin: {}", e))?;
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("Failed to wait for git apply: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git apply failed: {}", stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Get unified diff output for staged or unstaged changes.
pub async fn diff(cwd: &str, staged: bool) -> Result<String, String> {
    let mut args = vec!["diff", "--unified=3"];
    if staged {
        args.push("--cached");
    }
    let output = tokio::process::Command::new("git")
        .args(&args)
        .env("PATH", full_path())
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("Failed to run git diff: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("git diff failed: {}", stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Get total line additions and deletions across staged and unstaged changes.
pub async fn diff_stat(cwd: &str) -> Result<(i64, i64), String> {
    let mut total_add: i64 = 0;
    let mut total_del: i64 = 0;

    for args in [&["diff", "--numstat"][..], &["diff", "--cached", "--numstat"][..]] {
        let output = Command::new("git")
            .args(args)
            .env("PATH", full_path())
            .current_dir(cwd)
            .output()
            .await
            .map_err(|e| format!("Failed to run git diff --numstat: {}", e))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 2 {
                if let (Ok(a), Ok(d)) = (parts[0].parse::<i64>(), parts[1].parse::<i64>()) {
                    total_add += a;
                    total_del += d;
                }
            }
        }
    }

    Ok((total_add, total_del))
}

/// Commit only what's currently staged (no auto-add).
pub async fn commit_staged(cwd: &str, message: &str) -> Result<String, String> {
    git_cmd(cwd, &["commit", "-m", message]).await
}

// ---------------------------------------------------------------------------
// Smart PR creation & merge
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
pub struct CreatePrResult {
    pub pr_number: u32,
    pub pr_url: String,
    pub title: String,
    pub branch: String,
    pub committed: bool,
    pub branch_created: bool,
}

/// Smart PR creation: handles branch creation, committing, pushing, and PR creation.
pub async fn create_pr_smart(cwd: &str, main_branch: &str) -> Result<CreatePrResult, String> {
    let mut branch = git_cmd(cwd, &["symbolic-ref", "--short", "HEAD"]).await?;
    let mut committed = false;
    let mut branch_created = false;

    // If on main, create a feature branch
    if branch == main_branch {
        let diff_stat = git_cmd(cwd, &["diff", "--stat", "HEAD"]).await
            .unwrap_or_default();
        let branch_name = generate_branch_name(&diff_stat);
        git_cmd(cwd, &["checkout", "-b", &branch_name]).await?;
        branch = branch_name;
        branch_created = true;
    }

    // If dirty, commit all changes
    let status_output = git_cmd(cwd, &["status", "--porcelain"]).await?;
    if !status_output.is_empty() {
        git_cmd(cwd, &["add", "-A"]).await?;
        let diff_stat = git_cmd(cwd, &["diff", "--cached", "--stat"]).await?;
        let msg = generate_commit_message(&diff_stat);
        git_cmd(cwd, &["commit", "-m", &msg]).await?;
        committed = true;
    }

    // Push
    push(cwd).await?;

    // Create PR
    let pr_url = create_pr(cwd, None, None).await?;

    // Parse PR number from URL (e.g., "https://github.com/org/repo/pull/42")
    let pr_number = pr_url
        .rsplit('/')
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);

    // Get PR title
    let title = match pr_status(cwd).await {
        Ok(status) => status.title,
        Err(_) => String::new(),
    };

    Ok(CreatePrResult {
        pr_number,
        pr_url,
        title,
        branch,
        committed,
        branch_created,
    })
}

fn generate_branch_name(diff_stat: &str) -> String {
    let first_file = diff_stat
        .lines()
        .next()
        .and_then(|l| l.split('|').next())
        .map(|s| s.trim())
        .unwrap_or("changes");
    let sanitized: String = first_file
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_lowercase();
    let short = if sanitized.len() > 40 { &sanitized[..40] } else { &sanitized };
    format!("feat/{}", short.trim_end_matches('-'))
}

fn generate_commit_message(diff_stat: &str) -> String {
    let file_count = diff_stat.lines().count().saturating_sub(1);
    if file_count <= 3 {
        let files: Vec<&str> = diff_stat
            .lines()
            .take(file_count)
            .filter_map(|l| l.split('|').next().map(|s| s.trim()))
            .collect();
        format!("Update {}", files.join(", "))
    } else {
        format!("Update {} files", file_count)
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MergePrResult {
    pub pr_number: u32,
    pub branch: String,
    pub synced: bool,
}

/// Smart PR merge: squash-merge via gh, then sync feature branch to main.
pub async fn merge_pr_smart(cwd: &str, main_branch: &str) -> Result<MergePrResult, String> {
    let branch = git_cmd(cwd, &["symbolic-ref", "--short", "HEAD"]).await?;

    if branch == main_branch {
        return Err("Cannot merge: currently on main branch".to_string());
    }

    // Get PR info before merging
    let pr = pr_status(cwd).await?;
    if pr.state != "OPEN" {
        return Err(format!("PR #{} is not open (state: {})", pr.number, pr.state));
    }

    // Squash merge
    merge_pr(cwd, "squash").await?;

    // Sync: checkout main, pull, switch back, rebase, force-push
    let synced = match sync_branch_after_merge(cwd, &branch, main_branch).await {
        Ok(_) => true,
        Err(e) => {
            eprintln!("Post-merge sync failed (PR was merged successfully): {}", e);
            false
        }
    };

    Ok(MergePrResult {
        pr_number: pr.number,
        branch,
        synced,
    })
}

async fn sync_branch_after_merge(cwd: &str, branch: &str, main_branch: &str) -> Result<(), String> {
    git_cmd(cwd, &["checkout", main_branch]).await?;
    git_cmd(cwd, &["pull"]).await?;
    git_cmd(cwd, &["checkout", branch]).await?;

    let count_str = git_cmd(cwd, &["rev-list", "--count", &format!("{}..HEAD", main_branch)]).await?;
    let ahead: u32 = count_str.trim().parse().unwrap_or(0);

    if ahead > 0 {
        git_cmd(cwd, &["reset", &format!("HEAD~{}", ahead)]).await?;
        git_cmd(cwd, &["checkout", "."]).await?;
        git_cmd(cwd, &["rebase", main_branch]).await?;
    }

    git_cmd(cwd, &["push", "--force-with-lease"]).await?;

    Ok(())
}
