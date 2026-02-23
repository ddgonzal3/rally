import React, { useState, useEffect, useCallback, useRef } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { api } from "../lib/tauri";
import { parseUnifiedDiff, generateHunkPatch, createUntrackedDiffFile, type DiffFile } from "../lib/diffParser";
import { DiffFileSection } from "./DiffFileSection";
import { CommitModal } from "./CommitModal";
import { addToast } from "./ToastContainer";
import type { ChangesSummary, CommitEntry } from "../lib/types";
import { relativeTime } from "../lib/time";

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
  const mainBranch = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => rootPath && w.paths.includes(rootPath));
    return ws?.main_branch ?? "main";
  });

  const [unstagedFiles, setUnstagedFiles] = useState<DiffFile[]>([]);
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [commitsExpanded, setCommitsExpanded] = useState(true);
  const [stagedFiles, setStagedFiles] = useState<DiffFile[]>([]);
  const [changes, setChanges] = useState<ChangesSummary | null>(null);
  const [diffStatAdd, setDiffStatAdd] = useState(0);
  const [diffStatDel, setDiffStatDel] = useState(0);
  const [commitModalOpen, setCommitModalOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  // expandKey changes to signal DiffFileSection to reset to expanded/collapsed
  const [expandKey, setExpandKey] = useState(0);
  const [defaultExpanded, setDefaultExpanded] = useState(true);
  const fileListRef = useRef<HTMLDivElement>(null);
  const commitBtnRef = useRef<HTMLButtonElement>(null);

  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      const timer = setTimeout(() => setMounted(false), 80);
      return () => clearTimeout(timer);
    }
  }, [open]);

  const fetchDiffs = useCallback(async () => {
    if (!rootPath) return;
    try {
      const [unstagedRaw, stagedRaw, changesData, stat, commitLog] = await Promise.all([
        api.gitDiff(rootPath, false),
        api.gitDiff(rootPath, true),
        api.gitChanges(rootPath),
        api.gitDiffStat(rootPath),
        api.gitCommitLog(rootPath, mainBranch).catch(() => [] as CommitEntry[]),
      ]);
      const parsedUnstaged = parseUnifiedDiff(unstagedRaw);

      // Synthesize diff entries for untracked files (git diff doesn't include them)
      if (changesData.untracked.length > 0) {
        const untrackedDiffs = await Promise.all(
          changesData.untracked.map(async (filePath) => {
            try {
              const fullPath = `${rootPath}/${filePath}`;
              const content = await api.readFileContent(fullPath);
              return createUntrackedDiffFile(filePath, content);
            } catch {
              // Binary or unreadable file — create empty diff entry
              return createUntrackedDiffFile(filePath, "");
            }
          }),
        );
        parsedUnstaged.push(...untrackedDiffs);
      }

      setUnstagedFiles(parsedUnstaged);
      setStagedFiles(parseUnifiedDiff(stagedRaw));
      setChanges(changesData);
      setDiffStatAdd(stat[0]);
      setDiffStatDel(stat[1]);
      setCommits(commitLog);
    } catch (e) {
      console.error("Failed to fetch diffs:", e);
    }
  }, [rootPath, mainBranch]);

  // Fetch on open + handle single-file mode
  useEffect(() => {
    if (open && rootPath) {
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
      try {
        await api.gitStageFile(rootPath, filePath);
      } catch (e) {
        addToast({ type: "warning", title: "Stage failed", message: String(e) });
      }
      fetchDiffs();
    },
    [rootPath, fetchDiffs],
  );

  const handleUnstage = useCallback(
    async (filePath: string) => {
      if (!rootPath) return;
      try {
        await api.gitUnstageFile(rootPath, filePath);
      } catch (e) {
        addToast({ type: "warning", title: "Unstage failed", message: String(e) });
      }
      fetchDiffs();
    },
    [rootPath, fetchDiffs],
  );

  const handleDiscard = useCallback(
    async (filePath: string) => {
      if (!rootPath || !changes) return;
      try {
        const isUntracked = changes.untracked.includes(filePath);
        await api.gitDiscardFile(rootPath, filePath, isUntracked);
      } catch (e) {
        addToast({ type: "warning", title: "Discard failed", message: String(e) });
      }
      fetchDiffs();
    },
    [rootPath, changes, fetchDiffs],
  );

  const handleHunkRevert = useCallback(
    async (filePath: string, hunkIndex: number) => {
      if (!rootPath) return;
      try {
        const file = unstagedFiles.find((f) => (f.newPath || f.oldPath) === filePath);
        if (!file || !file.hunks[hunkIndex]) return;
        const patch = generateHunkPatch(file, file.hunks[hunkIndex]);
        await api.gitApplyPatch(rootPath, patch, true, false);
      } catch (e) {
        addToast({ type: "warning", title: "Revert failed", message: String(e) });
      }
      fetchDiffs();
    },
    [rootPath, unstagedFiles, fetchDiffs],
  );

  const handleHunkStage = useCallback(
    async (filePath: string, hunkIndex: number) => {
      if (!rootPath) return;
      try {
        if (activeTab === "unstaged") {
          const file = unstagedFiles.find((f) => (f.newPath || f.oldPath) === filePath);
          if (!file || !file.hunks[hunkIndex]) return;
          const patch = generateHunkPatch(file, file.hunks[hunkIndex]);
          await api.gitApplyPatch(rootPath, patch, false, true);
        } else {
          // Unstage a specific hunk from staged
          const file = stagedFiles.find((f) => (f.newPath || f.oldPath) === filePath);
          if (!file || !file.hunks[hunkIndex]) return;
          const patch = generateHunkPatch(file, file.hunks[hunkIndex]);
          await api.gitApplyPatch(rootPath, patch, true, true);
        }
      } catch (e) {
        addToast({ type: "warning", title: "Hunk action failed", message: String(e) });
      }
      fetchDiffs();
    },
    [rootPath, activeTab, unstagedFiles, stagedFiles, fetchDiffs],
  );

  const [revertConfirming, setRevertConfirming] = useState(false);

  const handleRevertAll = useCallback(async () => {
    if (!rootPath || !changes) return;
    if (!revertConfirming) {
      setRevertConfirming(true);
      setTimeout(() => setRevertConfirming(false), 3000);
      return;
    }
    setRevertConfirming(false);
    const allFiles = [
      ...changes.unstaged.map((f) => f.path),
      ...changes.untracked,
    ];
    for (const f of allFiles) {
      const isUntracked = changes.untracked.includes(f);
      await api.gitDiscardFile(rootPath, f, isUntracked);
    }
    fetchDiffs();
  }, [rootPath, changes, revertConfirming, fetchDiffs]);

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

  const handleShip = useCallback(() => {
    if (!rootPath) return;
    startShipSession(rootPath);
    closeOverlay();
  }, [rootPath, startShipSession, closeOverlay]);

  // relativeTime imported from lib/time.ts

  if (!mounted) return null;

  const activeFiles = activeTab === "unstaged" ? unstagedFiles : stagedFiles;
  // Use git status counts (source of truth) for tab badges,
  // not diff-parsed file counts which may miss new/binary files
  const unstagedCount = (changes?.unstaged.length ?? 0) + (changes?.untracked.length ?? 0);
  const stagedCount = changes?.staged.length ?? 0;
  const hasStaged = stagedCount > 0;
  const folderName = rootPath?.split("/").pop() ?? "";

  return (
    <div
      className="git-diff-overlay"
      style={{
        ...s.backdrop,
        opacity: visible ? 1 : 0,
      }}
    >
      {/* Header */}
      <div style={s.header}>
        <button onClick={closeOverlay} style={s.backBtn} title="Back">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
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
        <span style={s.repoName}>{folderName}</span>
        <div style={{ flex: 1 }} />
        {/* Branch pill + bulk actions (moved from footer) */}
        <span style={s.branchPill}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="#ddd" style={{ flexShrink: 0 }}>
            <path d="M21.007 8.222A3.738 3.738 0 0 0 15.045 5.2a3.737 3.737 0 0 0 1.156 6.583 2.988 2.988 0 0 1-2.668 1.67h-2.99a4.456 4.456 0 0 0-2.989 1.165V7.4a3.737 3.737 0 1 0-1.494 0v9.117a3.776 3.776 0 1 0 1.816.099 2.99 2.99 0 0 1 2.668-1.667h2.99a4.484 4.484 0 0 0 4.223-3.039 3.736 3.736 0 0 0 3.25-3.687zM4.565 3.738a2.242 2.242 0 1 1 4.484 0 2.242 2.242 0 0 1-4.484 0zm4.484 16.441a2.242 2.242 0 1 1-4.484 0 2.242 2.242 0 0 1 4.484 0zm8.221-9.715a2.242 2.242 0 1 1 0-4.485 2.242 2.242 0 0 1 0 4.485z" />
          </svg>
          {gitStatus?.branch ?? ""}
        </span>
        {activeTab === "unstaged" && unstagedCount > 0 && (
          <>
            <button onClick={handleRevertAll} style={revertConfirming ? s.bulkActionBtnDanger : s.bulkActionBtn}>
              {revertConfirming ? "Confirm?" : "Revert all"}
            </button>
            <button onClick={handleStageAll} style={s.bulkActionBtn}>
              Stage all
            </button>
          </>
        )}
        {activeTab === "staged" && stagedCount > 0 && (
          <button onClick={handleUnstageAll} style={s.bulkActionBtn}>
            Unstage all
          </button>
        )}
        {/* Diff stats */}
        {(diffStatAdd > 0 || diffStatDel > 0) && (
          <span style={s.diffStats}>
            {diffStatAdd > 0 && <span style={{ color: "#3fb950" }}>+{diffStatAdd}</span>}
            {diffStatAdd > 0 && diffStatDel > 0 && " "}
            {diffStatDel > 0 && <span style={{ color: "#f85149" }}>-{diffStatDel}</span>}
          </span>
        )}
        <button
          ref={commitBtnRef}
          onClick={() => setCommitModalOpen(true)}
          disabled={!hasStaged && unstagedCount === 0}
          style={{
            ...s.headerCommitBtn,
            opacity: hasStaged || unstagedCount > 0 ? 1 : 0.4,
          }}
        >
          Commit
        </button>
      </div>

      {/* File list */}
      <div ref={fileListRef} style={s.fileList}>
        {/* Commits section */}
        {commits.length > 0 && (
          <div style={s.commitsSection}>
            <button
              onClick={() => setCommitsExpanded((v) => !v)}
              style={s.commitsSectionHeader}
              className="changes-section-btn"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                style={{ transform: commitsExpanded ? "rotate(90deg)" : "none", flexShrink: 0 }}
              >
                <path d="M4 2.4L8 6L4 9.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span style={s.commitsSectionTitle}>Commits</span>
              <span style={s.commitsBadge}>{commits.length}</span>
            </button>
            {commitsExpanded && (
              <div style={s.commitsBody}>
                {commits.map((c) => (
                  <div key={c.sha} style={s.commitRow}>
                    <span style={s.commitSha}>{c.sha.slice(0, 7)}</span>
                    <span style={s.commitMsg}>{c.message}</span>
                    <span style={s.commitDate}>{relativeTime(c.date)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

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
                onHunkRevert={handleHunkRevert}
                onHunkStage={handleHunkStage}
              />
            </div>
          ))
        )}
      </div>

      {/* Commit Modal */}
      <CommitModal
        open={commitModalOpen}
        onClose={() => setCommitModalOpen(false)}
        rootPath={rootPath ?? ""}
        branch={gitStatus?.branch ?? ""}
        stagedCount={stagedCount}
        unstagedCount={unstagedCount}
        additions={diffStatAdd}
        deletions={diffStatDel}
        onCommitted={fetchDiffs}
        onShip={handleShip}
        anchorRef={commitBtnRef}
      />
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
    transition: "opacity 75ms ease",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "0 16px",
    borderBottom: "1px solid #2a2a2a",
    flexShrink: 0,
    position: "relative",
  },
  backBtn: {
    background: "none",
    border: "none",
    color: "#999",
    cursor: "pointer",
    padding: "8px 6px 8px 2px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "color 150ms",
  },
  repoName: {
    position: "absolute",
    left: "50%",
    transform: "translateX(-50%)",
    fontSize: 13,
    color: "#e6edf3",
    fontWeight: 600,
    pointerEvents: "none",
  },
  tab: {
    padding: "10px 12px",
    background: "none",
    border: "none",
    borderBottom: "2px solid transparent",
    color: "#999",
    fontSize: 13,
    cursor: "pointer",
    fontWeight: 500,
    transition: "color 150ms",
  },
  tabActive: {
    padding: "10px 12px",
    background: "none",
    border: "none",
    borderBottom: "2px solid #e6edf3",
    color: "#e6edf3",
    fontSize: 13,
    cursor: "pointer",
    fontWeight: 600,
  },
  fileList: {
    flex: 1,
    overflow: "auto",
    padding: "16px 20px",
    scrollPaddingTop: 8,
  },
  empty: {
    color: "#888",
    fontSize: 13,
    textAlign: "center",
    padding: 48,
    fontWeight: 500,
  },
  branchPill: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 11,
    color: "#ddd",
    fontFamily: "'SF Mono', 'Menlo', monospace",
    fontWeight: 600,
    background: "#2a2a2a",
    padding: "4px 10px",
    borderRadius: 20,
    lineHeight: "14px",
  },
  bulkActionBtn: {
    display: "inline-flex",
    alignItems: "center",
    background: "#2a2a2a",
    border: "none",
    color: "#ddd",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    padding: "4px 10px",
    borderRadius: 20,
    lineHeight: "14px",
    transition: "background 150ms, color 150ms",
  },
  bulkActionBtnDanger: {
    display: "inline-flex",
    alignItems: "center",
    background: "rgba(248, 81, 73, 0.15)",
    border: "none",
    color: "#f85149",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    padding: "4px 10px",
    borderRadius: 20,
    lineHeight: "14px",
    transition: "background 150ms, color 150ms",
  },
  diffStats: {
    fontSize: 12,
    fontWeight: 600,
    fontFamily: "'SF Mono', 'Menlo', monospace",
    padding: "0 8px",
  },
  headerCommitBtn: {
    padding: "5px 16px",
    borderRadius: 8,
    border: "none",
    background: "#e6edf3",
    color: "#1a1a1a",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    flexShrink: 0,
    letterSpacing: "-0.01em",
    transition: "opacity 150ms",
    lineHeight: "16px",
  },
  commitsSection: {
    marginBottom: 16,
    borderRadius: 8,
    border: "1px solid #2a2a2a",
    overflow: "hidden",
  },
  commitsSectionHeader: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 12px",
    border: "none",
    background: "#222",
    cursor: "pointer",
    textAlign: "left" as const,
    fontSize: 12,
    fontWeight: 600,
    color: "#e6edf3",
  },
  commitsSectionTitle: {
    flex: 1,
  },
  commitsBadge: {
    minWidth: 18,
    height: 16,
    padding: "0 5px",
    borderRadius: 8,
    background: "#404040",
    color: "#fff",
    fontSize: 11,
    fontWeight: 600,
    lineHeight: "16px",
    textAlign: "center" as const,
    boxSizing: "border-box" as const,
  },
  commitsBody: {
    borderTop: "1px solid #2a2a2a",
  },
  commitRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 12px",
    fontSize: 12,
    borderBottom: "1px solid #222",
  },
  commitSha: {
    fontFamily: "'SF Mono', 'Menlo', monospace",
    fontSize: 11,
    color: "#7aa2f7",
    flexShrink: 0,
    fontWeight: 500,
  },
  commitMsg: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    color: "#e6edf3",
    fontWeight: 500,
  },
  commitDate: {
    fontSize: 11,
    color: "#666",
    flexShrink: 0,
    fontWeight: 500,
  },
};
