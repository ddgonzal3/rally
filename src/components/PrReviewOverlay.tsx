import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { api, openUrl } from "../lib/tauri";
import { parseUnifiedDiff, type DiffFile } from "../lib/diffParser";
import { DiffFileSection } from "./DiffFileSection";
import { addToast } from "./ToastContainer";
import { renderMarkdown, markdownStyles } from "../lib/markdown";
import type { PrDetails, PrComment, PrReview } from "../lib/types";
import { relativeTime } from "../lib/time";

// Merge comments and reviews into a single chronological timeline
type TimelineItem =
  | { kind: "comment"; data: PrComment }
  | { kind: "review"; data: PrReview };

function buildTimeline(comments: PrComment[], reviews: PrReview[]): TimelineItem[] {
  const items: TimelineItem[] = [
    ...comments.map((c) => ({ kind: "comment" as const, data: c })),
    ...reviews
      .filter((r) => r.body.trim().length > 0 || r.state !== "COMMENTED")
      .map((r) => ({ kind: "review" as const, data: r })),
  ];
  items.sort(
    (a, b) =>
      new Date(a.data.created_at).getTime() -
      new Date(b.data.created_at).getTime(),
  );
  return items;
}

function reviewStateBadge(state: string): { label: string; color: string; bg: string } | null {
  switch (state) {
    case "APPROVED":
      return { label: "Approved", color: "#7ddf7d", bg: "rgba(63, 185, 80, 0.12)" };
    case "CHANGES_REQUESTED":
      return { label: "Changes requested", color: "#f85149", bg: "rgba(248, 81, 73, 0.12)" };
    case "DISMISSED":
      return { label: "Dismissed", color: "#888", bg: "rgba(136, 136, 136, 0.12)" };
    default:
      return null;
  }
}

