use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tokio::process::Command;
use tokio::sync::Semaphore;

use crate::shell_env::{full_path, resolve_bin};
use crate::workspace::{ChangedFile, ChangesSummary, CommitEntry, GitStatus, PrComment, PrCommit, PrDetails, PrReview, PrStatus, PushResult};

/// Per-repo semaphore to serialize git operations.
/// Prevents Rally's background polls (status, fetch, PR) from running
/// concurrently on the same repo, which causes index.lock conflicts.
/// Permits = 1 means only one git operation per repo at a time.
fn repo_semaphore(cwd: &str) -> std::sync::Arc<Semaphore> {
    static REPO_LOCKS: OnceLock<Mutex<HashMap<String, std::sync::Arc<Semaphore>>>> = OnceLock::new();
    let map = REPO_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap();
    guard.entry(cwd.to_string())
        .or_insert_with(|| std::sync::Arc::new(Semaphore::new(1)))
        .clone()
}

/// Run a git command without the per-repo lock. Used internally.
async fn git_cmd_unlocked(cwd: &str, args: &[&str]) -> Result<String, String> {
    // kill_on_drop: callers wrap git_cmd in timeouts (e.g. fetch); when the
    // timeout drops this future the child must die with it, not linger as an
    // orphan holding .git locks.
    let output = Command::new(resolve_bin("git")?)
        .args(args)
        .env("PATH", full_path())
        .env("GIT_OPTIONAL_LOCKS", "0")
        .current_dir(cwd)
        .kill_on_drop(true)
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

/// Run a git command in a given directory and return stdout (async).
/// Acquires a per-repo semaphore so only one Rally git operation runs
/// per repo at a time — prevents index.lock conflicts between Rally's
/// background polls and user-initiated git commands in the terminal.
pub async fn git_cmd(cwd: &str, args: &[&str]) -> Result<String, String> {
    let sem = repo_semaphore(cwd);
    let _permit = sem.acquire().await.map_err(|_| "semaphore closed".to_string())?;
    git_cmd_unlocked(cwd, args).await
}

/// Run gh CLI command in a given directory (async, with timeout for network ops).
/// Acquires the same per-repo semaphore as git_cmd() — `gh` internally runs
/// git operations (rev-list, config, etc.) that conflict with concurrent git commands.
///
/// The timeout covers the semaphore wait too, not just the process: an
/// unbounded acquire means one wedged git operation on a repo makes every
/// gh call for that repo hang forever, and the invoke never resolves to the
/// frontend. kill_on_drop ensures a timed-out gh process is killed instead
/// of leaking as an orphan.
async fn gh(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = tokio::time::timeout(Duration::from_secs(60), async {
        let sem = repo_semaphore(cwd);
        let _permit = sem
            .acquire()
            .await
            .map_err(|_| "semaphore closed".to_string())?;
        Command::new(resolve_bin("gh")?)
            .args(args)
            .env("PATH", full_path())
            .current_dir(cwd)
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|e| format!("Failed to run gh: {}", e))
    })
    .await
    .map_err(|_| format!("gh {} timed out after 60s", args.join(" ")))??;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("gh {} failed: {}", args.join(" "), stderr))
    }
}

/// Fetch from origin (quiet, with timeout to avoid hanging on auth prompts).
pub async fn fetch(cwd: &str) -> Result<(), String> {
    match tokio::time::timeout(
        Duration::from_secs(10),
        git_cmd(cwd, &["fetch", "--quiet"]),
    )
    .await
    {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("git fetch timed out".to_string()),
    }
}

/// Fetch then rebase onto origin/<main_branch>.
/// If the rebase fails (e.g. conflicts), auto-aborts so the repo isn't left
/// in a broken mid-rebase state.
pub async fn rebase_on_main(cwd: &str, main_branch: &str) -> Result<String, String> {
    fetch(cwd).await?;
    match git_cmd(cwd, &["rebase", &format!("origin/{}", main_branch)]).await {
        Ok(output) => Ok(output),
        Err(e) => {
            // Abort the failed rebase so the repo is back to a clean state
            let _ = git_cmd(cwd, &["rebase", "--abort"]).await;
            Err(e)
        }
    }
}

