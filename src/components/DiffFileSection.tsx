import React, { useState, useCallback, useEffect, useMemo } from "react";
import type { DiffFile } from "../lib/diffParser";
import { DiffFileView } from "./DiffHunkView";

export function DiffFileSection({
  file,
  defaultExpanded,
  expandKey,
  tab,
  maxLinesBeforeCollapse,
  onStage,
  onUnstage,
  onDiscard,
}: {
  file: DiffFile;
  defaultExpanded: boolean;
  expandKey?: number;
  tab: "unstaged" | "staged" | "pr";
  maxLinesBeforeCollapse?: number;
  onStage?: (filePath: string) => void;
  onUnstage?: (filePath: string) => void;
  onDiscard?: (filePath: string) => void;
}) {
  const totalDiffLines = useMemo(
    () => file.hunks.reduce((sum, h) => sum + h.lines.length, 0),
    [file.hunks],
  );
  const isLargeDiff = maxLinesBeforeCollapse != null && totalDiffLines > maxLinesBeforeCollapse;

  const [expanded, setExpanded] = useState(isLargeDiff ? false : defaultExpanded);

  // Reset expand state when expandKey changes (from expand/collapse all)
  useEffect(() => {
    setExpanded(isLargeDiff ? false : defaultExpanded);
  }, [expandKey, defaultExpanded, isLargeDiff]);
  const [confirming, setConfirming] = useState(false);
  const filePath = file.newPath || file.oldPath;

  const handleDiscard = useCallback(() => {
    if (!confirming) {
      setConfirming(true);
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
        {file.isNew && <span style={styles.badge}>New</span>}
        {file.isDeleted && <span style={styles.badgeDelete}>Del</span>}
        {file.isRenamed && <span style={styles.badgeRename}>Ren</span>}
        <div style={styles.actions} onClick={(e) => e.stopPropagation()}>
          {tab === "unstaged" && (
            <>
              <button
                className="hunk-action-btn"
                onClick={handleDiscard}
                style={confirming ? styles.iconBtnDanger : styles.iconBtn}
                title={confirming ? "Click again to confirm" : "Discard changes"}
              >
                {confirming ? (
                  <span style={{ fontSize: 10, fontWeight: 600 }}>Confirm?</span>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 13 13" fill="none">
                    <path d="M4 3.2V6h2.8M4 6c0-2.2 1.8-4 4-4a4 4 0 1 1-3.1 6.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
              <button
                className="hunk-action-btn"
                onClick={() => onStage?.(filePath)}
                style={styles.iconBtn}
                title="Stage file"
              >
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                  <path d="M7 3v8M3 7h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </>
          )}
          {tab === "staged" && (
            <button
              className="hunk-action-btn"
              onClick={() => onUnstage?.(filePath)}
              style={styles.iconBtn}
              title="Unstage file"
            >
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                <path d="M3 7h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {expanded ? (
        <div style={styles.hunks}>
          {file.hunks.length === 0 ? (
            <div style={styles.noContent}>
              {file.isNew ? "New file" : file.isDeleted ? "File deleted" : "Binary file or no content"}
            </div>
          ) : (
            <DiffFileView
              hunks={file.hunks}
              filePath={filePath}
            />
          )}
        </div>
      ) : isLargeDiff ? (
        <div
          style={styles.largeDiffMessage}
          onClick={() => setExpanded(true)}
        >
          Large diff not rendered — {totalDiffLines} lines. Click to load.
        </div>
      ) : null}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  section: {
    marginBottom: 8,
    borderRadius: 10,
    border: "1px solid var(--border)",
    background: "var(--bg-elevated)",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 10px",
    background: "var(--bg-elevated)",
    cursor: "pointer",
    userSelect: "none",
    borderBottom: "1px solid var(--border)",
    transition: "background 150ms",
    minWidth: 0,
  },
  chevron: {
    fontSize: 10,
    color: "var(--text-secondary)",
    width: 14,
    flexShrink: 0,
  },
  fileName: {
    fontSize: 12,
    fontFamily: "'SF Mono', 'Menlo', monospace",
    fontWeight: 600,
    color: "var(--text-primary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
    flex: 1,
  },
  stats: {
    display: "flex",
    alignItems: "baseline",
    gap: 4,
    fontSize: 12,
    fontFamily: "'SF Mono', 'Menlo', monospace",
    fontWeight: 600,
    flexShrink: 0,
  },
  additions: {
    color: "var(--status-green)",
  },
  deletions: {
    color: "var(--status-red)",
  },
  badge: {
    fontSize: 11,
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: 8,
    background: "rgba(63, 185, 80, 0.12)",
    color: "var(--status-green)",
    letterSpacing: "-0.01em",
    lineHeight: "16px",
    flexShrink: 0,
  },
  badgeDelete: {
    fontSize: 11,
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: 8,
    background: "rgba(248, 81, 73, 0.12)",
    color: "var(--status-red)",
    letterSpacing: "-0.01em",
    lineHeight: "16px",
    flexShrink: 0,
  },
  badgeRename: {
    fontSize: 11,
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: 8,
    background: "rgba(210, 153, 34, 0.12)",
    color: "var(--status-amber)",
    letterSpacing: "-0.01em",
    lineHeight: "16px",
    flexShrink: 0,
  },
  actions: {
    display: "flex",
    gap: 0,
    flexShrink: 0,
    background: "var(--bg-hover)",
    border: "1px solid var(--border-subtle)",
    borderRadius: 14,
    overflow: "hidden",
  },
  iconBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 22,
    borderRadius: 0,
    border: "none",
    background: "transparent",
    color: "var(--text-secondary)",
    cursor: "pointer",
    transition: "color 150ms, background 150ms",
  },
  iconBtnDanger: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 24,
    height: 22,
    borderRadius: 0,
    border: "none",
    background: "rgba(248, 81, 73, 0.15)",
    color: "var(--status-red)",
    cursor: "pointer",
    padding: "0 5px",
    transition: "color 150ms, background 150ms",
  },
  hunks: {
    padding: 0,
  },
  noContent: {
    padding: "12px 0",
    color: "var(--text-dim)",
    fontSize: 12,
    fontStyle: "italic",
    textAlign: "center",
  },
  largeDiffMessage: {
    padding: "14px 20px",
    textAlign: "center",
    color: "var(--text-primary)",
    fontSize: 12,
    cursor: "pointer",
    background: "var(--bg-app)",
    fontWeight: 500,
    transition: "background 150ms",
  },
};
