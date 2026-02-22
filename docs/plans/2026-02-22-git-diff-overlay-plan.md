# Git Diff Overlay — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a full-screen git diff overlay that shows staged/unstaged changes with syntax-highlighted hunks, per-file actions, commit workflow, and post-commit Ship integration.

**Architecture:** A new `GitDiffOverlay` component renders as an absolute-positioned layer on top of the main pane area. It fetches diff data via a new `git_diff` Rust command, parses unified diff output into structured hunks, and renders them with lightweight syntax highlighting. State is minimal — just an open/closed flag in the Zustand store; diff data is local component state.

**Tech Stack:** Rust (Tauri command), TypeScript/React (components), Zustand (overlay state), custom unified diff parser, lightweight regex-based syntax highlighter.

---

### Task 1: Add `git_diff` Rust command

**Files:**
- Modify: `src-tauri/src/git_ops.rs` (add `diff` and `commit_staged` functions)
- Modify: `src-tauri/src/commands.rs` (add `git_diff` and `git_commit_staged` Tauri commands)
- Modify: `src-tauri/src/main.rs:130` (register in `generate_handler![]`)

**Step 1: Add `diff()` function to git_ops.rs**

Add after the `discard_file` function (line ~356):

```rust
/// Get unified diff output for staged or unstaged changes.
pub async fn diff(cwd: &str, staged: bool) -> Result<String, String> {
    let mut args = vec!["diff", "--unified=3"];
    if staged {
        args.push("--cached");
    }
    // Use git_cmd but allow empty output (no changes = empty string, not error)
    let output = tokio::process::Command::new("git")
        .args(&args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("Failed to run git diff: {}", e))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Commit only what's currently staged (no auto-add).
pub async fn commit_staged(cwd: &str, message: &str) -> Result<String, String> {
    git_cmd(cwd, &["commit", "-m", message]).await
}
```

**Step 2: Add Tauri command wrappers in commands.rs**

Add after `git_discard_file` command (line ~227):

```rust
#[tauri::command]
pub async fn git_diff(workspace_path: String, staged: bool) -> Result<String, String> {
    git_ops::diff(&workspace_path, staged).await
}

#[tauri::command]
pub async fn git_commit_staged(workspace_path: String, message: String) -> Result<String, String> {
    git_ops::commit_staged(&workspace_path, &message).await
}
```

**Step 3: Register in main.rs**

Add `commands::git_diff` and `commands::git_commit_staged` to the `generate_handler![]` macro (after `commands::git_discard_file` on line 144):

```rust
commands::git_diff,
commands::git_commit_staged,
```

**Step 4: Add API wrappers in src/lib/tauri.ts**

Add after `gitDiscardFile` (line ~45):

```typescript
gitDiff: (workspacePath: string, staged: boolean) =>
  invoke<string>("git_diff", { workspacePath, staged }),

gitCommitStaged: (workspacePath: string, message: string) =>
  invoke<string>("git_commit_staged", { workspacePath, message }),
```

**Step 5: Build and verify**

Run: `./scripts/check.sh`
Expected: Clean type-check for both Rust and TypeScript.

---

### Task 2: Create unified diff parser

**Files:**
- Create: `src/lib/diffParser.ts`

**Step 1: Write the diff parser**

```typescript
export interface DiffFile {
  oldPath: string;
  newPath: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  isNew: boolean;
  isDeleted: boolean;
  isRenamed: boolean;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "add" | "delete" | "context";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

/**
 * Parse a unified diff string (output of `git diff`) into structured DiffFile objects.
 */
export function parseUnifiedDiff(raw: string): DiffFile[] {
  if (!raw.trim()) return [];

  const files: DiffFile[] = [];
  // Split on "diff --git" boundaries
  const fileSections = raw.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const lines = section.split("\n");
    // First line: "a/path b/path"
    const pathMatch = lines[0]?.match(/^a\/(.*?) b\/(.*)$/);
    if (!pathMatch) continue;

    const file: DiffFile = {
      oldPath: pathMatch[1],
      newPath: pathMatch[2],
      additions: 0,
      deletions: 0,
      hunks: [],
      isNew: false,
      isDeleted: false,
      isRenamed: pathMatch[1] !== pathMatch[2],
    };

    // Check for new/deleted file markers
    for (const line of lines.slice(1, 6)) {
      if (line.startsWith("new file")) file.isNew = true;
      if (line.startsWith("deleted file")) file.isDeleted = true;
    }

    // Parse hunks
    let currentHunk: DiffHunk | null = null;
    let oldLine = 0;
    let newLine = 0;

    for (const line of lines) {
      const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      if (hunkMatch) {
        currentHunk = {
          header: line,
          oldStart: parseInt(hunkMatch[1], 10),
          newStart: parseInt(hunkMatch[2], 10),
          lines: [],
        };
        oldLine = currentHunk.oldStart;
        newLine = currentHunk.newStart;
        file.hunks.push(currentHunk);
        continue;
      }

      if (!currentHunk) continue;

      if (line.startsWith("+")) {
        currentHunk.lines.push({
          type: "add",
          content: line.slice(1),
          newLineNumber: newLine++,
        });
        file.additions++;
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({
          type: "delete",
          content: line.slice(1),
          oldLineNumber: oldLine++,
        });
        file.deletions++;
      } else if (line.startsWith(" ")) {
        currentHunk.lines.push({
          type: "context",
          content: line.slice(1),
          oldLineNumber: oldLine++,
          newLineNumber: newLine++,
        });
      }
      // Skip "\ No newline at end of file" and other non-diff lines
    }

    files.push(file);
  }

  return files;
}
```