/// Return the current branch name. Fast — single `git symbolic-ref` call.
/// Empty string if HEAD is detached.
pub async fn current_branch(cwd: &str) -> Result<String, String> {
    match git_cmd(cwd, &["symbolic-ref", "--short", "HEAD"]).await {
        Ok(s) => Ok(s),
        Err(_) => Ok(String::new()),
    }
}

/// Smart sync: rebase onto main, with hard-reset only when safe.
/// 1. Rejects if working tree is dirty or already on main
/// 2. Fetches, checks out main, pulls, checks out branch
/// 3. Checks `git diff main branch` to detect unmerged work
///    - Empty diff → branch work is already in main (post-merge). Hard-reset + rebase + force-push.
///    - Non-empty diff → branch has real work. Rebase only, no push.
/// On rebase failure, auto-aborts to leave repo clean.
pub async fn sync_branch(cwd: &str, main_branch: &str) -> Result<String, String> {
    let branch = git_cmd(cwd, &["symbolic-ref", "--short", "HEAD"]).await?;

    if branch == main_branch {
        return Err("Already on main branch".to_string());
    }

    // Check for dirty working tree
    let porcelain = git_cmd(cwd, &["status", "--porcelain", "-uno"]).await?;
    if !porcelain.is_empty() {
        return Err("Working tree is dirty. Commit or stash your changes first.".to_string());
    }

    // Fetch, checkout main, pull
    fetch(cwd).await?;
    git_cmd(cwd, &["checkout", main_branch]).await
        .map_err(|e| format!("Failed to checkout {}: {}", main_branch, e))?;
    git_cmd(cwd, &["pull"]).await
        .map_err(|e| format!("Failed to pull {}: {}", main_branch, e))?;

    // Back to feature branch
    git_cmd(cwd, &["checkout", &branch]).await
        .map_err(|e| format!("Failed to checkout {}: {}", branch, e))?;

    // Detect whether branch work is already in main (post-merge) or has real unmerged changes.
    // `git diff main branch` compares the trees — empty means all work is merged.
    let diff = git_cmd(cwd, &["diff", "--stat", main_branch, &branch]).await.unwrap_or_default();
    let already_merged = diff.trim().is_empty();

    if already_merged {
        // Post-merge: safe to hard-reset (branch commits are stale copies of what's in main)
        git_cmd(cwd, &["reset", "--hard", main_branch]).await
            .map_err(|e| format!("Failed to reset {}: {}", branch, e))?;
    }

    // Snapshot HEAD before rebase to detect if anything changed
    let head_before = git_cmd(cwd, &["rev-parse", "HEAD"]).await.unwrap_or_default();

    // Rebase onto main
    match git_cmd(cwd, &["rebase", main_branch]).await {
        Ok(_) => {
            if already_merged {
                // Post-merge: force-push to update remote
                let head_after = git_cmd(cwd, &["rev-parse", "HEAD"]).await.unwrap_or_default();
                if head_before != head_after {
                    let _ = git_cmd(cwd, &["push", "--force-with-lease"]).await;
                }
                Ok(format!("{} synced with {} (reset)", branch, main_branch))
            } else {
                // In-progress: rebased only, no push
                Ok(format!("{} rebased onto {}", branch, main_branch))
            }
        }
        Err(e) => {
            let _ = git_cmd(cwd, &["rebase", "--abort"]).await;
            Err(e)
        }
    }
}

pub async fn stash(cwd: &str) -> Result<String, String> {
    git_cmd(cwd, &["stash"]).await
}

pub async fn stash_pop(cwd: &str) -> Result<String, String> {
    git_cmd(cwd, &["stash", "pop"]).await
}