export function PrReviewOverlay({
  rootPath,
  onClose,
}: {
  rootPath: string;
  onClose: () => void;
}) {
  // Use cached PrStatus for instant header rendering while details load
  const cachedPr = useWorkspaceStore((s) => s.prStatuses[rootPath]);
  const scrollToFile = useWorkspaceStore((s) => s.prReviewScrollToFile);

  const [details, setDetails] = useState<PrDetails | null>(null);
  const [diffFiles, setDiffFiles] = useState<DiffFile[]>([]);
  const [diffLoading, setDiffLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"conversation" | "changes" | "commits">("changes");
  const [error, setError] = useState<string | null>(null);
  const [mergeArmed, setMergeArmed] = useState(false);
  const [merging, setMerging] = useState(false);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const fileListRef = useRef<HTMLDivElement>(null);

  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setMounted(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setVisible(true));
    });
  }, []);

  // When scrollToFile changes, switch to changes tab and set scroll target
  useEffect(() => {
    if (scrollToFile) {
      setActiveTab("changes");
      setScrollTarget(scrollToFile);
    }
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
  }, [scrollTarget, diffFiles]);

  // Escape key to close
  useEffect(() => {
    if (!mounted) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [mounted, onClose]);

  // Fetch details and diff
  const [refreshing, setRefreshing] = useState(false);

  const fetchAll = useCallback(() => {
    setDetailsLoading(true);
    setError(null);
    setDiffLoading(true);

    api.gitPrDetails(rootPath)
      .then((det) => {
        setDetails(det);
        setDetailsLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setDetailsLoading(false);
      });

    api.gitPrDiff(rootPath)
      .then((rawDiff) => {
        setDiffFiles(parseUnifiedDiff(rawDiff));
        setDiffLoading(false);
      })
      .catch(() => {
        setDiffLoading(false);
      });
  }, [rootPath]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    fetchAll();
    // Clear the spinner after a short delay so it's visible
    setTimeout(() => setRefreshing(false), 600);
  }, [fetchAll]);

  // Disarm merge confirmation when clicking anywhere else
  useEffect(() => {
    if (!mergeArmed) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // If click is NOT on the merge button itself, disarm
      if (!target.closest?.("[data-merge-btn]")) {
        setMergeArmed(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [mergeArmed]);

  const refreshGitStatusForPath = useWorkspaceStore((s) => s.refreshGitStatusForPath);
  const refreshPrStatusForPath = useWorkspaceStore((s) => s.refreshPrStatusForPath);
  const fetchAllRepos = useWorkspaceStore((s) => s.fetchAllRepos);
  const openClaudeCommand = useWorkspaceStore((s) => s.openClaudeCommand);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const mainBranch = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.paths.includes(rootPath));
    return ws?.main_branch ?? "main";
  });

  const handleMerge = useCallback(async () => {
    if (!mergeArmed) {
      setMergeArmed(true);
      return;
    }
    setMergeArmed(false);
    setMerging(true);
    try {
      await api.gitMergePr(rootPath, "squash");
      const prNum = details?.number ?? cachedPr?.number;
      const branch = details?.head_branch ?? "";
      addToast({ type: "success", title: "PR merged", message: `PR #${prNum} merged via squash` });
      onClose();

      // Post-merge sync: sync the feature branch back to main
      // Must complete BEFORE refreshing git status to avoid concurrent git lock conflicts
      if (branch) {
        try {
          await api.postMergeSync(rootPath, mainBranch, branch);
        } catch (e) {
          console.error("Post-merge sync failed:", e);
          addToast({ type: "warning", title: "Sync failed", message: `Branch sync failed: ${String(e).slice(0, 120)}` });
        }
      }

      // Refresh statuses only after sync completes (avoids git index.lock races)
      refreshGitStatusForPath(rootPath, mainBranch).catch(() => {});
      refreshPrStatusForPath(rootPath).catch(() => {});
      // Fetch all repos so other checkouts see the behind count
      fetchAllRepos().catch(() => {});
    } catch (e) {
      addToast({ type: "warning", title: "Merge failed", message: String(e) });
    } finally {
      setMerging(false);
    }
  }, [mergeArmed, rootPath, details, cachedPr, onClose, mainBranch, refreshGitStatusForPath, refreshPrStatusForPath, fetchAllRepos]);

  const folderName = rootPath.split("/").pop() ?? "";

  // Use details when available, fall back to cached PrStatus for instant render
  const prNumber = details?.number ?? cachedPr?.number;
  const prTitle = details?.title ?? cachedPr?.title ?? "";
  const prUrl = details?.url ?? cachedPr?.url ?? "";
  const prState = details?.state ?? cachedPr?.state ?? "OPEN";
  const prMergeable = details?.mergeable ?? cachedPr?.mergeable ?? "UNKNOWN";
  const prReviewDecision = details?.review_decision ?? cachedPr?.review_decision;
  const prChecksStatus = details?.checks_status ?? cachedPr?.checks_status;
  const prIsDraft = details?.is_draft ?? cachedPr?.is_draft ?? false;

  const startEditTitle = useCallback(() => {
    setTitleDraft(prTitle);
    setEditingTitle(true);
    requestAnimationFrame(() => titleInputRef.current?.select());
  }, [prTitle]);

  const saveTitle = useCallback(async () => {
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === prTitle) {
      setEditingTitle(false);
      return;
    }
    setSavingTitle(true);
    try {
      await api.gitEditPrTitle(rootPath, trimmed);
      setDetails((prev) => prev ? { ...prev, title: trimmed } : prev);
      setEditingTitle(false);
    } catch (e) {
      addToast({ type: "warning", title: "Failed to update title", message: String(e) });
    } finally {
      setSavingTitle(false);
    }
  }, [titleDraft, prTitle, rootPath]);

  const cancelEditTitle = useCallback(() => {
    setEditingTitle(false);
  }, []);

  const handleShip = useCallback(() => {
    if (!activeWorkspaceId) return;
    onClose();
    openClaudeCommand(activeWorkspaceId, rootPath, "/ship", "Ship");
  }, [activeWorkspaceId, rootPath, onClose, openClaudeCommand]);

  const mergeDisabled = useMemo(() => {
    if (merging) return true;
    if (prMergeable === "CONFLICTING") return true;
    if (prState !== "OPEN") return true;
    return false;
  }, [merging, prMergeable, prState]);

  const mergeColor = prMergeable === "MERGEABLE" ? "#7ddf7d"
    : prMergeable === "CONFLICTING" ? "#df7d7d" : "#aaa";
  const reviewColor = prReviewDecision === "APPROVED" ? "#7ddf7d"
    : prReviewDecision === "CHANGES_REQUESTED" ? "#df7d7d"
    : "#dfc97d";
  const checksColor = prChecksStatus === "pass" ? "#7ddf7d"
    : prChecksStatus === "fail" ? "#df7d7d"
    : prChecksStatus === "pending" ? "#dfc97d" : "#666";

  // Render PR body as markdown
  const bodyHtml = useMemo(() => {
    const body = details?.body?.trim();
    if (!body) return null;
    return renderMarkdown(body);
  }, [details?.body]);

  const timeline = useMemo(
    () => details ? buildTimeline(details.comments, details.reviews) : [],
    [details],
  );
  const conversationCount = timeline.length + (details?.body?.trim() ? 1 : 0);

  if (!mounted) return null;

  return (
    <div
      className="git-diff-overlay"
      style={{
        ...st.backdrop,
        opacity: visible ? 1 : 0,
      }}
    >
      <style>{markdownStyles}</style>

      {/* Header */}
      <div style={st.header}>
        <button onClick={onClose} style={st.backBtn} title="Back">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {prUrl && (
          <button
            onClick={() => openUrl(prUrl)}
            style={st.githubBtn}
            title="Open on GitHub"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
          </button>
        )}

        <button
          onClick={handleRefresh}
          style={st.refreshBtn}
          title="Refresh PR"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            style={{
              transition: "transform 400ms ease",
              transform: refreshing ? "rotate(360deg)" : "none",
            }}
          >
            <path d="M13.65 2.35v3.5h-3.5M2.35 13.65v-3.5h3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M3.5 6.5a5 5 0 0 1 8.25-2.15L13.65 5.85M12.5 9.5a5 5 0 0 1-8.25 2.15L2.35 10.15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {prNumber != null && (
          <>
            {editingTitle ? (
              <input
                ref={titleInputRef}
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveTitle();
                  if (e.key === "Escape") cancelEditTitle();
                }}
                onBlur={saveTitle}
                disabled={savingTitle}
                style={st.titleInput}
                autoFocus
              />
            ) : (
              <span
                style={st.prTitle}
                onClick={() => prUrl && openUrl(prUrl)}
                title="Open PR on GitHub"
              >
                {prTitle}{prIsDraft ? " (draft)" : ""}
              </span>
            )}
            <span style={st.prNumber}>#{prNumber}</span>
            {!editingTitle && (
              <button
                onClick={startEditTitle}
                style={st.editBtn}
                title="Edit title"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path d="M16.474 5.408l2.118 2.117m-.756-3.982L12.109 9.27a2.118 2.118 0 0 0-.58 1.082L11 13l2.648-.53c.41-.082.786-.283 1.082-.579l5.727-5.727a1.853 1.853 0 1 0-2.621-2.621z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M19 15v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </>
        )}

        <span style={st.repoName}>{folderName}</span>
        <div style={{ flex: 1 }} />

        {details && (
          <span style={st.authorPill}>{details.author}</span>
        )}
        {details && (
          <span style={st.branchPill}>
            <span style={st.branchName}>{details.head_branch}</span>
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, opacity: 0.5 }}>
              <path d="M5 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span style={st.branchName}>{details.base_branch}</span>
          </span>
        )}
        {details && (details.additions > 0 || details.deletions > 0) && (
          <span style={st.diffStats}>
            {details.additions > 0 && <span style={{ color: "#3fb950" }}>+{details.additions}</span>}
            {details.additions > 0 && details.deletions > 0 && " "}
            {details.deletions > 0 && <span style={{ color: "#f85149" }}>-{details.deletions}</span>}
          </span>
        )}
      </div>

      {/* Tabs */}
      <div style={st.tabBar}>
        <button
          onClick={() => setActiveTab("conversation")}
          style={activeTab === "conversation" ? st.tabActive : st.tab}
        >
          Conversation{conversationCount > 0 ? ` \u00b7 ${conversationCount}` : ""}
        </button>
        <button
          onClick={() => setActiveTab("changes")}
          style={activeTab === "changes" ? st.tabActive : st.tab}
        >
          Changes{diffFiles.length > 0 ? ` \u00b7 ${diffFiles.length}` : ""}
        </button>
        <button
          onClick={() => setActiveTab("commits")}
          style={activeTab === "commits" ? st.tabActive : st.tab}
        >
          Commits{details ? ` \u00b7 ${details.commits.length}` : ""}
        </button>
        <div style={{ flex: 1 }} />

        {/* Status badges */}
        {prNumber != null && (
          <div style={st.statusBadges}>
            {prMergeable === "MERGEABLE" ? (
              <span style={st.mergeStatus}>
                <span style={st.mergeCheckCircle}>
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                    <path d="M4 8.5l3 3 5-6" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span style={st.mergeStatusText}>No conflicts</span>
              </span>
            ) : prMergeable === "CONFLICTING" ? (
              <span style={{ ...st.statusTag, color: "#f85149" }}>Conflicts</span>
            ) : null}
            {prReviewDecision === "APPROVED" && (
              <span style={{ ...st.statusTag, color: "#7ddf7d" }}>Approved</span>
            )}
            {prReviewDecision === "CHANGES_REQUESTED" && (
              <span style={{ ...st.statusTag, color: "#f85149" }}>Changes Req</span>
            )}
            {prChecksStatus && (
              <span style={{ ...st.statusTag, color: checksColor }}>
                Checks {prChecksStatus}
              </span>
            )}
          </div>
        )}

        {/* Ship + Merge buttons */}
        {prState === "OPEN" && prNumber != null && (
          <>
            <button
              onClick={handleShip}
              disabled={!activeWorkspaceId}
              style={{
                ...st.shipBtn,
                opacity: activeWorkspaceId ? 1 : 0.4,
              }}
              title="Run /ship — review and merge via Claude"
            >
              Ship
            </button>
            <button
              data-merge-btn
              onClick={handleMerge}
              disabled={mergeDisabled}
              style={{
                ...st.mergeBtn,
                ...(mergeArmed ? st.mergeBtnArmed : {}),
                opacity: mergeDisabled ? 0.4 : 1,
              }}
            >
              {merging ? "Merging..." : mergeArmed ? "Confirm merge?" : "Squash & merge"}
            </button>
          </>
        )}
      </div>

      {/* Content */}
      <div ref={fileListRef} style={st.content}>
        {error ? (
          <div style={st.empty}>
            <span style={{ color: "#f85149" }}>Failed to load PR</span>
            <br />
            <span style={{ fontSize: 12, color: "#888", marginTop: 8, display: "block" }}>{error}</span>
          </div>
        ) : activeTab === "conversation" ? (
          <ConversationTab
            details={details}
            loading={detailsLoading}
            timeline={timeline}
            bodyHtml={bodyHtml}
          />
        ) : activeTab === "changes" ? (
          diffLoading ? (
            <div style={st.empty}>Loading diff...</div>
          ) : diffFiles.length === 0 ? (
            <div style={st.empty}>No file changes</div>
          ) : (
            diffFiles.map((file) => (
              <div key={file.newPath || file.oldPath} data-filepath={file.newPath || file.oldPath}>
                <DiffFileSection
                  file={file}
                  defaultExpanded={true}
                  tab="pr"
                />
              </div>
            ))
          )
        ) : (
          /* Commits tab */
          detailsLoading ? (
            <div style={st.empty}>Loading commits...</div>
          ) : (
            <div style={st.commitList}>
              {details?.commits.length === 0 ? (
                <div style={st.empty}>No commits</div>
              ) : (
                details?.commits.map((commit, i) => (
                  <div key={commit.sha || i} style={st.commitItem}>
                    <div style={st.commitMain}>
                      <span style={st.commitMessage}>{commit.message_headline}</span>
                      <span style={st.commitMeta}>
                        <span style={st.commitAuthor}>{commit.author}</span>
                        {commit.committed_date && (
                          <span style={st.commitDate}>{relativeTime(commit.committed_date)}</span>
                        )}
                      </span>
                    </div>
                    <span
                      style={st.commitSha}
                      onClick={() => {
                        if (details?.url) {
                          openUrl(`${details.url}/commits/${commit.sha}`);
                        }
                      }}
                      title="View commit on GitHub"
                    >
                      {commit.sha.slice(0, 7)}
                    </span>
                  </div>
                ))
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}

// --- Conversation Tab ---

function ConversationTab({
  details,
  loading,
  timeline,
  bodyHtml,
}: {
  details: PrDetails | null;
  loading: boolean;
  timeline: TimelineItem[];
  bodyHtml: string | null;
}) {
  if (loading) {
    return <div style={st.empty}>Loading...</div>;
  }
  if (!details) {
    return <div style={st.empty}>No PR data</div>;
  }

  const hasTimeline = timeline.length > 0;

  if (!bodyHtml && !hasTimeline) {
    return (
      <div style={st.empty}>
        No description or comments
      </div>
    );
  }

  return (
    <div style={st.conversationList}>
      {/* PR description rendered as markdown */}
      {bodyHtml && (
        <div style={st.conversationCard}>
          <div style={st.conversationHeader}>
            <span style={st.conversationAuthor}>{details.author}</span>
            <span style={st.conversationLabel}>author</span>
            {details.created_at && (
              <span style={st.conversationDate}>{relativeTime(details.created_at)}</span>
            )}
          </div>
          <div
            className="md-body"
            style={st.conversationBody}
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />
        </div>
      )}

      {/* Timeline: comments + reviews */}
      {timeline.map((item, i) => {
        if (item.kind === "review") {
          const badge = reviewStateBadge(item.data.state);
          return (
            <div key={`r-${i}`} style={st.conversationCard}>
              <div style={st.conversationHeader}>
                <span style={st.conversationAuthor}>{item.data.author}</span>
                {badge && (
                  <span style={{ ...st.reviewBadge, color: badge.color, background: badge.bg }}>
                    {badge.label}
                  </span>
                )}
                {item.data.created_at && (
                  <span style={st.conversationDate}>{relativeTime(item.data.created_at)}</span>
                )}
              </div>
              {item.data.body.trim() && (
                <div
                  className="md-body"
                  style={st.conversationBody}
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(item.data.body) }}
                />
              )}
            </div>
          );
        }
        // comment
        return (
          <div key={`c-${i}`} style={st.conversationCard}>
            <div style={st.conversationHeader}>
              <span style={st.conversationAuthor}>{item.data.author}</span>
              {item.data.created_at && (
                <span style={st.conversationDate}>{relativeTime(item.data.created_at)}</span>
              )}
            </div>
            <div
              className="md-body"
              style={st.conversationBody}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(item.data.body) }}
            />
          </div>
        );
      })}
    </div>
  );
}

