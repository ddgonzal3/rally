use std::process::Command;

use crate::workspace::GitStatus;

/// Run a git command in a given directory and return stdout
pub fn git_cmd(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("git {} failed: {}", args.join(" "), stderr))
    }
}

/// Run gh CLI command in a given directory
fn gh(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("gh")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Failed to run gh: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("gh {} failed: {}", args.join(" "), stderr))
    }
}

pub fn status(cwd: &str) -> Result<GitStatus, String> {
    let branch = git_cmd(cwd, &["symbolic-ref", "--short", "HEAD"])?;

    let status_output = git_cmd(cwd, &["status", "--porcelain"])?;
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

    // Count ahead/behind vs origin/main
    let (ahead, behind) = match git_cmd(cwd, &["rev-list", "--left-right", "--count", "HEAD...origin/main"]) {
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
pub fn sync(cwd: &str, branch: &str, main_branch: &str) -> Result<String, String> {
    git_cmd(cwd, &["checkout", main_branch])?;
    git_cmd(cwd, &["pull"])?;
    git_cmd(cwd, &["rebase", main_branch, branch])?;
    Ok(format!("Synced {} onto {}", branch, main_branch))
}

/// Rebase: stash, checkout main, pull, rebase, pop stash
pub fn rebase(cwd: &str, branch: &str, main_branch: &str) -> Result<String, String> {
    git_cmd(cwd, &["checkout", branch])?;

    // Check if there are changes to stash
    let status = git_cmd(cwd, &["status", "--porcelain"])?;
    let has_changes = !status.is_empty();

    if has_changes {
        git_cmd(cwd, &["stash"])?;
    }

    git_cmd(cwd, &["checkout", main_branch])?;
    git_cmd(cwd, &["pull"])?;
    git_cmd(cwd, &["checkout", branch])?;

    if let Err(e) = git_cmd(cwd, &["rebase", main_branch]) {
        return Err(format!("Rebase failed (resolve conflicts manually): {}", e));
    }

    if has_changes {
        if let Err(e) = git_cmd(cwd, &["stash", "pop"]) {
            return Err(format!("Rebased successfully but stash pop had conflicts: {}", e));
        }
    }

    Ok(format!("Rebased {} onto {}", branch, main_branch))
}

/// Commit staged changes
pub fn commit(cwd: &str, message: &str) -> Result<String, String> {
    git_cmd(cwd, &["add", "-u"])?;
    git_cmd(cwd, &["commit", "-m", message])
}

/// Push current branch, set upstream if needed
pub fn push(cwd: &str) -> Result<String, String> {
    let branch = git_cmd(cwd, &["symbolic-ref", "--short", "HEAD"])?;

    // Try normal push first, fall back to setting upstream
    match git_cmd(cwd, &["push"]) {
        Ok(out) => Ok(out),
        Err(_) => git_cmd(cwd, &["push", "--set-upstream", "origin", &branch]),
    }
}

/// Create a PR using gh CLI
pub fn create_pr(cwd: &str, title: Option<&str>, body: Option<&str>) -> Result<String, String> {
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

    gh(cwd, &args)
}