pub async fn stash_count(cwd: &str) -> Result<u32, String> {
    let output = git_cmd(cwd, &["stash", "list"]).await?;
    if output.is_empty() {
        Ok(0)
    } else {
        Ok(output.lines().count() as u32)
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

    // Count ahead/behind vs remote tracking branch (origin/<current_branch>)
    // Uses @{upstream} which resolves to the configured tracking branch.
    // Fails gracefully if no upstream is set (locally-created branches).
    let (tracking_ahead, tracking_behind) = match git_cmd(cwd, &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).await {
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
        Err(_) => (0, 0), // No upstream configured
    };

    Ok(GitStatus {
        branch,
        dirty,
        ahead,
        behind,
        tracking_ahead,
        tracking_behind,
        modified_files: modified,
        untracked_files: untracked,
    })
}

/// Pull from the remote tracking branch.
/// Returns `Err("DIVERGED:...")` when branches have diverged so the caller
/// can prompt the user before force-pulling.
pub async fn pull(cwd: &str) -> Result<String, String> {
    match tokio::time::timeout(
        Duration::from_secs(30),
        git_cmd(cwd, &["pull"]),
    )
    .await
    {
        Ok(Ok(output)) => Ok(if output.is_empty() { "Already up to date.".to_string() } else { output }),
        Ok(Err(e)) => {
            let err_lower = e.to_lowercase();
            if err_lower.contains("divergent") || err_lower.contains("need to specify how to reconcile") {
                Err(format!("DIVERGED:{}", e))
            } else {
                Err(e)
            }
        }
        Err(_) => Err("git pull timed out after 30s".to_string()),
    }
}

/// Force-pull: reset local branch to match remote tracking branch exactly.
/// Discards any local commits that aren't on the remote.
pub async fn force_pull(cwd: &str) -> Result<String, String> {
    git_cmd(cwd, &["reset", "--hard", "@{upstream}"]).await?;
    Ok("Reset to remote".to_string())
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
            "number,title,url,state,isDraft,mergeable,reviewDecision",
        ],
    ).await?;

    let v: serde_json::Value =
        serde_json::from_str(&json_str).map_err(|e| format!("Failed to parse PR JSON: {}", e))?;

    let checks_status = None;

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

/// Get detailed PR info for the current branch (extended version of pr_status).
pub async fn pr_details(cwd: &str) -> Result<PrDetails, String> {
    let json_str = gh(
        cwd,
        &[
            "pr", "view", "--json",
            "number,title,url,state,isDraft,mergeable,reviewDecision,statusCheckRollup,body,author,baseRefName,headRefName,additions,deletions,changedFiles,createdAt,updatedAt,commits,labels,comments,reviews",
        ],
    ).await?;

    let v: serde_json::Value =
        serde_json::from_str(&json_str).map_err(|e| format!("Failed to parse PR JSON: {}", e))?;

    // Reuse statusCheckRollup parsing logic
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

    let commits = match v.get("commits") {
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .map(|c| PrCommit {
                sha: c["oid"].as_str().unwrap_or_default().to_string(),
                message_headline: c["messageHeadline"].as_str().unwrap_or_default().to_string(),
                author: c.get("authors")
                    .and_then(|a| a.as_array())
                    .and_then(|a| a.first())
                    .and_then(|a| a["name"].as_str())
                    .unwrap_or_default()
                    .to_string(),
                committed_date: c["committedDate"].as_str().unwrap_or_default().to_string(),
            })
            .collect(),
        _ => Vec::new(),
    };

    let labels = match v.get("labels") {
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|l| l["name"].as_str().map(|s| s.to_string()))
            .collect(),
        _ => Vec::new(),
    };

    let comments = match v.get("comments") {
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .map(|c| PrComment {
                author: c.get("author")
                    .and_then(|a| a["login"].as_str())
                    .unwrap_or_default()
                    .to_string(),
                body: c["body"].as_str().unwrap_or_default().to_string(),
                created_at: c["createdAt"].as_str().unwrap_or_default().to_string(),
            })
            .collect(),
        _ => Vec::new(),
    };

    let reviews = match v.get("reviews") {
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .map(|r| PrReview {
                author: r.get("author")
                    .and_then(|a| a["login"].as_str())
                    .unwrap_or_default()
                    .to_string(),
                body: r["body"].as_str().unwrap_or_default().to_string(),
                state: r["state"].as_str().unwrap_or_default().to_string(),
                created_at: r["submittedAt"].as_str()
                    .or_else(|| r["createdAt"].as_str())
                    .unwrap_or_default()
                    .to_string(),
            })
            .collect(),
        _ => Vec::new(),
    };

    let author = v.get("author")
        .and_then(|a| a["login"].as_str())
        .unwrap_or_default()
        .to_string();

    Ok(PrDetails {
        number: v["number"].as_u64().unwrap_or(0) as u32,
        title: v["title"].as_str().unwrap_or("").to_string(),
        url: v["url"].as_str().unwrap_or("").to_string(),
        state: v["state"].as_str().unwrap_or("OPEN").to_string(),
        is_draft: v["isDraft"].as_bool().unwrap_or(false),
        mergeable: v["mergeable"].as_str().unwrap_or("UNKNOWN").to_string(),
        review_decision: v["reviewDecision"].as_str().map(|s| s.to_string()),
        checks_status,
        body: v["body"].as_str().unwrap_or("").to_string(),
        author,
        base_branch: v["baseRefName"].as_str().unwrap_or("").to_string(),
        head_branch: v["headRefName"].as_str().unwrap_or("").to_string(),
        additions: v["additions"].as_u64().unwrap_or(0) as u32,
        deletions: v["deletions"].as_u64().unwrap_or(0) as u32,
        changed_files: v["changedFiles"].as_u64().unwrap_or(0) as u32,
        created_at: v["createdAt"].as_str().unwrap_or("").to_string(),
        updated_at: v["updatedAt"].as_str().unwrap_or("").to_string(),
        commits,
        labels,
        comments,
        reviews,
    })
}

