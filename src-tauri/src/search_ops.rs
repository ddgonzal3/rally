use std::collections::BTreeSet;

use regex::{Regex, RegexBuilder};

use crate::git_ops::git_cmd;

#[derive(Debug, serde::Serialize, Clone)]
pub struct SearchMatch {
    pub file_path: String,
    pub line_number: u32,
    pub line_content: String,
    pub match_start: u32,
    pub match_end: u32,
}

const MAX_RESULTS_TOTAL: usize = 10_000;
const MAX_RESULTS_PER_ROOT: usize = 2_500;

/// Build a Regex from the user's query and search options.
fn build_regex(query: &str, case_sensitive: bool, whole_word: bool, use_regex: bool) -> Result<Regex, String> {
    let pattern = if use_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let pattern = if whole_word {
        format!(r"\b{}\b", pattern)
    } else {
        pattern
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| format!("Invalid regex: {}", e))
}

/// Search for a string/regex across files in the given workspace paths using `git grep`.
#[tauri::command]
pub async fn search_in_files(
    paths: Vec<String>,
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    use_regex: bool,
) -> Result<Vec<SearchMatch>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }

    // Pre-compile regex for match-position finding
    let re = build_regex(&query, case_sensitive, whole_word, use_regex)?;

    let mut results = Vec::new();

    for root in &paths {
        if results.len() >= MAX_RESULTS_TOTAL {
            break;
        }

        let mut root_results = 0usize;

        // -F = fixed string (literal), -E = extended regex
        let mode_flag = if use_regex { "-E" } else { "-F" };
        let mut args: Vec<&str> = vec!["grep", "-n", "--no-color", mode_flag];
        if !case_sensitive {
            args.push("-i");
        }
        if whole_word {
            args.push("-w");
        }
        // --untracked: also search files not yet tracked by git
        args.push("--untracked");
        args.push(&query);

        // git grep returns exit code 1 when no matches — that's not an error
        let output = match git_cmd(root, &args).await {
            Ok(out) => out,
            Err(e) if e.contains("failed: ") => {
                // Exit code 1 = no matches. The error message from git_cmd looks like:
                // "git grep ... failed: " (empty stderr because git grep exits 1 silently)
                continue;
            }
            Err(e) => return Err(e),
        };

        if output.is_empty() {
            continue;
        }

        for line in output.lines() {
            if results.len() >= MAX_RESULTS_TOTAL || root_results >= MAX_RESULTS_PER_ROOT {
                break;
            }

            // Format: file.rs:42:matching line content
            // We need to split on first two colons
            let (file, rest) = match line.split_once(':') {
                Some(pair) => pair,
                None => continue,
            };
            let (line_num_str, content) = match rest.split_once(':') {
                Some(pair) => pair,
                None => continue,
            };
            let line_number: u32 = match line_num_str.parse() {
                Ok(n) => n,
                Err(_) => continue,
            };

            // Build absolute path
            let file_path = if file.starts_with('/') {
                file.to_string()
            } else {
                format!("{}/{}", root.trim_end_matches('/'), file)
            };

            // Find match position using regex
            let (match_start, match_end) = if let Some(m) = re.find(content) {
                (m.start() as u32, m.end() as u32)
            } else {
                // Fallback: highlight nothing useful
                (0, 0)
            };

            results.push(SearchMatch {
                file_path,
                line_number,
                line_content: content.to_string(),
                match_start,
                match_end,
            });
            root_results += 1;
        }
    }

    Ok(results)
}

// --- Replace support ---

#[derive(Debug, serde::Deserialize)]
pub struct ReplaceOp {
    pub file_path: String,
    pub search: String,
    pub replace: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub use_regex: bool,
}

#[derive(Debug, serde::Serialize)]
pub struct ReplaceResult {
    pub files_changed: u32,
    pub replacements: u32,
}

/// Replace occurrences in files. Each ReplaceOp targets one file.
#[tauri::command]
pub async fn replace_in_files(
    replacements: Vec<ReplaceOp>,
) -> Result<ReplaceResult, String> {
    let mut files_changed: u32 = 0;
    let mut total_replacements: u32 = 0;

    for op in &replacements {
        let re = build_regex(&op.search, op.case_sensitive, op.whole_word, op.use_regex)?;

        let content = std::fs::read_to_string(&op.file_path)
            .map_err(|e| format!("Failed to read {}: {}", op.file_path, e))?;

        let new_content = re.replace_all(&content, op.replace.as_str()).to_string();

        if new_content != content {
            let count = re.find_iter(&content).count() as u32;
            std::fs::write(&op.file_path, &new_content)
                .map_err(|e| format!("Failed to write {}: {}", op.file_path, e))?;
            files_changed += 1;
            total_replacements += count;
        }
    }

    Ok(ReplaceResult {
        files_changed,
        replacements: total_replacements,
    })
}

/// List all files (tracked + untracked non-ignored) across the given workspace paths.
#[tauri::command]
pub async fn list_all_files(paths: Vec<String>) -> Result<Vec<String>, String> {
    let mut all_files = BTreeSet::new();

    for root in &paths {
        let root_trimmed = root.trim_end_matches('/');

        // Tracked files
        if let Ok(output) = git_cmd(root, &["ls-files"]).await {
            for line in output.lines() {
                if !line.is_empty() {
                    if line.starts_with('/') {
                        all_files.insert(line.to_string());
                    } else {
                        all_files.insert(format!("{}/{}", root_trimmed, line));
                    }
                }
            }
        }

        // Untracked non-ignored files
        if let Ok(output) = git_cmd(root, &["ls-files", "--others", "--exclude-standard"]).await {
            for line in output.lines() {
                if !line.is_empty() {
                    if line.starts_with('/') {
                        all_files.insert(line.to_string());
                    } else {
                        all_files.insert(format!("{}/{}", root_trimmed, line));
                    }
                }
            }
        }
    }

    // BTreeSet is already sorted and deduplicated
    Ok(all_files.into_iter().collect())
}