---

### Task 3: Create syntax highlighter

**Files:**
- Create: `src/lib/syntaxHighlight.ts`

**Step 1: Write the lightweight syntax highlighter**

```typescript
interface TokenRule {
  pattern: RegExp;
  className: string;
}

const LANG_RULES: Record<string, TokenRule[]> = {
  js: [
    { pattern: /\/\/.*$/gm, className: "syn-comment" },
    { pattern: /\/\*[\s\S]*?\*\//gm, className: "syn-comment" },
    { pattern: /(["'`])(?:(?!\1|\\).|\\.)*\1/g, className: "syn-string" },
    { pattern: /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|default|async|await|new|this|typeof|instanceof|throw|try|catch|finally|switch|case|break|continue|do|in|of|yield)\b/g, className: "syn-keyword" },
    { pattern: /\b(true|false|null|undefined|NaN|Infinity)\b/g, className: "syn-literal" },
    { pattern: /\b\d+\.?\d*\b/g, className: "syn-number" },
  ],
  rust: [
    { pattern: /\/\/.*$/gm, className: "syn-comment" },
    { pattern: /\/\*[\s\S]*?\*\//gm, className: "syn-comment" },
    { pattern: /"(?:[^"\\]|\\.)*"/g, className: "syn-string" },
    { pattern: /\b(fn|let|mut|const|struct|enum|impl|trait|pub|use|mod|match|if|else|for|while|loop|return|async|await|self|Self|super|crate|where|type|as|in|ref|move|unsafe|extern|dyn|static|macro_rules)\b/g, className: "syn-keyword" },
    { pattern: /\b(true|false|None|Some|Ok|Err)\b/g, className: "syn-literal" },
    { pattern: /\b\d+\.?\d*\b/g, className: "syn-number" },
  ],
  python: [
    { pattern: /#.*$/gm, className: "syn-comment" },
    { pattern: /("""[\s\S]*?"""|'''[\s\S]*?''')/g, className: "syn-string" },
    { pattern: /(["'])(?:(?!\1|\\).|\\.)*\1/g, className: "syn-string" },
    { pattern: /\b(def|class|return|if|elif|else|for|while|import|from|as|with|try|except|finally|raise|yield|lambda|pass|break|continue|and|or|not|is|in|True|False|None|async|await|global|nonlocal)\b/g, className: "syn-keyword" },
    { pattern: /\b\d+\.?\d*\b/g, className: "syn-number" },
  ],
  json: [
    { pattern: /"(?:[^"\\]|\\.)*"\s*(?=:)/g, className: "syn-keyword" },
    { pattern: /"(?:[^"\\]|\\.)*"/g, className: "syn-string" },
    { pattern: /\b(true|false|null)\b/g, className: "syn-literal" },
    { pattern: /\b-?\d+\.?\d*([eE][+-]?\d+)?\b/g, className: "syn-number" },
  ],
  css: [
    { pattern: /\/\*[\s\S]*?\*\//gm, className: "syn-comment" },
    { pattern: /(["'])(?:(?!\1|\\).|\\.)*\1/g, className: "syn-string" },
    { pattern: /\b\d+\.?\d*(px|em|rem|%|vh|vw|s|ms|deg|fr)?\b/g, className: "syn-number" },
    { pattern: /#[0-9a-fA-F]{3,8}\b/g, className: "syn-literal" },
  ],
  shell: [
    { pattern: /#.*$/gm, className: "syn-comment" },
    { pattern: /(["'])(?:(?!\1|\\).|\\.)*\1/g, className: "syn-string" },
    { pattern: /\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|echo|export|source|local|readonly|declare|set|unset|cd|ls|rm|cp|mv|mkdir|cat|grep|sed|awk|find|xargs)\b/g, className: "syn-keyword" },
    { pattern: /\$\{?[a-zA-Z_][a-zA-Z0-9_]*\}?/g, className: "syn-literal" },
  ],
  go: [
    { pattern: /\/\/.*$/gm, className: "syn-comment" },
    { pattern: /\/\*[\s\S]*?\*\//gm, className: "syn-comment" },
    { pattern: /(["'`])(?:(?!\1|\\).|\\.)*\1/g, className: "syn-string" },
    { pattern: /\b(func|var|const|type|struct|interface|map|chan|go|select|switch|case|default|if|else|for|range|return|break|continue|defer|package|import|fallthrough)\b/g, className: "syn-keyword" },
    { pattern: /\b(true|false|nil|iota)\b/g, className: "syn-literal" },
    { pattern: /\b\d+\.?\d*\b/g, className: "syn-number" },
  ],
  yaml: [
    { pattern: /#.*$/gm, className: "syn-comment" },
    { pattern: /^[\w.-]+(?=\s*:)/gm, className: "syn-keyword" },
    { pattern: /(["'])(?:(?!\1|\\).|\\.)*\1/g, className: "syn-string" },
    { pattern: /\b(true|false|null|yes|no|on|off)\b/gi, className: "syn-literal" },
    { pattern: /\b\d+\.?\d*\b/g, className: "syn-number" },
  ],
  html: [
    { pattern: /<!--[\s\S]*?-->/gm, className: "syn-comment" },
    { pattern: /(["'])(?:(?!\1|\\).|\\.)*\1/g, className: "syn-string" },
    { pattern: /<\/?[a-zA-Z][a-zA-Z0-9-]*/g, className: "syn-keyword" },
    { pattern: /\/?>/g, className: "syn-keyword" },
  ],
  md: [
    { pattern: /^#{1,6}\s.*/gm, className: "syn-keyword" },
    { pattern: /`[^`]+`/g, className: "syn-string" },
    { pattern: /\*\*[^*]+\*\*/g, className: "syn-literal" },
  ],
};

// Map file extensions to language keys
const EXT_MAP: Record<string, string> = {
  js: "js", jsx: "js", ts: "js", tsx: "js", mjs: "js", cjs: "js",
  rs: "rust",
  py: "python",
  json: "json",
  css: "css", scss: "css", less: "css",
  sh: "shell", bash: "shell", zsh: "shell",
  go: "go",
  yaml: "yaml", yml: "yaml",
  html: "html", htm: "html", xml: "html", svg: "html",
  md: "md", mdx: "md",
  toml: "yaml", // close enough
  rb: "python", // close enough for basic highlighting
};

/**
 * Get the language key for a file path based on its extension.
 */
export function getLangForPath(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MAP[ext] ?? null;
}

/**
 * Escape HTML special characters in a string.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Apply syntax highlighting to a line of code, returning an HTML string.
 * Returns escaped HTML with <span class="syn-*"> wrappers.
 */
export function highlightLine(code: string, lang: string | null): string {
  if (!lang || !LANG_RULES[lang]) return escapeHtml(code);

  const rules = LANG_RULES[lang];
  // Build a list of non-overlapping token spans
  const tokens: Array<{ start: number; end: number; className: string }> = [];

  for (const rule of rules) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      // Only add if no overlap with existing tokens
      const overlaps = tokens.some(
        (t) => start < t.end && end > t.start,
      );
      if (!overlaps) {
        tokens.push({ start, end, className: rule.className });
      }
    }
  }

  if (tokens.length === 0) return escapeHtml(code);

  tokens.sort((a, b) => a.start - b.start);

  let result = "";
  let pos = 0;
  for (const token of tokens) {
    if (token.start > pos) {
      result += escapeHtml(code.slice(pos, token.start));
    }
    result += `<span class="${token.className}">${escapeHtml(code.slice(token.start, token.end))}</span>`;
    pos = token.end;
  }
  if (pos < code.length) {
    result += escapeHtml(code.slice(pos));
  }

  return result;
}
```

---

### Task 4: Add overlay state to Zustand store

**Files:**
- Modify: `src/stores/workspaceStore.ts`

**Step 1: Add state fields to `WorkspaceState` interface**

Add after `revealedFilePath` (line ~147):

```typescript
/** Git diff overlay state */
gitDiffOverlayOpen: boolean;
gitDiffOverlayPath: string | null;
gitDiffActiveTab: "unstaged" | "staged";
```

**Step 2: Add action signatures to `WorkspaceState` interface**

Add after `revealFileInExplorer` (line ~215):

```typescript
/** Open the git diff overlay for a repo path */
openGitDiffOverlay: (rootPath: string) => void;
/** Close the git diff overlay */
closeGitDiffOverlay: () => void;
/** Set the active tab in the git diff overlay */
setGitDiffActiveTab: (tab: "unstaged" | "staged") => void;
```

**Step 3: Add initial state values**

In the `create()` call, add after `revealedFilePath: null`:

```typescript
gitDiffOverlayOpen: false,
gitDiffOverlayPath: null,
gitDiffActiveTab: "unstaged" as const,
```

**Step 4: Add action implementations**

Add near the other simple actions:

```typescript
openGitDiffOverlay: (rootPath) => {
  set({
    gitDiffOverlayOpen: true,
    gitDiffOverlayPath: rootPath,
    gitDiffActiveTab: "unstaged",
  });
},

closeGitDiffOverlay: () => {
  set({
    gitDiffOverlayOpen: false,
    gitDiffOverlayPath: null,
  });
},

setGitDiffActiveTab: (tab) => {
  set({ gitDiffActiveTab: tab });
},
```

---

### Task 5: Build `DiffHunkView` component

**Files:**
- Create: `src/components/DiffHunkView.tsx`

**Step 1: Write the hunk renderer**

This is the innermost component — renders a single hunk's lines with syntax highlighting and colored backgrounds.

```tsx
import React, { useMemo } from "react";
import type { DiffHunk } from "../lib/diffParser";
import { highlightLine, getLangForPath } from "../lib/syntaxHighlight";

export function DiffHunkView({
  hunk,
  filePath,
}: {
  hunk: DiffHunk;
  filePath: string;
}) {
  const lang = useMemo(() => getLangForPath(filePath), [filePath]);

  return (
    <div style={styles.hunk}>
      <div style={styles.hunkHeader}>{hunk.header}</div>
      {hunk.lines.map((line, i) => {
        const bg =
          line.type === "add"
            ? "rgba(63, 185, 80, 0.12)"
            : line.type === "delete"
              ? "rgba(248, 81, 73, 0.12)"
              : "transparent";
        const lineNum =
          line.type === "add"
            ? line.newLineNumber
            : line.type === "delete"
              ? line.oldLineNumber
              : line.oldLineNumber;
        const marker =
          line.type === "add" ? "+" : line.type === "delete" ? "-" : " ";
        const markerColor =
          line.type === "add"
            ? "#3fb950"
            : line.type === "delete"
              ? "#f85149"
              : "#666";

        return (
          <div key={i} style={{ ...styles.line, background: bg }}>
            <span style={styles.lineNum}>{lineNum ?? ""}</span>
            <span style={{ ...styles.marker, color: markerColor }}>
              {marker}
            </span>
            <span
              style={styles.lineContent}
              dangerouslySetInnerHTML={{
                __html: highlightLine(line.content, lang),
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  hunk: {
    fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
    fontSize: 12,
    lineHeight: "20px",
    borderRadius: 6,
    overflow: "hidden",
    border: "1px solid #2a2a2a",
    marginTop: 4,
    marginBottom: 8,
  },
  hunkHeader: {
    padding: "4px 12px",
    background: "#1e2a3a",
    color: "#6e7681",
    fontSize: 11,
    borderBottom: "1px solid #2a2a2a",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  line: {
    display: "flex",
    alignItems: "stretch",
    minHeight: 20,
  },
  lineNum: {
    width: 44,
    minWidth: 44,
    textAlign: "right",
    paddingRight: 8,
    color: "#484f58",
    userSelect: "none",
    flexShrink: 0,
  },
  marker: {
    width: 16,
    minWidth: 16,
    textAlign: "center",
    userSelect: "none",
    flexShrink: 0,
    fontWeight: 600,
  },
  lineContent: {
    flex: 1,
    paddingRight: 12,
    whiteSpace: "pre",
    overflow: "hidden",
    color: "#e6edf3",
  },
};
```

---

### Task 6: Build `DiffFileSection` component

**Files:**
- Create: `src/components/DiffFileSection.tsx`

**Step 1: Write the file section component**

Each file section has a collapsible header with +/- stats and action buttons, and renders its hunks when expanded.

```tsx
import React, { useState, useCallback } from "react";
import type { DiffFile } from "../lib/diffParser";
import { DiffHunkView } from "./DiffHunkView";

export function DiffFileSection({
  file,
  defaultExpanded,
  tab,
  onStage,
  onUnstage,
  onDiscard,
}: {
  file: DiffFile;
  defaultExpanded: boolean;
  tab: "unstaged" | "staged";
  onStage?: (filePath: string) => void;
  onUnstage?: (filePath: string) => void;
  onDiscard?: (filePath: string) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [confirming, setConfirming] = useState(false);
  const filePath = file.newPath || file.oldPath;

  const handleDiscard = useCallback(() => {
    if (!confirming) {
      setConfirming(true);
      // Auto-cancel after 3 seconds
      setTimeout(() => setConfirming(false), 3000);
      return;
    }
    setConfirming(false);
    onDiscard?.(filePath);
  }, [confirming, filePath, onDiscard]);

  return (
    <div style={styles.section}>
      <div
        style={styles.header}
        onClick={() => setExpanded(!expanded)}
      >
        <span style={styles.chevron}>{expanded ? "▼" : "▶"}</span>
        <span style={styles.fileName}>{filePath}</span>
        <span style={styles.stats}>
          {file.additions > 0 && (
            <span style={styles.additions}>+{file.additions}</span>
          )}
          {file.deletions > 0 && (
            <span style={styles.deletions}>-{file.deletions}</span>
          )}
        </span>
        {file.isNew && <span style={styles.badge}>NEW</span>}
        {file.isDeleted && <span style={styles.badgeDelete}>DEL</span>}
        {file.isRenamed && <span style={styles.badgeRename}>REN</span>}
        <div style={styles.actions} onClick={(e) => e.stopPropagation()}>
          {tab === "unstaged" && (
            <>
              <button
                onClick={handleDiscard}
                style={confirming ? styles.btnDanger : styles.btn}
                title={confirming ? "Click again to confirm discard" : "Discard changes"}
              >
                {confirming ? "Confirm?" : "Discard"}
              </button>
              <button
                onClick={() => onStage?.(filePath)}
                style={styles.btnPrimary}
                title="Stage file"
              >
                Stage
              </button>
            </>
          )}
          {tab === "staged" && (
            <button
              onClick={() => onUnstage?.(filePath)}
              style={styles.btn}
              title="Unstage file"
            >
              Unstage
            </button>
          )}
        </div>
      </div>
      {expanded && (
        <div style={styles.hunks}>
          {file.hunks.length === 0 ? (
            <div style={styles.noContent}>
              {file.isNew ? "New file" : file.isDeleted ? "File deleted" : "Binary file or no content"}
            </div>
          ) : (
            file.hunks.map((hunk, i) => (
              <DiffHunkView key={i} hunk={hunk} filePath={filePath} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  section: {
    marginBottom: 2,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    background: "#252525",
    borderRadius: 6,
    cursor: "pointer",
    userSelect: "none",
    border: "1px solid #2e2e2e",
  },
  chevron: {
    fontSize: 10,
    color: "#888",
    width: 14,
    flexShrink: 0,
  },
  fileName: {
    flex: 1,
    fontSize: 13,
    fontFamily: "'SF Mono', 'Menlo', monospace",
    color: "#e6edf3",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  stats: {
    display: "flex",
    gap: 6,
    fontSize: 12,
    fontFamily: "'SF Mono', 'Menlo', monospace",
    flexShrink: 0,
  },
  additions: {
    color: "#3fb950",
  },
  deletions: {
    color: "#f85149",
  },
  badge: {
    fontSize: 10,
    fontWeight: 600,
    padding: "1px 5px",
    borderRadius: 4,
    background: "rgba(63, 185, 80, 0.15)",
    color: "#3fb950",
    flexShrink: 0,
  },
  badgeDelete: {
    fontSize: 10,
    fontWeight: 600,
    padding: "1px 5px",
    borderRadius: 4,
    background: "rgba(248, 81, 73, 0.15)",
    color: "#f85149",
    flexShrink: 0,
  },
  badgeRename: {
    fontSize: 10,
    fontWeight: 600,
    padding: "1px 5px",
    borderRadius: 4,
    background: "rgba(210, 153, 34, 0.15)",
    color: "#d29922",
    flexShrink: 0,
  },
  actions: {
    display: "flex",
    gap: 4,
    flexShrink: 0,
  },
  btn: {
    fontSize: 11,
    padding: "3px 8px",
    borderRadius: 4,
    border: "1px solid #3f3f3f",
    background: "#2d2d2d",
    color: "#ccc",
    cursor: "pointer",
  },
  btnPrimary: {
    fontSize: 11,
    padding: "3px 8px",
    borderRadius: 4,
    border: "1px solid #1f6feb55",
    background: "#1f6feb22",
    color: "#58a6ff",
    cursor: "pointer",
  },
  btnDanger: {
    fontSize: 11,
    padding: "3px 8px",
    borderRadius: 4,
    border: "1px solid #f8514955",
    background: "#f8514922",
    color: "#f85149",
    cursor: "pointer",
  },
  hunks: {
    padding: "4px 12px 8px 12px",
  },
  noContent: {
    padding: "12px 0",
    color: "#666",
    fontSize: 12,
    fontStyle: "italic",
    textAlign: "center",
  },
};
```

---

### Task 7: Build `GitDiffOverlay` main component

**Files:**
- Create: `src/components/GitDiffOverlay.tsx`

**Step 1: Write the overlay component**

This is the main orchestrating component — fetches diff data, renders tab switcher, file list, action bar, and commit section.

```tsx
import React, { useState, useEffect, useCallback, useRef } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { api } from "../lib/tauri";
import { parseUnifiedDiff, type DiffFile } from "../lib/diffParser";
import { DiffFileSection } from "./DiffFileSection";
import type { ChangesSummary } from "../lib/types";
import { addToast } from "./ToastContainer";

export function GitDiffOverlay() {
  const open = useWorkspaceStore((s) => s.gitDiffOverlayOpen);
  const rootPath = useWorkspaceStore((s) => s.gitDiffOverlayPath);
  const activeTab = useWorkspaceStore((s) => s.gitDiffActiveTab);
  const setActiveTab = useWorkspaceStore((s) => s.setGitDiffActiveTab);
  const closeOverlay = useWorkspaceStore((s) => s.closeGitDiffOverlay);
  const startShipSession = useWorkspaceStore((s) => s.startShipSession);
  const gitStatus = useWorkspaceStore((s) =>
    rootPath ? s.gitStatuses[rootPath] : undefined,
  );

  const [unstagedFiles, setUnstagedFiles] = useState<DiffFile[]>([]);
  const [stagedFiles, setStagedFiles] = useState<DiffFile[]>([]);
  const [changes, setChanges] = useState<ChangesSummary | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  const [justCommitted, setJustCommitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(false);
  const commitInputRef = useRef<HTMLInputElement>(null);

  // Slide-in animation
  useEffect(() => {
    if (open) {
      // Small delay so the component mounts at translateY(100%) first
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
    }
  }, [open]);

  const fetchDiffs = useCallback(async () => {
    if (!rootPath) return;
    setLoading(true);
    try {
      const [unstagedRaw, stagedRaw, changesData] = await Promise.all([
        api.gitDiff(rootPath, false),
        api.gitDiff(rootPath, true),
        api.gitChanges(rootPath),
      ]);
      setUnstagedFiles(parseUnifiedDiff(unstagedRaw));
      setStagedFiles(parseUnifiedDiff(stagedRaw));
      setChanges(changesData);
    } catch (e) {
      console.error("Failed to fetch diffs:", e);
    } finally {
      setLoading(false);
    }
  }, [rootPath]);

  // Fetch on open
  useEffect(() => {
    if (open && rootPath) {
      setJustCommitted(false);
      setCommitMsg("");
      fetchDiffs();
    }
  }, [open, rootPath, fetchDiffs]);

  // Listen for git changes refresh
  useEffect(() => {
    if (!open) return;
    const handler = () => fetchDiffs();
    document.addEventListener("rally:git-changes-refresh", handler);
    return () =>
      document.removeEventListener("rally:git-changes-refresh", handler);
  }, [open, fetchDiffs]);

  // Escape key to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeOverlay();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open, closeOverlay]);

  const handleStage = useCallback(
    async (filePath: string) => {
      if (!rootPath) return;
      await api.gitStageFile(rootPath, filePath);
      fetchDiffs();
    },
    [rootPath, fetchDiffs],
  );

  const handleUnstage = useCallback(
    async (filePath: string) => {
      if (!rootPath) return;
      await api.gitUnstageFile(rootPath, filePath);
      fetchDiffs();
    },
    [rootPath, fetchDiffs],
  );

  const handleDiscard = useCallback(
    async (filePath: string) => {
      if (!rootPath || !changes) return;
      const isUntracked = changes.untracked.includes(filePath);
      await api.gitDiscardFile(rootPath, filePath, isUntracked);
      fetchDiffs();
    },
    [rootPath, changes, fetchDiffs],
  );

  const handleStageAll = useCallback(async () => {
    if (!rootPath || !changes) return;
    const allFiles = [
      ...changes.unstaged.map((f) => f.path),
      ...changes.untracked,
    ];
    for (const f of allFiles) {
      await api.gitStageFile(rootPath, f);
    }
    fetchDiffs();
  }, [rootPath, changes, fetchDiffs]);

  const handleUnstageAll = useCallback(async () => {
    if (!rootPath || !changes) return;
    for (const f of changes.staged) {
      await api.gitUnstageFile(rootPath, f.path);
    }
    fetchDiffs();
  }, [rootPath, changes, fetchDiffs]);

  const handleCommit = useCallback(async () => {
    if (!rootPath || !commitMsg.trim()) return;
    setCommitting(true);
    try {
      await api.gitCommitStaged(rootPath, commitMsg.trim());
      setCommitMsg("");
      setJustCommitted(true);
      addToast("Committed!", "success");
      fetchDiffs();
    } catch (e) {
      addToast(`Commit failed: ${e}`, "error");
    } finally {
      setCommitting(false);
    }
  }, [rootPath, commitMsg, fetchDiffs]);

  const handleShip = useCallback(() => {
    if (!rootPath) return;
    startShipSession(rootPath);
    closeOverlay();
  }, [rootPath, startShipSession, closeOverlay]);

  if (!open) return null;

  const activeFiles = activeTab === "unstaged" ? unstagedFiles : stagedFiles;
  const unstagedCount =
    (changes?.unstaged.length ?? 0) + (changes?.untracked.length ?? 0);
  const stagedCount = changes?.staged.length ?? 0;
  const hasStaged = stagedCount > 0;
  const folderName = rootPath?.split("/").pop() ?? "";
  const defaultExpanded = activeFiles.length <= 5;

  return (
    <div
      style={{
        ...overlayStyles.backdrop,
        transform: visible ? "translateY(0)" : "translateY(100%)",
        opacity: visible ? 1 : 0,
      }}
    >
      {/* Header */}
      <div style={overlayStyles.header}>
        <button onClick={closeOverlay} style={overlayStyles.backBtn}>
          ← Back
        </button>
        <span style={overlayStyles.title}>
          Changes — {folderName}
        </span>
        <span style={overlayStyles.branch}>{gitStatus?.branch ?? ""}</span>
        <button onClick={fetchDiffs} style={overlayStyles.refreshBtn} title="Refresh">
          ⟳
        </button>
      </div>

      {/* Tabs */}
      <div style={overlayStyles.tabs}>
        <button
          onClick={() => setActiveTab("unstaged")}
          style={
            activeTab === "unstaged"
              ? overlayStyles.tabActive
              : overlayStyles.tab
          }
        >
          Unstaged · {unstagedCount}
        </button>
        <button
          onClick={() => setActiveTab("staged")}
          style={
            activeTab === "staged"
              ? overlayStyles.tabActive
              : overlayStyles.tab
          }
        >
          Staged · {stagedCount}
        </button>
      </div>

      {/* File list */}
      <div style={overlayStyles.fileList}>
        {loading && activeFiles.length === 0 ? (
          <div style={overlayStyles.empty}>Loading...</div>
        ) : activeFiles.length === 0 ? (
          <div style={overlayStyles.empty}>
            {activeTab === "unstaged"
              ? "No unstaged changes"
              : "No staged changes"}
          </div>
        ) : (
          activeFiles.map((file) => (
            <DiffFileSection
              key={file.newPath || file.oldPath}
              file={file}
              defaultExpanded={defaultExpanded}
              tab={activeTab}
              onStage={handleStage}
              onUnstage={handleUnstage}
              onDiscard={handleDiscard}
            />
          ))
        )}
      </div>

      {/* Action bar */}
      <div style={overlayStyles.actionBar}>
        <div style={overlayStyles.actionRow}>
          {activeTab === "unstaged" && unstagedCount > 0 && (
            <button onClick={handleStageAll} style={overlayStyles.actionBtn}>
              + Stage All
            </button>
          )}
          {activeTab === "staged" && stagedCount > 0 && (
            <button onClick={handleUnstageAll} style={overlayStyles.actionBtn}>
              − Unstage All
            </button>
          )}
        </div>
        <div style={overlayStyles.commitRow}>
          <input
            ref={commitInputRef}
            type="text"
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleCommit();
              }
            }}
            placeholder="Commit message..."
            style={overlayStyles.commitInput}
            disabled={committing}
          />
          <button
            onClick={handleCommit}
            disabled={!hasStaged || !commitMsg.trim() || committing}
            style={{
              ...overlayStyles.commitBtn,
              opacity: hasStaged && commitMsg.trim() ? 1 : 0.4,
            }}
          >
            {committing ? "Committing..." : "Commit"}
          </button>
          {justCommitted && (
            <button onClick={handleShip} style={overlayStyles.shipBtn}>
              🚀 Ship
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const overlayStyles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "absolute",
    inset: 0,
    zIndex: 50,
    background: "#1a1a1a",
    display: "flex",
    flexDirection: "column",
    transition: "transform 200ms ease-out, opacity 150ms ease-out",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 16px",
    borderBottom: "1px solid #2a2a2a",
    flexShrink: 0,
  },
  backBtn: {
    background: "none",
    border: "1px solid #3f3f3f",
    borderRadius: 6,
    color: "#ccc",
    padding: "4px 10px",
    fontSize: 12,
    cursor: "pointer",
  },
  title: {
    fontSize: 14,
    fontWeight: 600,
    color: "#e6edf3",
    flex: 1,
  },
  branch: {
    fontSize: 12,
    color: "#8b949e",
    fontFamily: "'SF Mono', 'Menlo', monospace",
  },
  refreshBtn: {
    background: "none",
    border: "none",
    color: "#8b949e",
    fontSize: 16,
    cursor: "pointer",
    padding: "2px 6px",
    borderRadius: 4,
  },
  tabs: {
    display: "flex",
    gap: 0,
    padding: "0 16px",
    borderBottom: "1px solid #2a2a2a",
    flexShrink: 0,
  },
  tab: {
    padding: "8px 16px",
    background: "none",
    border: "none",
    borderBottom: "2px solid transparent",
    color: "#8b949e",
    fontSize: 13,
    cursor: "pointer",
    fontWeight: 500,
  },
  tabActive: {
    padding: "8px 16px",
    background: "none",
    border: "none",
    borderBottom: "2px solid #58a6ff",
    color: "#e6edf3",
    fontSize: 13,
    cursor: "pointer",
    fontWeight: 600,
  },
  fileList: {
    flex: 1,
    overflow: "auto",
    padding: "12px 16px",
  },
  empty: {
    color: "#666",
    fontSize: 13,
    textAlign: "center",
    padding: 40,
  },
  actionBar: {
    borderTop: "1px solid #2a2a2a",
    padding: "10px 16px",
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  actionRow: {
    display: "flex",
    gap: 8,
  },
  actionBtn: {
    fontSize: 12,
    padding: "5px 12px",
    borderRadius: 6,
    border: "1px solid #3f3f3f",
    background: "#2d2d2d",
    color: "#ccc",
    cursor: "pointer",
  },
  commitRow: {
    display: "flex",
    gap: 8,
    alignItems: "center",
  },
  commitInput: {
    flex: 1,
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid #3f3f3f",
    background: "#252525",
    color: "#e6edf3",
    fontSize: 13,
    outline: "none",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
  },
  commitBtn: {
    padding: "6px 16px",
    borderRadius: 6,
    border: "1px solid #1f6feb55",
    background: "#1f6feb33",
    color: "#58a6ff",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    flexShrink: 0,
  },
  shipBtn: {
    padding: "6px 16px",
    borderRadius: 6,
    border: "1px solid #3fb95055",
    background: "#3fb95022",
    color: "#3fb950",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    flexShrink: 0,
  },
};
```

---

### Task 8: Wire overlay into App.tsx and FileExplorer

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/FileExplorer.tsx`

**Step 1: Add overlay to App.tsx**

Import `GitDiffOverlay` at the top of App.tsx:

```typescript
import { GitDiffOverlay } from "./components/GitDiffOverlay";
```

In the JSX, wrap the `<PaneLayout />` and overlay together inside `styles.main` so the overlay positions absolutely relative to the main area. Replace line ~625-627:

```tsx
<div style={styles.main}>
  <PaneLayout />
  <GitDiffOverlay />
</div>
```

Also add `position: "relative"` to `styles.main` so the overlay's `position: absolute` is relative to the main area (not the entire window):

```typescript
main: {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  position: "relative",
},
```

**Step 2: Update FileExplorer to open overlay instead of inline changes**

In `FileExplorer.tsx`, the `GitStatusIcon` onClick currently calls `handleToggleChanges` which toggles the inline changes panel. We need to **also** open the overlay. Modify the `RootSection` component.

Add a store selector for `openGitDiffOverlay` inside `RootSection` (around line ~727):

```typescript
const openGitDiffOverlay = useWorkspaceStore((s) => s.openGitDiffOverlay);
```

Modify `handleToggleChanges` (line ~871) to open the overlay:

```typescript
const handleToggleChanges = useCallback(() => {
  if (repoCollapsed) setRepoCollapsed(false);
  openGitDiffOverlay(rootPath);
}, [repoCollapsed, setRepoCollapsed, openGitDiffOverlay, rootPath]);
```

This makes clicking the git status icon open the full overlay instead of toggling the inline changes panel. The inline `ChangesPanel` can still be toggled by other means if desired, but the primary entry point is now the overlay.

---

### Task 9: Add syntax highlighting CSS classes

**Files:**
- Modify: `src/App.tsx` (or add a `<style>` tag)

**Step 1: Inject syntax highlighting styles**

Since the project uses inline styles everywhere, we'll inject a minimal `<style>` block for the syntax token classes. In `App.tsx`, add inside the root div (before the closing tag):

```tsx
<style>{`
  .syn-comment { color: #6a737d; font-style: italic; }
  .syn-string { color: #a5d6ff; }
  .syn-keyword { color: #ff7b72; }
  .syn-literal { color: #79c0ff; }
  .syn-number { color: #d2a8ff; }
`}</style>
```

Add this right before `<ShipStatusPill />` in the App return JSX.

---

### Task 10: Build, test, and verify

**Step 1: Run type check**

Run: `./scripts/check.sh`
Expected: Clean pass for both Rust and TypeScript.

**Step 2: Build and launch**

Run: `./scripts/run.sh`
Expected: App builds and launches.

**Step 3: Manual testing checklist**

- Open a workspace with git changes
- Click the git status badge (the branch icon with change count)
- Verify overlay slides up from bottom
- Check Unstaged tab shows files with diffs
- Check Staged tab shows staged files
- Click file headers to collapse/expand
- Stage a file → verify it moves to Staged tab
- Unstage a file → verify it moves back
- Discard a file → verify confirmation works
- Stage All / Unstage All buttons
- Type a commit message → Commit
- Verify Ship button appears after commit
- Click Ship → verify overlay closes and ShipStatusPill appears
- Press Escape → verify overlay closes
- Click Back button → verify overlay closes

---

### Summary of All Files

**New files (5):**
- `src/lib/diffParser.ts` — unified diff parser
- `src/lib/syntaxHighlight.ts` — lightweight token coloring
- `src/components/DiffHunkView.tsx` — hunk line renderer
- `src/components/DiffFileSection.tsx` — collapsible file section
- `src/components/GitDiffOverlay.tsx` — main overlay component

**Modified files (6):**
- `src-tauri/src/git_ops.rs` — add `diff()` and `commit_staged()`
- `src-tauri/src/commands.rs` — add `git_diff` and `git_commit_staged` commands
- `src-tauri/src/main.rs` — register new commands in `generate_handler![]`
- `src/lib/tauri.ts` — add `gitDiff()` and `gitCommitStaged()` API wrappers
- `src/stores/workspaceStore.ts` — add overlay state and actions
- `src/App.tsx` — render `GitDiffOverlay`, add `position: relative` to main, add syntax CSS
- `src/components/FileExplorer.tsx` — wire GitStatusIcon to open overlay