/// Get raw unified diff for the current branch's PR.
pub async fn pr_diff(cwd: &str) -> Result<String, String> {
    gh(cwd, &["pr", "diff"]).await
}

/// Edit the title of the current branch's PR.
pub async fn edit_pr_title(cwd: &str, title: &str) -> Result<(), String> {
    gh(cwd, &["pr", "edit", "--title", title]).await?;
    Ok(())
}

/// Close the current branch's PR without merging.
pub async fn close_pr(cwd: &str) -> Result<String, String> {
    let branch = git_cmd(cwd, &["branch", "--show-current"]).await?;
    gh(cwd, &["pr", "close", &branch]).await
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
    let sem = repo_semaphore(cwd);
    let _permit = sem.acquire().await.map_err(|_| "semaphore closed".to_string())?;
    let raw = Command::new(resolve_bin("git")?)
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
    let sem = repo_semaphore(cwd);
    let _permit = sem.acquire().await.map_err(|_| "semaphore closed".to_string())?;
    let mut args = vec!["apply"];
    if reverse {
        args.push("--reverse");
    }
    if cached {
        args.push("--cached");
    }
    let mut child = tokio::process::Command::new(resolve_bin("git")?)
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
    let sem = repo_semaphore(cwd);
    let _permit = sem.acquire().await.map_err(|_| "semaphore closed".to_string())?;
    let mut args = vec!["diff", "--unified=3"];
    if staged {
        args.push("--cached");
    }
    let output = tokio::process::Command::new(resolve_bin("git")?)
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
    let sem = repo_semaphore(cwd);
    let _permit = sem.acquire().await.map_err(|_| "semaphore closed".to_string())?;
    let mut total_add: i64 = 0;
    let mut total_del: i64 = 0;

    for args in [&["diff", "--numstat"][..], &["diff", "--cached", "--numstat"][..]] {
        let output = Command::new(resolve_bin("git")?)
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

/// Get commit log for commits ahead of origin/<main_branch>.
pub async fn commit_log(cwd: &str, main_branch: &str, limit: u32) -> Result<Vec<CommitEntry>, String> {
    let range = format!("origin/{}..HEAD", main_branch);
    let format_str = "%H%n%s%n%an%n%aI";
    let limit_str = format!("-{}", limit);
    let output = git_cmd(
        cwd,
        &["log", &range, &format!("--pretty=format:{}", format_str), "--no-merges", &limit_str],
    ).await?;

    if output.is_empty() {
        return Ok(Vec::new());
    }

    let lines: Vec<&str> = output.lines().collect();
    let mut commits = Vec::new();
    // Each commit is 4 lines: sha, message, author, date
    for chunk in lines.chunks(4) {
        if chunk.len() == 4 {
            commits.push(CommitEntry {
                sha: chunk[0].to_string(),
                message: chunk[1].to_string(),
                author: chunk[2].to_string(),
                date: chunk[3].to_string(),
            });
        }
    }
    Ok(commits)
}

/// Get unified diff for a specific commit.
pub async fn commit_diff(cwd: &str, sha: &str) -> Result<String, String> {
    // Validate SHA is hex-only to prevent injection
    if !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid commit SHA".to_string());
    }
    git_cmd(cwd, &["diff-tree", "-p", "--no-commit-id", sha]).await
}

// ---------------------------------------------------------------------------
// Branch operations
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
}

