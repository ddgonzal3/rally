import React, { useState, useCallback, useEffect } from "react";
import type { DiffFile } from "../lib/diffParser";
import { DiffHunkView } from "./DiffHunkView";

export function DiffFileSection({
  file,
  defaultExpanded,
  expandKey,
  tab,
  onStage,
  onUnstage,
  onDiscard,
}: {
  file: DiffFile;
  defaultExpanded: boolean;
  expandKey?: number;
  tab: "unstaged" | "staged";
  onStage?: (filePath: string) => void;
  onUnstage?: (filePath: string) => void;
  onDiscard?: (filePath: string) => void;
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
    marginBottom: 4,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 14px",
    background: "#222",
    borderRadius: 12,
    cursor: "pointer",
    userSelect: "none",
    border: "1px solid #2a2a2a",
    transition: "background 150ms",
  },
  chevron: {
    fontSize: 10,
    color: "#666",
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
    gap: 6,
    flexShrink: 0,
  },
  btn: {
    fontSize: 11,
    fontWeight: 500,
    padding: "4px 12px",
    borderRadius: 14,
    border: "none",
    background: "#2d2d2d",
    color: "#aaa",
    cursor: "pointer",
    letterSpacing: "0.01em",
    transition: "background 150ms, color 150ms",
  },
  btnPrimary: {
    fontSize: 11,
    fontWeight: 500,
    padding: "4px 12px",
    borderRadius: 14,
    border: "none",
    background: "#e6edf3",
    color: "#1a1a1a",
    cursor: "pointer",
    letterSpacing: "0.01em",
    transition: "background 150ms",
  },
  btnDanger: {
    fontSize: 11,
    fontWeight: 500,
    padding: "4px 12px",
    borderRadius: 14,
    border: "none",
    background: "#f85149",
    color: "#fff",
    cursor: "pointer",
    letterSpacing: "0.01em",
    transition: "background 150ms",
  },
  hunks: {
    padding: "4px 14px 8px 14px",
  },
  noContent: {
    padding: "12px 0",
    color: "#484f58",
    fontSize: 12,
    fontStyle: "italic",
    textAlign: "center",
  },
};
