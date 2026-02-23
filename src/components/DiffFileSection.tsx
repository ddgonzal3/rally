import React, { useState, useCallback, useEffect } from "react";
import type { DiffFile } from "../lib/diffParser";
import { DiffFileView } from "./DiffHunkView";

export function DiffFileSection({
  file,
  defaultExpanded,
  expandKey,
  tab,
  onStage,
  onUnstage,
  onDiscard,
  onHunkRevert,
  onHunkStage,
}: {
  file: DiffFile;
  defaultExpanded: boolean;
  expandKey?: number;
  tab: "unstaged" | "staged";
  onStage?: (filePath: string) => void;
  onUnstage?: (filePath: string) => void;
  onDiscard?: (filePath: string) => void;
  onHunkRevert?: (filePath: string, hunkIndex: number) => void;
  onHunkStage?: (filePath: string, hunkIndex: number) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // Reset expand state when expandKey changes (from expand/collapse all)
  useEffect(() => {
    setExpanded(defaultExpanded);
  }, [expandKey, defaultExpanded]);
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
        {file.isNew && <span style={styles.badge}>NEW</span>}
        {file.isDeleted && <span style={styles.badgeDelete}>DEL</span>}
        {file.isRenamed && <span style={styles.badgeRename}>REN</span>}
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
                  <span style={{ fontSize: 11, fontWeight: 600 }}>Confirm?</span>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 13 13" fill="none">
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
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
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
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M3 7h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
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
            <DiffFileView
              hunks={file.hunks}
              filePath={filePath}
              tab={tab}
              onHunkRevert={onHunkRevert ? (hi) => onHunkRevert(filePath, hi) : undefined}
              onHunkStage={onHunkStage ? (hi) => onHunkStage(filePath, hi) : undefined}
            />
          )}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  section: {
    marginBottom: 8,
    borderRadius: 10,
    border: "1px solid #2a2a2a",
    background: "#1e1e1e",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 14px",
    background: "#222",
    cursor: "pointer",
    userSelect: "none",
    borderBottom: "1px solid #2a2a2a",
    transition: "background 150ms",
  },
  chevron: {
    fontSize: 10,
    color: "#aaa",
    width: 14,
    flexShrink: 0,
  },
  fileName: {
    fontSize: 13,
    fontFamily: "'SF Mono', 'Menlo', monospace",
    fontWeight: 600,
    color: "#fff",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  stats: {
    display: "flex",
    gap: 6,
    fontSize: 12,
    fontFamily: "'SF Mono', 'Menlo', monospace",
    fontWeight: 600,
    flexShrink: 0,
    marginRight: "auto",
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
    padding: "2px 7px",
    borderRadius: 10,
    background: "rgba(63, 185, 80, 0.12)",
    color: "#3fb950",
    flexShrink: 0,
  },
  badgeDelete: {
    fontSize: 10,
    fontWeight: 600,
    padding: "2px 7px",
    borderRadius: 10,
    background: "rgba(248, 81, 73, 0.12)",
    color: "#f85149",
    flexShrink: 0,
  },
  badgeRename: {
    fontSize: 10,
    fontWeight: 600,
    padding: "2px 7px",
    borderRadius: 10,
    background: "rgba(210, 153, 34, 0.12)",
    color: "#d29922",
    flexShrink: 0,
  },
  actions: {
    display: "flex",
    gap: 0,
    flexShrink: 0,
    background: "#2a2a2a",
    border: "1px solid #3a3a3a",
    borderRadius: 20,
    overflow: "hidden",
  },
  iconBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    borderRadius: 0,
    border: "none",
    background: "transparent",
    color: "#bbb",
    cursor: "pointer",
    transition: "color 150ms, background 150ms",
  },
  iconBtnDanger: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 28,
    height: 28,
    borderRadius: 0,
    border: "none",
    background: "rgba(248, 81, 73, 0.15)",
    color: "#f85149",
    cursor: "pointer",
    padding: "0 6px",
    transition: "color 150ms, background 150ms",
  },
  hunks: {
    padding: 0,
  },
  noContent: {
    padding: "12px 0",
    color: "#888",
    fontSize: 12,
    fontStyle: "italic",
    textAlign: "center",
  },
};