/// List local branches with current branch indicator.
pub async fn list_branches(cwd: &str) -> Result<Vec<BranchInfo>, String> {
    let output = git_cmd(cwd, &["branch", "--format=%(refname:short)\t%(HEAD)"]).await?;
    let mut branches: Vec<BranchInfo> = output
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let parts: Vec<&str> = line.splitn(2, '\t').collect();
            let name = parts.first().unwrap_or(&"").to_string();
            let is_current = parts.get(1).map(|s| s.trim() == "*").unwrap_or(false);
            BranchInfo { name, is_current }
        })
        .collect();

    // Sort: current branch first, then alphabetical
    branches.sort_by(|a, b| {
        b.is_current.cmp(&a.is_current).then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(branches)
}

/// Checkout an existing branch.
///
/// Tolerates post-checkout hook failures (e.g. git-lfs not on PATH) as
/// long as the branch actually switched. Git runs the branch change
/// before invoking hooks, so a non-zero exit from a broken hook doesn't
/// imply the checkout failed — we verify HEAD to be sure.
pub async fn checkout_branch(cwd: &str, branch: &str) -> Result<String, String> {
    match git_cmd(cwd, &["checkout", branch]).await {
        Ok(out) => Ok(out),
        Err(err) => {
            if let Ok(head) = git_cmd(cwd, &["symbolic-ref", "--short", "HEAD"]).await {
                if head == branch {
                    return Ok(format!(
                        "Switched to '{}'. Post-checkout hook reported a warning: {}",
                        branch, err
                    ));
                }
            }
            Err(err)
        }
    }
}

/// Create and checkout a new branch.
pub async fn create_branch(cwd: &str, branch: &str) -> Result<String, String> {
    // Validate branch name
    if branch.is_empty() {
        return Err("Branch name cannot be empty".to_string());
    }
    if branch.contains(' ') || branch.contains("..") || branch.starts_with('-') || branch.contains('~') || branch.contains('^') || branch.contains(':') || branch.contains('\\') || branch.contains('\x7f') || branch.chars().any(|c| c.is_control()) {
        return Err("Invalid branch name".to_string());
    }
    git_cmd(cwd, &["checkout", "-b", branch]).await
}

/// Delete a local branch. Refuses to delete the currently checked-out branch.
pub async fn delete_branch(cwd: &str, branch: &str, force: bool) -> Result<String, String> {
    if branch.is_empty() {
        return Err("Branch name cannot be empty".to_string());
    }
    // Check we're not deleting the current branch
    let current = git_cmd(cwd, &["symbolic-ref", "--short", "HEAD"]).await?;
    if current == branch {
        return Err("Cannot delete the currently checked-out branch".to_string());
    }
    let flag = if force { "-D" } else { "-d" };
    git_cmd(cwd, &["branch", flag, branch]).await
}

pub async fn sync_branch_after_merge(cwd: &str, branch: &str, main_branch: &str) -> Result<(), String> {
    // Hard-reset feature branch to main first (clears all squash-merged commits)
    git_cmd(cwd, &["checkout", branch]).await?;
    git_cmd(cwd, &["reset", "--hard", main_branch]).await?;

    // Pull latest main
    git_cmd(cwd, &["checkout", main_branch]).await?;
    git_cmd(cwd, &["pull"]).await?;

    // Rebase feature branch onto updated main
    git_cmd(cwd, &["rebase", main_branch, branch]).await?;

    // Push — fall back to --force if --force-with-lease fails
    // (remote branch may have been deleted by GitHub after squash merge)
    let push_result = git_cmd(cwd, &["push", "--force-with-lease"]).await;
    match push_result {
        Ok(_) => {},
        Err(ref e) if e.contains("stale info") || e.contains("failed to push") || e.contains("rejected") => {
            git_cmd(cwd, &["push", "--force"]).await?;
        },
        Err(e) => return Err(e),
    }

    Ok(())
}
