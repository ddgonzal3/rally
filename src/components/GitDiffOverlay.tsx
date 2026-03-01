import React, { useState, useEffect, useRef } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { DiffFileSection } from "./DiffFileSection";
import { CommitModal } from "./CommitModal";
import { useGitDiffActions } from "../hooks/useGitDiffActions";
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
  const mainBranch = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.paths.includes(rootPath));
    return ws?.main_branch ?? "main";
  });

  const {
    unstagedFiles,
    stagedFiles,
    commits,
    diffStatAdd,
    diffStatDel,
    loading,
    fetchDiffs,
    handleStage,
    handleUnstage,
    handleDiscard,
    handleRevertAll,
    revertConfirming,
    handleStageAll,
    handleUnstageAll,
    handleCreatePr,
    creatingPr,
    unstagedCount,
    stagedCount,
    hasStaged,
    hasPr,
    createPrVisible,
  } = useGitDiffActions({ rootPath, mainBranch });

  const [commitModalOpen, setCommitModalOpen] = useState(false);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  const [expandKey, setExpandKey] = useState(0);
  const [defaultExpanded, setDefaultExpanded] = useState(true);
  const [commitsExpanded, setCommitsExpanded] = useState(true);
  const fileListRef = useRef<HTMLDivElement>(null);
  const commitBtnRef = useRef<HTMLButtonElement>(null);

  // Handle scrollToFile from store
  useEffect(() => {
    setScrollTarget(scrollToFile ?? null);
  }, [scrollToFile]);

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

  // Wrap stageAll/unstageAll to also reset expand state
  const handleStageAllWithReset = async () => {
    await handleStageAll();
    setDefaultExpanded(false);
    setExpandKey((k) => k + 1);
  };

  const handleUnstageAllWithReset = async () => {
    await handleUnstageAll();
    setDefaultExpanded(false);
    setExpandKey((k) => k + 1);
  };

  const activeFiles = activeTab === "unstaged" ? unstagedFiles : stagedFiles;

  return (
    <>
      {/* Tab row */}
      <div style={cs.header}>
        <button
          onClick={() => setActiveTab("unstaged")}
          style={activeTab === "unstaged" ? cs.tabActive : cs.tab}
        >
          Unstaged{` · ${unstagedCount}`}
        </button>
        <button
          onClick={() => setActiveTab("staged")}
          style={activeTab === "staged" ? cs.tabActive : cs.tab}
        >
          Staged{` · ${stagedCount}`}
        </button>
        <div style={{ flex: 1 }} />
        {activeTab === "unstaged" && unstagedCount > 0 && (
          <>
            <button onClick={handleRevertAll} style={revertConfirming ? cs.bulkActionBtnDanger : cs.bulkActionBtn}>
              {revertConfirming ? "Confirm?" : "Revert all"}
            </button>
            <button onClick={handleStageAllWithReset} style={cs.bulkActionBtn}>
              Stage all
            </button>
          </>
        )}
        {activeTab === "staged" && stagedCount > 0 && (
          <button onClick={handleUnstageAllWithReset} style={cs.bulkActionBtn}>
            Unstage all
          </button>
        )}
        {/* Commit / Create PR — inline in tab header */}
        {(hasStaged || unstagedCount > 0 || createPrVisible) && (
          <>
            <div style={{ width: 1, height: 14, background: "var(--border)", margin: "0 2px" }} />
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
    borderBottom: "1px solid var(--border)",
    flexShrink: 0,
    position: "relative",
  },
  tab: {
    padding: "10px 8px",
    background: "none",
    border: "none",
    borderBottom: "2px solid transparent",
    color: "var(--text-dim)",
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
    borderBottom: "2px solid var(--text-primary)",
    color: "var(--text-primary)",
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
    color: "var(--text-dim)",
    fontSize: 13,
    textAlign: "center",
    padding: 48,
    fontWeight: 500,
  },
  bulkActionBtn: {
    display: "inline-flex",
    alignItems: "center",
    background: "var(--bg-elevated)",
    border: "none",
    color: "var(--text-primary)",
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
    border: "1px solid var(--border)",
    overflow: "hidden",
  },
  commitsSectionHeader: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 12px",
    border: "none",
    background: "var(--bg-elevated)",
    cursor: "pointer",
    textAlign: "left" as const,
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-primary)",
  },
  commitsSectionTitle: {
    flex: 1,
  },
  commitsBadge: {
    minWidth: 18,
    height: 16,
    padding: "0 5px",
    borderRadius: 8,
    background: "var(--border)",
    color: "var(--text-primary)",
    fontSize: 11,
    fontWeight: 600,
    lineHeight: "16px",
    textAlign: "center" as const,
    boxSizing: "border-box" as const,
  },
  commitsBody: {
    borderTop: "1px solid var(--border)",
  },
  commitRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 12px",
    fontSize: 12,
    borderBottom: "1px solid var(--bg-elevated)",
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
    color: "var(--text-primary)",
    fontWeight: 500,
  },
  commitDate: {
    fontSize: 11,
    color: "var(--text-dim)",
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
    background: "var(--text-dim)",
    animation: "claude-dot 1.4s ease-in-out infinite",
  },
};
