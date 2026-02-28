import React, { useState, useEffect, useCallback, useRef } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { api } from "../lib/tauri";
import { parseUnifiedDiff, createUntrackedDiffFile, type DiffFile } from "../lib/diffParser";
import { DiffFileSection } from "./DiffFileSection";
import { CommitModal } from "./CommitModal";
import { addToast } from "./ToastContainer";
import type { ChangesSummary, CommitEntry } from "../lib/types";
import { relativeTime } from "../lib/time";

// ---------------------------------------------------------------------------
// GitDiffContent — reusable inner content (used by both overlay and unified panel)
// ---------------------------------------------------------------------------

interface GitDiffContentProps {
  rootPath: string;
}

export function GitDiffContent({ rootPath }: GitDiffContentProps) {
  const activeTab = useWorkspaceStore((s) => s.gitDiffActiveTab);
  const setActiveTab = useWorkspaceStore((s) => s.setGitDiffActiveTab);
  const scrollToFile = useWorkspaceStore((s) => s.gitDiffScrollToFile);
  const gitStatus = useWorkspaceStore((s) => s.gitStatuses[rootPath]);
  const prStatus = useWorkspaceStore((s) => s.prStatuses[rootPath]);
  const mainBranch = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.paths.includes(rootPath));
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
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  const [expandKey, setExpandKey] = useState(0);
  const [defaultExpanded, setDefaultExpanded] = useState(true);
  const [loading, setLoading] = useState(true);
  const fileListRef = useRef<HTMLDivElement>(null);
  const commitBtnRef = useRef<HTMLButtonElement>(null);

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
    } finally {
      setLoading(false);
    }
  }, [rootPath, mainBranch]);

  // Re-fetch when git status poll detects changes (dirty state or file count changes)
  const gitStatusFingerprint = useWorkspaceStore((s) => {
    const gs = s.gitStatuses[rootPath];
    if (!gs) return "";
    return `${gs.dirty}-${gs.modified_files.length}-${gs.untracked_files.length}`;
  });

  // Fetch on mount + handle scrollToFile from store + git status changes
  useEffect(() => {
    setScrollTarget(scrollToFile ?? null);
    fetchDiffs();
  }, [rootPath, scrollToFile, fetchDiffs, gitStatusFingerprint]);

  // Scroll to target file after diffs load
  useEffect(() => {
    if (!scrollTarget || !fileListRef.current) return;
    requestAnimationFrame(() => {
      const container = fileListRef.current;
      const el = container?.querySelector(
        `[data-filepath="${CSS.escape(scrollTarget)}"]`,
      ) as HTMLElement | null;
      if (el && container) {
        const containerRect = container.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const distance = Math.abs(elRect.top - containerRect.top - container.scrollTop);
        const behavior = distance > container.clientHeight * 2 ? "instant" : "smooth";
        el.scrollIntoView({ behavior, block: "start" });
        setScrollTarget(null);
      }
    });
  }, [scrollTarget, unstagedFiles, stagedFiles]);

  // Auto-refresh on local git changes
  useEffect(() => {
    const handler = () => fetchDiffs();
    document.addEventListener("rally:git-changes-refresh", handler);
    return () =>
      document.removeEventListener("rally:git-changes-refresh", handler);
  }, [fetchDiffs]);

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

  const activeFiles = activeTab === "unstaged" ? unstagedFiles : stagedFiles;
  const unstagedCount = (changes?.unstaged.length ?? 0) + (changes?.untracked.length ?? 0);
  const stagedCount = changes?.staged.length ?? 0;
  const hasStaged = stagedCount > 0;
  const hasPr = !!(prStatus && prStatus.state === "OPEN");
  const createPrVisible = !hasPr && commits.length > 0;
  const [creatingPr, setCreatingPr] = useState(false);
  const refreshPrStatusForPath = useWorkspaceStore((s) => s.refreshPrStatusForPath);

  const handleCreatePr = useCallback(async () => {
    if (!rootPath) return;
    setCreatingPr(true);
    try {
      const url = await api.gitCreatePr(rootPath);
      addToast({ type: "success", title: "PR created", message: url });
      refreshPrStatusForPath(rootPath).catch(() => {});
    } catch (e) {
      addToast({ type: "warning", title: "Create PR failed", message: String(e) });
    } finally {
      setCreatingPr(false);
    }
  }, [rootPath, refreshPrStatusForPath]);

  return (
    <>
      {/* Tab row */}
      <div style={cs.header}>
        <button
          onClick={() => setActiveTab("unstaged")}
          style={activeTab === "unstaged" ? cs.tabActive : cs.tab}
        >
          Unstaged{changes ? ` · ${unstagedCount}` : ""}
        </button>
        <button
          onClick={() => setActiveTab("staged")}
          style={activeTab === "staged" ? cs.tabActive : cs.tab}
        >
          Staged{changes ? ` · ${stagedCount}` : ""}
        </button>
        <div style={{ flex: 1 }} />
        {activeTab === "unstaged" && unstagedCount > 0 && (
          <>
            <button onClick={handleRevertAll} style={revertConfirming ? cs.bulkActionBtnDanger : cs.bulkActionBtn}>
              {revertConfirming ? "Confirm?" : "Revert all"}
            </button>
            <button onClick={handleStageAll} style={cs.bulkActionBtn}>
              Stage all
            </button>
          </>
        )}
        {activeTab === "staged" && stagedCount > 0 && (
          <button onClick={handleUnstageAll} style={cs.bulkActionBtn}>
            Unstage all
          </button>
        )}
        {/* Commit / Create PR — inline in tab header */}
        {(hasStaged || unstagedCount > 0 || createPrVisible) && (
          <>
            <div style={{ width: 1, height: 14, background: "#333", margin: "0 2px" }} />
            <button
              ref={commitBtnRef}
              onClick={() => setCommitModalOpen(true)}
              disabled={!hasStaged && unstagedCount === 0}
              style={{
                ...cs.bulkActionBtn,
                opacity: hasStaged || unstagedCount > 0 ? 1 : 0.4,
              }}
            >
              Commit
            </button>
            {createPrVisible && (
              <button
                onClick={handleCreatePr}
                disabled={creatingPr}
                style={{
                  ...cs.bulkActionBtn,
                  opacity: creatingPr ? 0.5 : 1,
                }}
              >
                {creatingPr ? "Creating..." : "Create PR"}
              </button>
            )}
          </>
        )}
      </div>

      {/* File list */}
      <div ref={fileListRef} style={cs.fileList}>
        {loading && (
          <div style={cs.loadingContainer}>
            <div style={cs.loadingDots}>
              <span style={{ ...cs.loadingDot, animationDelay: "0s" }} />
              <span style={{ ...cs.loadingDot, animationDelay: "0.15s" }} />
              <span style={{ ...cs.loadingDot, animationDelay: "0.3s" }} />
            </div>
          </div>
        )}

        {/* Commits section */}
        {!loading && commits.length > 0 && (
          <div style={cs.commitsSection}>
            <button
              onClick={() => setCommitsExpanded((v) => !v)}
              style={cs.commitsSectionHeader}
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
              <span style={cs.commitsSectionTitle}>Commits</span>
              <span style={cs.commitsBadge}>{commits.length}</span>
            </button>
            {commitsExpanded && (
              <div style={cs.commitsBody}>
                {commits.map((c) => (
                  <div key={c.sha} style={cs.commitRow}>
                    <span style={cs.commitSha}>{c.sha.slice(0, 7)}</span>
                    <span style={cs.commitMsg}>{c.message}</span>
                    <span style={cs.commitDate}>{relativeTime(c.date)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {!loading && activeFiles.length === 0 ? (
          <div style={cs.empty}>
            {activeTab === "unstaged"
              ? "No unstaged changes"
              : "No staged changes"}
          </div>
        ) : !loading ? (
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
        ) : null}
      </div>

      {/* Commit Modal */}
      <CommitModal
        open={commitModalOpen}
        onClose={() => setCommitModalOpen(false)}
        rootPath={rootPath}
        branch={gitStatus?.branch ?? ""}
        stagedCount={stagedCount}
        unstagedCount={unstagedCount}
        additions={diffStatAdd}
        deletions={diffStatDel}
        onCommitted={fetchDiffs}
        anchorRef={commitBtnRef}
        hasPr={hasPr}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Styles (shared by GitDiffContent regardless of context)
// ---------------------------------------------------------------------------

const cs: Record<string, React.CSSProperties> = {
  header: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "0 8px",
    borderBottom: "1px solid #2a2a2a",
    flexShrink: 0,
    position: "relative",
  },
  tab: {
    padding: "10px 8px",
    background: "none",
    border: "none",
    borderBottom: "2px solid transparent",
    color: "#999",
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 500,
    transition: "color 150ms",
    flexShrink: 0,
  },
  tabActive: {
    padding: "10px 8px",
    background: "none",
    border: "none",
    borderBottom: "2px solid #e6edf3",
    color: "#e6edf3",
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 600,
    flexShrink: 0,
  },
  fileList: {
    flex: 1,
    overflow: "auto",
    padding: "12px 10px",
    scrollPaddingTop: 8,
  },
  empty: {
    color: "#888",
    fontSize: 13,
    textAlign: "center",
    padding: 48,
    fontWeight: 500,
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
    padding: "3px 8px",
    borderRadius: 20,
    lineHeight: "16px",
    transition: "background 150ms, color 150ms",
    flexShrink: 0,
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
    padding: "3px 8px",
    borderRadius: 20,
    lineHeight: "16px",
    transition: "background 150ms, color 150ms",
    flexShrink: 0,
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
  loadingContainer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "48px 0",
  },
  loadingDots: {
    display: "flex",
    gap: 6,
  },
  loadingDot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "#555",
    animation: "claude-dot 1.4s ease-in-out infinite",
  },
};
