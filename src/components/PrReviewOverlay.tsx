import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { api, openUrl } from "../lib/tauri";
import { parseUnifiedDiff, type DiffFile } from "../lib/diffParser";
import { DiffFileSection } from "./DiffFileSection";
import { addToast } from "./ToastContainer";
import { renderMarkdown, markdownStyles } from "../lib/markdown";
import type { PrDetails, PrComment, PrReview } from "../lib/types";
import { relativeTime } from "../lib/time";

const PR_SIDEBAR_MIN = 165;
const PR_SIDEBAR_MAX = 320;


// ---------------------------------------------------------------------------
// File tree structure for PR sidebar
// ---------------------------------------------------------------------------

interface FileTreeNode {
  name: string;
  path: string; // full relative path for this segment
  children: FileTreeNode[];
  file?: DiffFile; // only set on leaf nodes
}

function buildFileTree(files: DiffFile[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const file of files) {
    const fp = file.newPath || file.oldPath;
    const parts = fp.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const pathSoFar = parts.slice(0, i + 1).join("/");
      const isLeaf = i === parts.length - 1;
      let existing = current.find((n) => n.name === part && n.path === pathSoFar);

      if (!existing) {
        existing = { name: part, path: pathSoFar, children: [] };
        if (isLeaf) existing.file = file;
        current.push(existing);
      }
      current = existing.children;
    }
  }

  // Collapse single-child directories: src/components → src/components
  function collapse(nodes: FileTreeNode[]): FileTreeNode[] {
    return nodes.map((node) => {
      node.children = collapse(node.children);
      if (node.children.length === 1 && !node.file && !node.children[0].file) {
        const child = node.children[0];
        return { ...child, name: `${node.name}/${child.name}` };
      }
      return node;
    });
  }

  // Sort: directories first, then files, both alphabetical
  function sortTree(nodes: FileTreeNode[]): FileTreeNode[] {
    nodes.sort((a, b) => {
      const aIsDir = a.children.length > 0 || !a.file;
      const bIsDir = b.children.length > 0 || !b.file;
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) sortTree(n.children);
    return nodes;
  }

  return sortTree(collapse(root));
}

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
      return { label: "Dismissed", color: "#e0e0e0", bg: "rgba(136, 136, 136, 0.12)" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// PrReviewContent — all PR review logic, usable both inside the overlay and
// inside the unified git panel's PR tab.
// ---------------------------------------------------------------------------

export function PrReviewContent({
  rootPath,
  onClose,
  scrollToFile,
}: {
  rootPath: string;
  onClose?: () => void;
  scrollToFile?: string | null;
}) {
  // Use cached PrStatus for instant header rendering while details load
  const cachedPr = useWorkspaceStore((s) => s.prStatuses[rootPath]);

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
  const [closing, setClosing] = useState(false);
  const [closeArmed, setCloseArmed] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const fileListRef = useRef<HTMLDivElement>(null);
  const fileTreeContainerRef = useRef<HTMLDivElement>(null);
  const prSidebarRef = useRef<HTMLDivElement>(null);
  const [prSidebarWidth, setPrSidebarWidth] = useState<number | null>(null);
  const [prUserResized, setPrUserResized] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const lastPrFileFingerprint = useRef<string>("");

  // Manage selected-path highlight imperatively (avoids re-rendering entire tree)
  useEffect(() => {
    const container = fileTreeContainerRef.current;
    if (!container) return;
    container.querySelectorAll(".file-list-item-selected").forEach((el) =>
      el.classList.remove("file-list-item-selected"),
    );
    if (selectedPath) {
      const sel = container.querySelector(
        `[data-pr-path="${CSS.escape(selectedPath)}"]`,
      );
      sel?.classList.add("file-list-item-selected");
    }
  }, [selectedPath]);

  // When scrollToFile changes, switch to changes tab and set scroll target
  useEffect(() => {
    if (scrollToFile) {
      setActiveTab("changes");
      setScrollTarget(scrollToFile);
    }
  }, [scrollToFile]);

  // Select target file after diffs load
  useEffect(() => {
    if (!scrollTarget) return;
    setSelectedPath(scrollTarget);
    setScrollTarget(null);
  }, [scrollTarget, diffFiles]);

  // Select a file to show its diff (toggle: click again to deselect → show all)
  const handleSelectFile = useCallback((filePath: string) => {
    setSelectedPath((prev) => (prev === filePath ? null : filePath));
    fileListRef.current?.scrollTo(0, 0);
  }, []);

  // Select a directory to show all diffs under it (toggle: click again to deselect)
  const handleSelectDir = useCallback((dirPath: string) => {
    setSelectedPath((prev) => (prev === dirPath ? null : dirPath));
    fileListRef.current?.scrollTo(0, 0);
  }, []);

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

  // Disarm merge/close confirmation when clicking anywhere else
  useEffect(() => {
    if (!mergeArmed && !closeArmed) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (mergeArmed && !target.closest?.("[data-merge-btn]")) {
        setMergeArmed(false);
      }
      if (closeArmed && !target.closest?.("[data-close-btn]")) {
        setCloseArmed(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [mergeArmed, closeArmed]);

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
      onClose?.();

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


  // Use details when available, fall back to cached PrStatus for instant render
  const prNumber = details?.number ?? cachedPr?.number;
  const prTitle = details?.title ?? cachedPr?.title ?? "";
  const prUrl = details?.url ?? cachedPr?.url ?? "";
  const prState = details?.state ?? cachedPr?.state ?? "OPEN";
  const prMergeable = details?.mergeable ?? cachedPr?.mergeable ?? "UNKNOWN";
  const prReviewDecision = details?.review_decision ?? cachedPr?.review_decision;
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
    onClose?.();
    openClaudeCommand(activeWorkspaceId, rootPath, "/rally-ship", "Ship");
  }, [activeWorkspaceId, rootPath, onClose, openClaudeCommand]);

  const handleClosePr = useCallback(async () => {
    if (!closeArmed) {
      setCloseArmed(true);
      return;
    }
    setCloseArmed(false);
    setClosing(true);
    try {
      await api.gitClosePr(rootPath);
      addToast({ type: "success", title: "PR closed", message: `PR #${prNumber} closed` });
      onClose?.();
      refreshPrStatusForPath(rootPath).catch(() => {});
    } catch (e) {
      addToast({ type: "warning", title: "Close failed", message: String(e) });
    } finally {
      setClosing(false);
    }
  }, [closeArmed, rootPath, prNumber, onClose, refreshPrStatusForPath]);

  // --- PR sidebar resize ---
  const handlePrSidebarResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = prSidebarRef.current?.offsetWidth ?? 180;
    let raf = 0;
    let finalWidth = startWidth;

    const onMouseMove = (ev: MouseEvent) => {
      finalWidth = Math.max(PR_SIDEBAR_MIN, Math.min(PR_SIDEBAR_MAX, startWidth + (ev.clientX - startX)));
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (prSidebarRef.current) {
          prSidebarRef.current.style.width = finalWidth + "px";
        }
      });
    };
    const onMouseUp = () => {
      cancelAnimationFrame(raf);
      setPrSidebarWidth(finalWidth);
      setPrUserResized(true);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  const mergeDisabled = useMemo(() => {
    if (merging) return true;
    if (prMergeable === "CONFLICTING") return true;
    if (prState !== "OPEN") return true;
    if (prReviewDecision === "CHANGES_REQUESTED") return true;
    if (prReviewDecision === "REVIEW_REQUIRED") return true;
    return false;
  }, [merging, prMergeable, prState, prReviewDecision]);

  const mergeDisabledReason = useMemo(() => {
    if (prMergeable === "CONFLICTING") return "Conflicts";
    if (prReviewDecision === "CHANGES_REQUESTED") return "Changes requested";
    if (prReviewDecision === "REVIEW_REQUIRED") return "Needs approval";
    return null;
  }, [prMergeable, prReviewDecision]);

  // Render PR body as markdown
  const bodyHtml = useMemo(() => {
    const body = details?.body?.trim();
    if (!body) return null;
    return renderMarkdown(body);
  }, [details?.body]);

  // Auto-size PR sidebar based on longest file name
  const prAutoWidth = useMemo(() => {
    if (diffFiles.length === 0) return PR_SIDEBAR_MIN;
    const longestName = diffFiles.reduce((max, f) => {
      const name = (f.newPath || f.oldPath).split("/").pop() ?? "";
      return name.length > max ? name.length : max;
    }, 0);
    const estimated = Math.round(longestName * 7.5) + 76;
    return Math.max(PR_SIDEBAR_MIN, Math.min(PR_SIDEBAR_MAX, estimated));
  }, [diffFiles]);

  const effectivePrSidebarWidth = prUserResized && prSidebarWidth !== null ? prSidebarWidth : prAutoWidth;

  const fileTree = useMemo(() => buildFileTree(diffFiles), [diffFiles]);

  // Compute which diff files to show based on selectedPath
  const filesToShow = useMemo(() => {
    if (!selectedPath) return diffFiles; // show all
    // Check exact file match
    const exactMatch = diffFiles.find((f) => (f.newPath || f.oldPath) === selectedPath);
    if (exactMatch) return [exactMatch];
    // Directory prefix match
    const prefix = selectedPath + "/";
    return diffFiles.filter((f) => (f.newPath || f.oldPath).startsWith(prefix));
  }, [diffFiles, selectedPath]);

  const toggleDir = useCallback((dirPath: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  }, []);

  // Reset sidebar width when file list changes
  const prFileFingerprint = diffFiles.map(f => f.newPath || f.oldPath).sort().join("\n");
  useEffect(() => {
    if (!prFileFingerprint) return;
    if (lastPrFileFingerprint.current && prFileFingerprint !== lastPrFileFingerprint.current) {
      setPrUserResized(false);
      setPrSidebarWidth(null);
    }
    lastPrFileFingerprint.current = prFileFingerprint;
  }, [prFileFingerprint]);

  const timeline = useMemo(
    () => details ? buildTimeline(details.comments, details.reviews) : [],
    [details],
  );
  const conversationCount = timeline.length + (details?.body?.trim() ? 1 : 0);

  const totalAdditions = useMemo(() => diffFiles.reduce((sum, f) => sum + f.additions, 0), [diffFiles]);
  const totalDeletions = useMemo(() => diffFiles.reduce((sum, f) => sum + f.deletions, 0), [diffFiles]);

  return (
    <>
      <style>{markdownStyles}</style>

      {/* Header */}
      <div style={st.header}>
        <div style={st.headerLeft}>
          {prUrl && (
            <button
              onClick={() => openUrl(prUrl)}
              style={st.githubBtn}
              title="Open on GitHub"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
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
              width="14"
              height="14"
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
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                    <path d="M16.474 5.408l2.118 2.117m-.756-3.982L12.109 9.27a2.118 2.118 0 0 0-.58 1.082L11 13l2.648-.53c.41-.082.786-.283 1.082-.579l5.727-5.727a1.853 1.853 0 1 0-2.621-2.621z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M19 15v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
            </>
          )}
        </div>

        {(totalAdditions > 0 || totalDeletions > 0) && (
          <span style={st.diffStats}>
            {totalAdditions > 0 && <span style={{ color: "#5a9a5a" }}>+{totalAdditions}</span>}
            {totalDeletions > 0 && (
              <span style={{ color: "#b35650", marginLeft: totalAdditions > 0 ? 4 : 0 }}>-{totalDeletions}</span>
            )}
          </span>
        )}
      </div>

      {/* Sub-header: tabs + status pills + action pills */}
      <div style={st.subHeader}>
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

        {/* Status pills */}
        {prNumber != null && (
          <>
            {prMergeable === "MERGEABLE" && (
              <span style={{ ...st.statusPill, color: "#7ddf7d" }}>No conflicts</span>
            )}
            {prMergeable === "CONFLICTING" && (
              <span style={{ ...st.statusPill, color: "#f85149" }}>Conflicts</span>
            )}
            {prReviewDecision === "APPROVED" && (
              <span style={{ ...st.statusPill, color: "#7ddf7d" }}>Approved</span>
            )}
            {prReviewDecision === "CHANGES_REQUESTED" && (
              <span style={{ ...st.statusPill, color: "#f85149" }}>Changes requested</span>
            )}
          </>
        )}

        {/* Action pills */}
        {prState === "OPEN" && prNumber != null && (
          <>
            {(prNumber != null) && (
              <div style={{ width: 1, height: 12, background: "var(--border)" }} />
            )}
            <button
              data-close-btn
              onClick={handleClosePr}
              disabled={closing}
              style={{
                ...st.actionBtn,
                ...(closeArmed ? st.actionBtnDanger : {}),
                opacity: closing ? 0.4 : 1,
              }}
              title="Close PR without merging"
            >
              {closing ? "Closing..." : closeArmed ? "Confirm close?" : "Close"}
            </button>
            <button
              data-merge-btn
              onClick={handleMerge}
              disabled={mergeDisabled}
              style={{
                ...st.actionBtn,
                ...(mergeArmed ? st.actionBtnDanger : {}),
                opacity: mergeDisabled ? 0.4 : 1,
              }}
            >
              {merging ? "Merging..." : mergeArmed ? "Confirm merge?" : "Squash & merge"}
            </button>
            {mergeDisabledReason && !merging && (
              <span style={st.mergeNote}>{mergeDisabledReason}</span>
            )}
          </>
        )}
      </div>

      {/* Content */}
      {activeTab === "changes" && !error && !diffLoading && diffFiles.length > 0 ? (
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          {/* File tree sidebar */}
          <div ref={prSidebarRef} style={{ ...st.prSidebar, width: effectivePrSidebarWidth }}>
            <div ref={fileTreeContainerRef} style={st.prFileList}>
              <FileTreeView
                nodes={fileTree}
                depth={0}
                collapsedDirs={collapsedDirs}
                onToggleDir={toggleDir}
                onSelectFile={handleSelectFile}
                onSelectDir={handleSelectDir}
              />
            </div>
          </div>

          {/* Resize handle */}
          <div onMouseDown={handlePrSidebarResize} style={st.prResizeHandle}>
            <div style={st.prResizeLine} />
          </div>

          {/* Diff viewer — render filtered files */}
          <div ref={fileListRef} style={st.prDiffViewer}>
            {filesToShow.length > 0 ? (
              filesToShow.map((file) => (
                <div
                  key={file.newPath || file.oldPath}
                  data-filepath={file.newPath || file.oldPath}
                >
                  <DiffFileSection
                    file={file}
                    defaultExpanded={true}
                    maxLinesBeforeCollapse={300}
                    tab="pr"
                  />
                </div>
              ))
            ) : (
              <div style={st.empty}>No files match the selection</div>
            )}
          </div>
        </div>
      ) : (
        <div ref={activeTab !== "changes" ? fileListRef : undefined} style={st.content}>
          {error ? (
            <div style={st.empty}>
              {error.includes("no pull requests found") ? (
                <span style={{ fontSize: 13, color: "var(--text-primary)" }}>No open PR for this branch</span>
              ) : (
                <>
                  <span style={{ color: "#f85149" }}>Failed to load PR</span>
                  <br />
                  <span style={{ fontSize: 12, color: "var(--text-primary)", marginTop: 8, display: "block" }}>{error}</span>
                </>
              )}
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
            ) : (
              <div style={st.empty}>No file changes</div>
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
      )}
    </>
  );
}

// --- File Tree View ---

// Pre-computed style caches to avoid inline object allocation during render
const chevronExpanded: React.CSSProperties = { transform: "rotate(90deg)", flexShrink: 0 };
const chevronCollapsed: React.CSSProperties = { flexShrink: 0 };
const folderIconStyle: React.CSSProperties = { flexShrink: 0 };

const statusColors: Record<string, string> = {
  new: "#7ddf7d",
  deleted: "#f85149",
  renamed: "#d2a8ff",
  modified: "#e3b341",
};
function getStatusColor(file: DiffFile): string {
  return file.isNew ? statusColors.new
    : file.isDeleted ? statusColors.deleted
    : file.isRenamed ? statusColors.renamed
    : statusColors.modified;
}
function getStatusLetter(file: DiffFile): string {
  return file.isNew ? "A" : file.isDeleted ? "D" : file.isRenamed ? "R" : "M";
}

const FileTreeView = React.memo(function FileTreeView({
  nodes,
  depth,
  collapsedDirs,
  onToggleDir,
  onSelectFile,
  onSelectDir,
}: {
  nodes: FileTreeNode[];
  depth: number;
  collapsedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  onSelectDir: (path: string) => void;
}) {
  const pl = 10 + depth * 16;

  return (
    <>
      {nodes.map((node) => {
        const isDir = node.children.length > 0;
        const isCollapsed = collapsedDirs.has(node.path);

        if (isDir) {
          return (
            <React.Fragment key={node.path}>
              <div
                data-pr-path={node.path}
                style={{ ...st.treeDir, paddingLeft: pl }}
                className="file-list-item"
              >
                <span
                  onClick={(e) => { e.stopPropagation(); onToggleDir(node.path); }}
                  style={st.treeDirChevron}
                >
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none" style={isCollapsed ? chevronCollapsed : chevronExpanded}>
                    <path d="M4 2.4L8 6L4 9.6" stroke="var(--text-dim)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span
                  onClick={() => onSelectDir(node.path)}
                  style={st.treeDirLabel}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={folderIconStyle}>
                    <path d="M1.5 3.5v9c0 .55.45 1 1 1h11c.55 0 1-.45 1-1v-7c0-.55-.45-1-1-1H7.5l-2-2h-3c-.55 0-1 .45-1 1z" stroke="var(--text-dim)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span style={st.treeDirName}>{node.name}</span>
                </span>
              </div>
              {!isCollapsed && (
                <FileTreeView
                  nodes={node.children}
                  depth={depth + 1}
                  collapsedDirs={collapsedDirs}
                  onToggleDir={onToggleDir}
                  onSelectFile={onSelectFile}
                  onSelectDir={onSelectDir}
                />
              )}
            </React.Fragment>
          );
        }

        // Leaf file node
        const file = node.file!;
        const fp = file.newPath || file.oldPath;

        return (
          <button
            key={fp}
            data-pr-path={fp}
            onClick={() => onSelectFile(fp)}
            style={{ ...st.prFileItem, paddingLeft: pl }}
            className="file-list-item"
          >
            <span style={{ ...st.prFileStatus, color: getStatusColor(file) }}>
              {getStatusLetter(file)}
            </span>
            <span style={st.prFileItemName}>{node.name}</span>
          </button>
        );
      })}
    </>
  );
});

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
  header: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "0 12px",
    minHeight: 29,
    maxHeight: 29,
    background: "var(--bg-app)",
    borderBottom: "1px solid var(--border)",
    flexShrink: 0,
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
    flex: 1,
  },
  diffStats: {
    fontSize: 12,
    fontFamily: "'SF Mono', 'Menlo', monospace",
    fontWeight: 600,
    flexShrink: 0,
    letterSpacing: "-0.01em",
  },
  refreshBtn: {
    background: "none",
    border: "none",
    color: "var(--text-secondary)",
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
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
    fontFamily: "'SF Mono', 'Menlo', monospace",
    flexShrink: 0,
    lineHeight: "20px",
  },
  prTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
    cursor: "pointer",
    transition: "color 150ms",
    lineHeight: "20px",
  },
  titleInput: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
    background: "var(--bg-input)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: "2px 8px",
    outline: "none",
    minWidth: 200,
    flex: 1,
    maxWidth: 400,
  },
  editBtn: {
    background: "none",
    border: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
    transition: "color 150ms",
    flexShrink: 0,
  },
  githubBtn: {
    background: "none",
    border: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
    transition: "color 150ms",
    flexShrink: 0,
  },
  subHeader: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "0 12px",
    background: "var(--bg-app)",
    borderBottom: "1px solid var(--border)",
    flexShrink: 0,
  },
  tab: {
    padding: "8px 8px",
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
    padding: "8px 8px",
    background: "none",
    border: "none",
    borderBottom: "2px solid var(--text-primary)",
    color: "var(--text-primary)",
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 600,
    flexShrink: 0,
  },
  statusPill: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "-0.01em",
    flexShrink: 0,
  },
  actionBtn: {
    display: "inline-flex",
    alignItems: "center",
    background: "var(--bg-input)",
    border: "none",
    color: "var(--text-primary)",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    padding: "3px 8px",
    borderRadius: 20,
    lineHeight: "16px",
    transition: "background 150ms",
    flexShrink: 0,
  },
  actionBtnDanger: {
    background: "rgba(248, 81, 73, 0.15)",
    color: "#f85149",
  },
  mergeNote: {
    fontSize: 10,
    color: "var(--text-primary)",
    fontWeight: 500,
    flexShrink: 0,
  },
  content: {
    flex: 1,
    overflow: "auto",
    padding: "16px 20px",
  },
  empty: {
    color: "var(--text-primary)",
    fontSize: 13,
    textAlign: "center",
    padding: 48,
    fontWeight: 500,
  },
  // PR file sidebar
  prSidebar: {
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    overflow: "hidden",
  },
  prFileList: {
    flex: 1,
    overflow: "auto",
    paddingTop: 6,
  },
  prFileItem: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    padding: "5px 10px",
    border: "none",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    fontSize: 12,
    textAlign: "left" as const,
  },
  prFileStatus: {
    width: 14,
    fontSize: 11,
    fontWeight: 700,
    fontFamily: "'SF Mono', 'Menlo', monospace",
    textAlign: "center" as const,
    flexShrink: 0,
  },
  prFileItemName: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    color: "var(--text-primary)",
    fontWeight: 600,
  },
  treeDir: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    width: "100%",
    padding: "4px 10px",
    border: "none",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    fontSize: 12,
    textAlign: "left" as const,
  },
  treeDirChevron: {
    display: "flex",
    alignItems: "center",
    cursor: "pointer",
    padding: 2,
    flexShrink: 0,
  },
  treeDirLabel: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    cursor: "pointer",
    flex: 1,
    minWidth: 0,
  },
  treeDirName: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    color: "var(--text-primary)",
    fontWeight: 600,
  },
  prResizeHandle: {
    width: 6,
    minWidth: 6,
    cursor: "col-resize",
    display: "flex",
    alignItems: "stretch",
    justifyContent: "center",
    flexShrink: 0,
  },
  prResizeLine: {
    width: 1,
    background: "var(--border)",
    pointerEvents: "none" as const,
  },
  prDiffViewer: {
    flex: 1,
    overflow: "auto",
    padding: "12px 10px",
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
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
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
    color: "var(--text-primary)",
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
    color: "var(--text-primary)",
    fontWeight: 500,
  },
  commitDate: {
    color: "var(--text-primary)",
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
    border: "1px solid var(--border)",
    background: "var(--bg-elevated)",
    overflow: "hidden",
  },
  conversationHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 14px",
    background: "var(--bg-elevated)",
    borderBottom: "1px solid var(--border)",
  },
  conversationAuthor: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
  },
  conversationLabel: {
    fontSize: 10,
    fontWeight: 600,
    padding: "2px 7px",
    borderRadius: 10,
    background: "rgba(136, 136, 136, 0.12)",
    color: "var(--text-primary)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.03em",
  },
  conversationDate: {
    fontSize: 12,
    color: "var(--text-primary)",
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
