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
  const scrollToFile = useWorkspaceStore((s) => s.gitDiffScrollToFile);
  const gitStatus = useWorkspaceStore((s) =>
    rootPath ? s.gitStatuses[rootPath] : undefined,
  );

  const [unstagedFiles, setUnstagedFiles] = useState<DiffFile[]>([]);
  const [stagedFiles, setStagedFiles] = useState<DiffFile[]>([]);
  const [changes, setChanges] = useState<ChangesSummary | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  const [justCommitted, setJustCommitted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  // expandKey changes to signal DiffFileSection to reset to expanded/collapsed
  const [expandKey, setExpandKey] = useState(0);
  const [defaultExpanded, setDefaultExpanded] = useState(true);
  const commitInputRef = useRef<HTMLInputElement>(null);
  const fileListRef = useRef<HTMLDivElement>(null);

  // Mount/unmount with animation delay
  useEffect(() => {
    if (open) {
      setMounted(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      // Keep mounted during slide-out animation, then unmount
      const timer = setTimeout(() => setMounted(false), 400);
      return () => clearTimeout(timer);
    }
  }, [open]);

  const fetchDiffs = useCallback(async () => {
    if (!rootPath) return;
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
    }
  }, [rootPath]);

  // Fetch on open + handle single-file mode
  useEffect(() => {
    if (open && rootPath) {
      setJustCommitted(false);
      setCommitMsg("");
      setScrollTarget(scrollToFile ?? null);
      fetchDiffs();
    }
  }, [open, rootPath, scrollToFile, fetchDiffs]);

  // Scroll to target file after diffs load
  useEffect(() => {
    if (!scrollTarget || !fileListRef.current) return;
    requestAnimationFrame(() => {
      const container = fileListRef.current;
      const el = container?.querySelector(
        `[data-filepath="${CSS.escape(scrollTarget)}"]`,
      ) as HTMLElement | null;
      if (el && container) {
        // Calculate distance to decide scroll behavior
        const containerRect = container.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const distance = Math.abs(elRect.top - containerRect.top - container.scrollTop);
        // Short distances get smooth scroll, long distances get instant
        const behavior = distance > container.clientHeight * 2 ? "instant" : "smooth";
        el.scrollIntoView({ behavior, block: "start" });
        setScrollTarget(null);
      }
    });
  }, [scrollTarget, unstagedFiles, stagedFiles]);

  // Auto-refresh on local git changes
  useEffect(() => {
    if (!open) return;
    const handler = () => fetchDiffs();
    document.addEventListener("rally:git-changes-refresh", handler);
    return () =>
      document.removeEventListener("rally:git-changes-refresh", handler);
  }, [open, fetchDiffs]);

  // Escape key to close — keyed on mounted so it works during slide-out too
  useEffect(() => {
    if (!mounted || !open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        closeOverlay();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [mounted, open, closeOverlay]);

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
    await fetchDiffs();
    setActiveTab("staged");
    setDefaultExpanded(false);
    setExpandKey((k) => k + 1);
  }, [rootPath, changes, fetchDiffs, setActiveTab]);

  const handleUnstageAll = useCallback(async () => {
    if (!rootPath || !changes) return;
    for (const f of changes.staged) {
      await api.gitUnstageFile(rootPath, f.path);
    }
    await fetchDiffs();
    setActiveTab("unstaged");
    setDefaultExpanded(false);
    setExpandKey((k) => k + 1);
  }, [rootPath, changes, fetchDiffs, setActiveTab]);

  const handleCommit = useCallback(async () => {
    if (!rootPath || !commitMsg.trim()) return;
    setCommitting(true);
    try {
      await api.gitCommitStaged(rootPath, commitMsg.trim());
      setCommitMsg("");
      setJustCommitted(true);
      addToast({ type: "success", title: "Committed!", message: "" });
      fetchDiffs();
    } catch (e) {
      addToast({ type: "warning", title: "Commit failed", message: String(e) });
    } finally {
      setCommitting(false);
    }
  }, [rootPath, commitMsg, fetchDiffs]);

  const handleShip = useCallback(() => {
    if (!rootPath) return;
    startShipSession(rootPath);
    closeOverlay();
  }, [rootPath, startShipSession, closeOverlay]);

  if (!mounted) return null;

  const activeFiles = activeTab === "unstaged" ? unstagedFiles : stagedFiles;
  const unstagedCount = unstagedFiles.length;
  const stagedCount = stagedFiles.length;
  const hasStaged = stagedCount > 0;
  const folderName = rootPath?.split("/").pop() ?? "";

  return (
    <div
      style={{
        ...s.backdrop,
        transform: visible ? "translateX(0)" : "translateX(100%)",
      }}
    >
      {/* Header */}
      <div style={s.header}>
        <button onClick={closeOverlay} style={s.backBtn}>
          ← Back
        </button>
        <span style={s.title}>
          Changes — {folderName}
        </span>
        <span style={s.branch}>{gitStatus?.branch ?? ""}</span>
      </div>

      {/* Tabs */}
      <div style={s.tabs}>
        <button
          onClick={() => setActiveTab("unstaged")}
          style={activeTab === "unstaged" ? s.tabActive : s.tab}
        >
          Unstaged · {unstagedCount}
        </button>
        <button
          onClick={() => setActiveTab("staged")}
          style={activeTab === "staged" ? s.tabActive : s.tab}
        >
          Staged · {stagedCount}
        </button>
        <div style={{ flex: 1 }} />
        {activeFiles.length > 0 && (
          <button
            onClick={() => {
              setDefaultExpanded((v) => !v);
              setExpandKey((k) => k + 1);
            }}
            style={s.expandCollapseBtn}
            title={defaultExpanded ? "Collapse all" : "Expand all"}
          >
            {defaultExpanded ? "Collapse all" : "Expand all"}
          </button>
        )}
      </div>

      {/* File list */}
      <div ref={fileListRef} style={s.fileList}>
        {activeFiles.length === 0 ? (
          <div style={s.empty}>
            {activeTab === "unstaged"
              ? "No unstaged changes"
              : "No staged changes"}
          </div>
        ) : (
          activeFiles.map((file) => (
            <div key={file.newPath || file.oldPath} data-filepath={file.newPath || file.oldPath}>
              <DiffFileSection
                file={file}
                defaultExpanded={defaultExpanded}
                expandKey={expandKey}
                tab={activeTab}
                onStage={handleStage}
                onUnstage={handleUnstage}
                onDiscard={handleDiscard}
              />
            </div>
          ))
        )}
      </div>

      {/* Action bar */}
      <div style={s.actionBar}>
        <div style={s.actionRow}>
          {activeTab === "unstaged" && unstagedCount > 0 && (
            <button onClick={handleStageAll} style={s.actionBtn}>
              Stage All
            </button>
          )}
          {activeTab === "staged" && stagedCount > 0 && (
            <button onClick={handleUnstageAll} style={s.actionBtn}>
              Unstage All
            </button>
          )}
          {justCommitted && (
            <button onClick={handleShip} style={s.shipBtn}>
              Ship
            </button>
          )}
        </div>
        <div style={s.commitRow}>
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
            style={s.commitInput}
            disabled={committing}
          />
          <button
            onClick={handleCommit}
            disabled={!hasStaged || !commitMsg.trim() || committing}
            style={{
              ...s.commitBtn,
              opacity: hasStaged && commitMsg.trim() ? 1 : 0.4,
            }}
          >
            {committing ? "Committing..." : "Commit"}
          </button>
        </div>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "absolute",
    inset: 0,
    zIndex: 50,
    background: "#1a1a1a",
    display: "flex",
    flexDirection: "column",
    transition: "transform 350ms cubic-bezier(0.4, 0, 0.2, 1)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "12px 20px",
    borderBottom: "1px solid #2a2a2a",
    flexShrink: 0,
  },
  backBtn: {
    background: "#2a2a2a",
    border: "none",
    borderRadius: 20,
    color: "#aaa",
    padding: "5px 14px",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    letterSpacing: "0.01em",
    lineHeight: "16px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "background 150ms, color 150ms",
  },
  title: {
    fontSize: 14,
    fontWeight: 600,
    color: "#e6edf3",
    flex: 1,
    letterSpacing: "-0.01em",
  },
  branch: {
    fontSize: 12,
    color: "#aaa",
    fontFamily: "'SF Mono', 'Menlo', monospace",
    background: "#2a2a2a",
    padding: "5px 14px",
    borderRadius: 20,
    lineHeight: "16px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  },
  tabs: {
    display: "flex",
    alignItems: "center",
    gap: 0,
    padding: "0 20px",
    borderBottom: "1px solid #2a2a2a",
    flexShrink: 0,
  },
  expandCollapseBtn: {
    background: "none",
    border: "none",
    color: "#6e7681",
    fontSize: 11,
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: 8,
    transition: "color 150ms",
  },
  tab: {
    padding: "10px 18px",
    background: "none",
    border: "none",
    borderBottom: "2px solid transparent",
    color: "#6e7681",
    fontSize: 13,
    cursor: "pointer",
    fontWeight: 500,
    letterSpacing: "0.01em",
    transition: "color 150ms",
  },
  tabActive: {
    padding: "10px 18px",
    background: "none",
    border: "none",
    borderBottom: "2px solid #e6edf3",
    color: "#e6edf3",
    fontSize: 13,
    cursor: "pointer",
    fontWeight: 600,
    letterSpacing: "0.01em",
  },
  fileList: {
    flex: 1,
    overflow: "auto",
    padding: "16px 20px",
    scrollPaddingTop: 8,
  },
  empty: {
    color: "#484f58",
    fontSize: 13,
    textAlign: "center",
    padding: 48,
    fontWeight: 500,
  },
  actionBar: {
    borderTop: "1px solid #2a2a2a",
    padding: "12px 20px",
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  actionRow: {
    display: "flex",
    gap: 8,
  },
  actionBtn: {
    fontSize: 12,
    fontWeight: 500,
    padding: "5px 14px",
    borderRadius: 20,
    border: "none",
    background: "#2a2a2a",
    color: "#ccc",
    cursor: "pointer",
    letterSpacing: "0.01em",
    lineHeight: "16px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "background 150ms, color 150ms",
  },
  commitRow: {
    display: "flex",
    gap: 8,
    alignItems: "center",
  },
  commitInput: {
    flex: 1,
    padding: "8px 14px",
    borderRadius: 10,
    border: "1px solid #333",
    background: "#222",
    color: "#e6edf3",
    fontSize: 13,
    outline: "none",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
    transition: "border-color 150ms",
  },
  commitBtn: {
    padding: "8px 20px",
    borderRadius: 10,
    border: "none",
    background: "#e6edf3",
    color: "#1a1a1a",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    flexShrink: 0,
    letterSpacing: "-0.01em",
    transition: "opacity 150ms",
  },
  shipBtn: {
    padding: "5px 14px",
    borderRadius: 20,
    border: "none",
    background: "#3fb950",
    color: "#fff",
    fontSize: 12,
    lineHeight: "16px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 600,
    cursor: "pointer",
    flexShrink: 0,
    letterSpacing: "0.01em",
    transition: "background 150ms",
  },
};
