import React, { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/tauri";
import type { ParkedThread } from "../lib/types";

/**
 * Lists parked threads from ~/.rally/parked.json.
 * Auto-refreshes on `rally-thread-parked` event emitted by the cli_server
 * when the rally-park skill posts to /park.
 *
 * Each row exposes two hover-revealed icons: a copy button that writes a
 * resume prompt to the clipboard, and a discard × that removes the bookmark.
 * The copy icon briefly swaps to a checkmark to acknowledge the copy — no
 * banners, no toasts, no extra chrome.
 *
 * Resume itself is "soft": the clipboard prompt tells whatever Claude the
 * user pastes into to read the parked session JSONL by absolute path and
 * continue. Works cross-repo as long as origin matches. Bookmark stays until
 * explicitly discarded.
 */
export function ParkedThreadsPanel() {
  const [threads, setThreads] = useState<ParkedThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyFailedId, setCopyFailedId] = useState<string | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const copyClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api.getHomeDir().then(setHome).catch((e) => {
      console.error("[parked] getHomeDir failed", e);
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listParkedThreads();
      list.sort((a, b) => b.parked_at - a.parked_at);
      setThreads(list);
    } catch (e) {
      console.error("[parked] list failed", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const unlistenPromise = listen<ParkedThread>("rally-thread-parked", () => {
      refresh();
    });
    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, [refresh]);

  const handleDiscard = useCallback(
    async (id: string) => {
      try {
        await api.removeParkedThread(id);
        await refresh();
      } catch (e) {
        console.error("[parked] discard failed", e);
      }
    },
    [refresh],
  );

  const handleCopy = useCallback(
    async (thread: ParkedThread) => {
      try {
        const prompt = buildResumePrompt(thread, home);
        await navigator.clipboard.writeText(prompt);
        setCopiedId(thread.id);
        if (copyClearRef.current) clearTimeout(copyClearRef.current);
        copyClearRef.current = setTimeout(() => setCopiedId(null), 1200);
      } catch (e) {
        console.error("[parked] clipboard write failed", e);
        setCopyFailedId(thread.id);
        if (failClearRef.current) clearTimeout(failClearRef.current);
        failClearRef.current = setTimeout(() => setCopyFailedId(null), 1500);
      }
    },
    [home],
  );

  useEffect(() => {
    return () => {
      if (copyClearRef.current) clearTimeout(copyClearRef.current);
      if (failClearRef.current) clearTimeout(failClearRef.current);
    };
  }, []);

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.title}>Parked Threads</span>
        <span style={styles.count}>{threads.length}</span>
      </div>

      <div style={styles.body}>
        {loading && threads.length === 0 && (
          <div style={styles.emptyText}>Loading…</div>
        )}
        {!loading && threads.length === 0 && (
          <div style={styles.emptyBlock}>
            <div style={styles.emptyTitle}>No parked threads</div>
            <div style={styles.emptyDesc}>
              From inside Claude Code, run the{" "}
              <code style={styles.code}>rally-park</code> skill to stash the
              current branch + convo here.
            </div>
          </div>
        )}
        {threads.map((t) => {
          const repoName = t.repo.split("/").pop() || t.repo;
          const isHovered = hoveredId === t.id;
          const isCopied = copiedId === t.id;
          const isCopyFailed = copyFailedId === t.id;
          const actionsVisible = isHovered || isCopied || isCopyFailed;
          return (
            <div
              key={t.id}
              style={{
                ...styles.row,
                background: isHovered ? "var(--bg-hover)" : "transparent",
              }}
              onMouseEnter={() => setHoveredId(t.id)}
              onMouseLeave={() =>
                setHoveredId((curr) => (curr === t.id ? null : curr))
              }
              title={`${t.repo}\n${t.branch}`}
            >
              <div style={styles.rowMain}>
                <div style={styles.branch}>{t.branch}</div>
                {t.summary && (
                  <div style={styles.summary}>{t.summary}</div>
                )}
                <div style={styles.meta}>
                  <span>{repoName}</span>
                  <span style={styles.dot}>·</span>
                  <span>{formatRelative(t.parked_at)}</span>
                </div>
              </div>
              <button
                className="sidebar-btn"
                style={{
                  ...styles.iconBtn,
                  opacity: actionsVisible ? 1 : 0,
                  pointerEvents: actionsVisible ? "auto" : "none",
                  color: isCopyFailed
                    ? "rgba(220, 90, 90, 0.9)"
                    : isCopied
                      ? "var(--text-primary)"
                      : "var(--text-secondary)",
                }}
                onClick={() => handleCopy(t)}
                title={
                  isCopyFailed
                    ? "Clipboard write failed — check console"
                    : "Copy resume prompt to clipboard"
                }
              >
                {isCopied ? <CheckIcon /> : <CopyIcon />}
              </button>
              <button
                className="sidebar-btn"
                style={{
                  ...styles.iconBtn,
                  opacity: actionsVisible ? 1 : 0,
                  pointerEvents: actionsVisible ? "auto" : "none",
                }}
                onClick={() => handleDiscard(t.id)}
                title="Discard parked thread (does not delete branch)"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M3 3L9 9M9 3L3 9"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="3.5"
        y="3.5"
        width="6"
        height="7"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      <path
        d="M1.5 8.5V2A0.5 0.5 0 0 1 2 1.5h6.5"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2.5 6.2L4.8 8.5L9.5 3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Encode a repo path the way Claude Code names its per-project session dir.
 * Both `/` and `.` are replaced with `-`. Empirically Claude Code maps each
 * path separator AND each literal dot to a dash, so
 * `/Users/x/.config/foo` becomes `-Users-x--config-foo`.
 *
 * Example: /Users/splice/splice/flow → -Users-splice-splice-flow
 * Example: /Users/splice/splice/flow2/.claude/worktrees/x
 *          → -Users-splice-splice-flow2--claude-worktrees-x
 */
function encodeProjectDir(repoPath: string): string {
  return repoPath.replace(/[/.]/g, "-");
}

/**
 * Build the prompt that a fresh Claude (in any repo) should receive to
 * continue a parked thread. The resuming Claude reads the JSONL by absolute
 * path so it has the full prior conversation as context. The branch checkout
 * is best-effort — works if the resuming repo shares the parked repo's origin.
 *
 * We pass an absolute home path rather than `~` because Claude's file tools
 * don't always expand tildes.
 */
function buildResumePrompt(t: ParkedThread, home: string | null): string {
  const lines: string[] = [];
  lines.push(`Resume parked thread "${t.branch}".`);
  lines.push("");
  if (t.session_id) {
    const homePrefix = home ?? "~";
    const jsonl = `${homePrefix}/.claude/projects/${encodeProjectDir(t.repo)}/${t.session_id}.jsonl`;
    lines.push(`Read the full prior conversation at:`);
    lines.push(jsonl);
    lines.push("");
  }
  lines.push(
    `Make sure branch ${t.branch} is checked out in the current cwd ` +
      `(git fetch && git checkout if needed).`,
  );
  if (t.summary) {
    lines.push("");
    lines.push(`Prior work summary: ${t.summary}`);
  }
  lines.push("");
  lines.push(`Continue the work.`);
  return lines.join("\n");
}

function formatRelative(unixSecs: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSecs);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  const days = Math.floor(diff / 86400);
  if (days < 30) return `${days}d ago`;
  return new Date(unixSecs * 1000).toLocaleDateString();
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: "var(--bg-app)",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 8px 0 12px",
    minHeight: 29,
    maxHeight: 29,
    borderBottom: "1px solid var(--border)",
    flexShrink: 0,
  },
  title: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "var(--text-primary)",
  },
  count: {
    fontSize: 11,
    color: "var(--text-secondary)",
    fontVariantNumeric: "tabular-nums",
  },
  body: {
    flex: 1,
    minHeight: 0,
    overflow: "auto",
    padding: "4px 0",
    display: "flex",
    flexDirection: "column",
  },
  row: {
    display: "flex",
    alignItems: "flex-start",
    gap: 6,
    padding: "8px 10px 8px 12px",
    borderBottom: "1px solid var(--border)",
    cursor: "default",
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  branch: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
    lineHeight: 1.1,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  summary: {
    fontSize: 12,
    fontWeight: 500,
    color: "var(--text-primary)",
    opacity: 0.75,
    lineHeight: 1.35,
    display: "-webkit-box",
    WebkitLineClamp: 3,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
    whiteSpace: "normal",
    wordBreak: "break-word",
  },
  meta: {
    fontSize: 12,
    fontWeight: 500,
    color: "var(--text-primary)",
    opacity: 0.55,
    lineHeight: 1,
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  dot: {
    opacity: 0.5,
  },
  iconBtn: {
    flexShrink: 0,
    width: 18,
    height: 18,
    borderRadius: 4,
    border: "1px solid transparent",
    background: "transparent",
    color: "var(--text-secondary)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    transition: "opacity 120ms ease, color 120ms ease",
  },
  emptyText: {
    padding: "12px",
    fontSize: 11,
    color: "var(--text-secondary)",
  },
  emptyBlock: {
    padding: "16px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  emptyTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-primary)",
  },
  emptyDesc: {
    fontSize: 11,
    color: "var(--text-secondary)",
    lineHeight: 1.45,
  },
  code: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 10.5,
    padding: "1px 4px",
    background: "var(--bg-input)",
    borderRadius: 3,
  },
};