// --- Styles ---

const st: Record<string, React.CSSProperties> = {
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
    gap: 6,
    padding: "0 16px",
    minHeight: 40,
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
  refreshBtn: {
    background: "none",
    border: "none",
    color: "#ccc",
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
    transition: "color 150ms",
    flexShrink: 0,
  },
  prNumber: {
    fontSize: 14,
    fontWeight: 600,
    color: "#888",
    fontFamily: "'SF Mono', 'Menlo', monospace",
    flexShrink: 0,
    lineHeight: "20px",
    position: "relative",
    top: 1,
  },
  prTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: "#e6edf3",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
    cursor: "pointer",
    transition: "color 150ms",
    lineHeight: "20px",
  },
  titleInput: {
    fontSize: 16,
    fontWeight: 600,
    color: "#e6edf3",
    background: "#2a2a2a",
    border: "1px solid #444",
    borderRadius: 6,
    padding: "3px 8px",
    outline: "none",
    minWidth: 200,
    flex: 1,
    maxWidth: 400,
  },
  editBtn: {
    background: "none",
    border: "none",
    color: "#ccc",
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
    transition: "color 150ms",
    flexShrink: 0,
  },
  repoName: {
    position: "absolute",
    left: "50%",
    transform: "translateX(-50%)",
    fontSize: 13,
    color: "#d0d0d0",
    fontWeight: 700,
    pointerEvents: "none",
  },
  authorPill: {
    fontSize: 12,
    fontWeight: 700,
    color: "#e6edf3",
    background: "#2a2a2a",
    padding: "3px 9px",
    borderRadius: 20,
    flexShrink: 0,
  },
  branchPill: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 12,
    color: "#ddd",
    fontFamily: "'SF Mono', 'Menlo', monospace",
    fontWeight: 600,
    background: "#2a2a2a",
    padding: "3px 9px",
    borderRadius: 20,
    flexShrink: 0,
  },
  branchName: {
    maxWidth: 120,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  diffStats: {
    fontSize: 12,
    fontWeight: 600,
    fontFamily: "'SF Mono', 'Menlo', monospace",
    padding: "0 4px",
    flexShrink: 0,
  },
  githubBtn: {
    background: "none",
    border: "none",
    color: "#ccc",
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
    transition: "color 150ms",
    flexShrink: 0,
  },
  tabBar: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "0 16px",
    borderBottom: "1px solid #2a2a2a",
    flexShrink: 0,
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
  statusBadges: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  statusTag: {
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: "-0.01em",
  },
  mergeStatus: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
  },
  mergeCheckCircle: {
    width: 16,
    height: 16,
    borderRadius: "50%",
    background: "#238636",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  mergeStatusText: {
    fontSize: 12,
    fontWeight: 600,
    color: "#7ddf7d",
    letterSpacing: "-0.01em",
  },
  shipBtn: {
    padding: "5px 16px",
    borderRadius: 8,
    border: "1px solid #238636",
    background: "transparent",
    color: "#7ddf7d",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    flexShrink: 0,
    letterSpacing: "-0.01em",
    transition: "opacity 150ms, background 150ms",
    lineHeight: "16px",
  },
  mergeBtn: {
    padding: "5px 16px",
    borderRadius: 8,
    border: "none",
    background: "#238636",
    color: "#fff",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    flexShrink: 0,
    letterSpacing: "-0.01em",
    transition: "opacity 150ms, background 150ms",
    lineHeight: "16px",
    marginLeft: 8,
  },
  mergeBtnArmed: {
    background: "#8b3a3a",
  },
  content: {
    flex: 1,
    overflow: "auto",
    padding: "16px 20px",
  },
  empty: {
    color: "#888",
    fontSize: 13,
    textAlign: "center",
    padding: 48,
    fontWeight: 500,
  },
  // Commits tab
  commitList: {
    display: "flex",
    flexDirection: "column",
    gap: 1,
  },
  commitItem: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 14px",
    borderRadius: 8,
    background: "#1e1e1e",
    border: "1px solid #2a2a2a",
  },
  commitMain: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 3,
  },
  commitMessage: {
    fontSize: 13,
    fontWeight: 600,
    color: "#e6edf3",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  commitMeta: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12,
  },
  commitAuthor: {
    color: "#bbb",
    fontWeight: 500,
  },
  commitDate: {
    color: "#666",
  },
  commitSha: {
    fontSize: 12,
    fontFamily: "'SF Mono', 'Menlo', monospace",
    fontWeight: 600,
    color: "#58a6ff",
    cursor: "pointer",
    flexShrink: 0,
    padding: "3px 8px",
    borderRadius: 6,
    background: "#1a2332",
    transition: "background 150ms",
  },
  // Conversation tab
  conversationList: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    maxWidth: 800,
  },
  conversationCard: {
    borderRadius: 10,
    border: "1px solid #2a2a2a",
    background: "#1e1e1e",
    overflow: "hidden",
  },
  conversationHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 14px",
    background: "#222",
    borderBottom: "1px solid #2a2a2a",
  },
  conversationAuthor: {
    fontSize: 13,
    fontWeight: 600,
    color: "#e6edf3",
  },
  conversationLabel: {
    fontSize: 10,
    fontWeight: 600,
    padding: "2px 7px",
    borderRadius: 10,
    background: "rgba(136, 136, 136, 0.12)",
    color: "#888",
    textTransform: "uppercase" as const,
    letterSpacing: "0.03em",
  },
  conversationDate: {
    fontSize: 12,
    color: "#666",
    marginLeft: "auto",
  },
  conversationBody: {
    padding: "12px 14px",
  },
  reviewBadge: {
    fontSize: 10,
    fontWeight: 600,
    padding: "2px 7px",
    borderRadius: 10,
    textTransform: "uppercase" as const,
    letterSpacing: "0.03em",
  },
};
