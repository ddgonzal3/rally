import React, { useState, useEffect, useCallback, useRef } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { api } from "../lib/tauri";
import { addToast } from "./ToastContainer";
import {
  parseUnifiedDiff,
  createUntrackedDiffFile,
  type DiffFile,
} from "../lib/diffParser";
import { DiffFileSection } from "./DiffFileSection";
import { CommitModal } from "./CommitModal";
import { PrReviewContent } from "./PrReviewOverlay";
import type { ChangesSummary, CommitEntry } from "../lib/types";
import { BranchSwitcher } from "./BranchSwitcher";
import { relativeTime } from "../lib/time";
import { showContextMenu } from "../lib/contextMenu";

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 320;

export function UnifiedGitPanel() {
  const open = useWorkspaceStore((s) => s.unifiedGitPanelOpen);
  const rootPath = useWorkspaceStore((s) => s.unifiedGitPanelPath);
  const panelTab = useWorkspaceStore((s) => s.unifiedGitPanelTab);
  const setPanelTab = useWorkspaceStore((s) => s.setUnifiedGitPanelTab);
  const closePanel = useWorkspaceStore((s) => s.closeUnifiedGitPanel);
  const gitStatus = useWorkspaceStore((s) =>
    rootPath ? s.gitStatuses[rootPath] : undefined,
  );
  const prStatus = useWorkspaceStore((s) =>
    rootPath ? s.prStatuses[rootPath] : null,
  );
  const prScrollToFile = useWorkspaceStore((s) => s.prReviewScrollToFile);
  const mainBranch = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => rootPath && w.paths.includes(rootPath));
    return ws?.main_branch ?? "main";
  });

  // Git diff tab (unstaged/staged)
  const diffTab = useWorkspaceStore((s) => s.gitDiffActiveTab);
  const setDiffTab = useWorkspaceStore((s) => s.setGitDiffActiveTab);
  const scrollToFile = useWorkspaceStore((s) => s.gitDiffScrollToFile);
  const refreshPrStatusForPath = useWorkspaceStore(
    (s) => s.refreshPrStatusForPath,
  );
  const refreshGitStatusForPath = useWorkspaceStore(
    (s) => s.refreshGitStatusForPath,
  );

  const [mounted, setMounted] = useState(false);
  const [entered, setEntered] = useState(false);
  const [panelWidth, setPanelWidth] = useState<number | null>(null); // null = default 55vw
  const [panelResizing, setPanelResizing] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Diff data
  const [unstagedFiles, setUnstagedFiles] = useState<DiffFile[]>([]);
  const [stagedFiles, setStagedFiles] = useState<DiffFile[]>([]);
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [commitsExpanded, setCommitsExpanded] = useState(true);
  const [changes, setChanges] = useState<ChangesSummary | null>(null);
  const [diffStatAdd, setDiffStatAdd] = useState(0);
  const [diffStatDel, setDiffStatDel] = useState(0);
  const [commitModalOpen, setCommitModalOpen] = useState(false);
  const [diffLoading, setDiffLoading] = useState(true);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null); // null = auto-sized
  const [userResized, setUserResized] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const commitBtnRef = useRef<HTMLButtonElement>(null);
  const [commitsHeight, setCommitsHeight] = useState(280);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<DiffFile[]>([]);
  const [commitDiffLoading, setCommitDiffLoading] = useState(false);
  const [selectedCommitFile, setSelectedCommitFile] = useState<string | null>(
    null,
  );
  const lastFetchedPath = useRef<string | null>(null);
  const lastFileFingerprint = useRef<string>("");

  // Mount/unmount lifecycle — slide in on open, slide out on close
  useEffect(() => {
    if (open) {
      setMounted(true);
      setEntered(false);
      const id = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(id);
    } else if (mounted) {
      // Start slide-out, unmount after transition
      setEntered(false);
      const timer = setTimeout(() => setMounted(false), 160);
      return () => clearTimeout(timer);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape key to close (but not if commit modal is open)
  useEffect(() => {
    if (!mounted || !open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !commitModalOpen) {
        e.stopPropagation();
        e.preventDefault();
        closePanel();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [mounted, open, closePanel, commitModalOpen]);

  // --- Diff data fetching ---

  const fetchDiffs = useCallback(async () => {
    if (!rootPath) return;
    try {
      const [unstagedRaw, stagedRaw, changesData, stat, commitLog] =
        await Promise.all([
          api.gitDiff(rootPath, false),
          api.gitDiff(rootPath, true),
          api.gitChanges(rootPath),
          api.gitDiffStat(rootPath),
          api
            .gitCommitLog(rootPath, mainBranch)
            .catch(() => [] as CommitEntry[]),
        ]);
      const parsedUnstaged = parseUnifiedDiff(unstagedRaw);
      if (changesData.untracked.length > 0) {
        const untrackedDiffs = await Promise.all(
          changesData.untracked.map(async (filePath) => {
            try {
              const content = await api.readFileContent(
                `${rootPath}/${filePath}`,
              );
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
      setDiffLoading(false);
      lastFetchedPath.current = rootPath ?? null;
    }
  }, [rootPath, mainBranch]);

  // Re-fetch when git status changes
  const gitStatusFingerprint = useWorkspaceStore((s) => {
    if (!rootPath) return "";
    const gs = s.gitStatuses[rootPath];
    if (!gs) return "";
    return `${gs.dirty}-${gs.modified_files.length}-${gs.untracked_files.length}`;
  });

  useEffect(() => {
    if (mounted && rootPath) {
      // Only show loading spinner on first fetch for this path;
      // on re-opens or background refreshes, keep existing data visible
      if (lastFetchedPath.current !== rootPath) {
        setDiffLoading(true);
      }
      fetchDiffs();
    }
  }, [mounted, rootPath, fetchDiffs, gitStatusFingerprint]);

  // Auto-refresh on local git changes
  useEffect(() => {
    if (!mounted) return;
    const handler = () => fetchDiffs();
    document.addEventListener("rally:git-changes-refresh", handler);
    return () =>
      document.removeEventListener("rally:git-changes-refresh", handler);
  }, [mounted, fetchDiffs]);

  // Handle scroll-to-file from store
  useEffect(() => {
    if (scrollToFile) setSelectedFile(scrollToFile);
  }, [scrollToFile]);

  // --- Action handlers ---

  const handleStage = useCallback(
    async (filePath: string) => {
      if (!rootPath) return;
      try {
        await api.gitStageFile(rootPath, filePath);
      } catch (e) {
        addToast({
          type: "warning",
          title: "Stage failed",
          message: String(e),
        });
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
        addToast({
          type: "warning",
          title: "Unstage failed",
          message: String(e),
        });
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
        addToast({
          type: "warning",
          title: "Discard failed",
          message: String(e),
        });
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
    for (const f of allFiles) await api.gitStageFile(rootPath, f);
    await fetchDiffs();
    setDiffTab("staged");
  }, [rootPath, changes, fetchDiffs, setDiffTab]);

  const handleUnstageAll = useCallback(async () => {
    if (!rootPath || !changes) return;
    for (const f of changes.staged) await api.gitUnstageFile(rootPath, f.path);
    await fetchDiffs();
    setDiffTab("unstaged");
  }, [rootPath, changes, fetchDiffs, setDiffTab]);

  const [creatingPr, setCreatingPr] = useState(false);
  const handleCreatePr = useCallback(async () => {
    if (!rootPath) return;
    setCreatingPr(true);
    try {
      const url = await api.gitCreatePr(rootPath);
      addToast({ type: "success", title: "PR created", message: url });
      refreshPrStatusForPath(rootPath).catch(() => {});
    } catch (e) {
      addToast({
        type: "warning",
        title: "Create PR failed",
        message: String(e),
      });
    } finally {
      setCreatingPr(false);
    }
  }, [rootPath, refreshPrStatusForPath]);

  // --- Sidebar resize ---

  const handleSidebarResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth =
        sidebarRef.current?.offsetWidth ?? effectiveSidebarWidth;
      let raf = 0;
      let finalWidth = startWidth;

      const onMouseMove = (ev: MouseEvent) => {
        finalWidth = Math.max(
          SIDEBAR_MIN,
          Math.min(SIDEBAR_MAX, startWidth + (ev.clientX - startX)),
        );
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          if (sidebarRef.current) {
            sidebarRef.current.style.width = finalWidth + "px";
          }
        });
      };
      const onMouseUp = () => {
        cancelAnimationFrame(raf);
        setSidebarWidth(finalWidth);
        setUserResized(true);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [sidebarWidth],
  );

  // --- Commits section vertical resize ---

  const handleCommitsResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = commitsHeight;
      const sidebarEl = sidebarRef.current;
      if (!sidebarEl) return;
      let raf = 0;
      let finalHeight = startHeight;

      const onMouseMove = (ev: MouseEvent) => {
        const sidebarRect = sidebarEl.getBoundingClientRect();
        const maxHeight = sidebarRect.height - 100;
        finalHeight = Math.max(
          60,
          Math.min(maxHeight, startHeight - (ev.clientY - startY)),
        );
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          setCommitsHeight(finalHeight);
        });
      };
      const onMouseUp = () => {
        cancelAnimationFrame(raf);
        setCommitsHeight(finalHeight);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [commitsHeight],
  );

  // --- Commit click handler ---

  const handleCommitClick = useCallback(
    async (sha: string) => {
      if (selectedCommit === sha) {
        setSelectedCommit(null);
        setCommitFiles([]);
        setSelectedCommitFile(null);
        return;
      }
      setSelectedCommit(sha);
      setCommitDiffLoading(true);
      setSelectedCommitFile(null);
      try {
        const raw = await api.gitCommitDiff(rootPath!, sha);
        const parsed = parseUnifiedDiff(raw);
        setCommitFiles(parsed);
        if (parsed.length > 0) {
          setSelectedCommitFile(parsed[0].newPath || parsed[0].oldPath);
        }
      } catch (e) {
        console.error("Failed to fetch commit diff:", e);
        setCommitFiles([]);
      } finally {
        setCommitDiffLoading(false);
      }
    },
    [selectedCommit, rootPath],
  );

  // --- Panel (left edge) resize ---

  const PANEL_MIN = 400;
  const PANEL_MAX_RATIO = 0.85; // max 85% of viewport width

  const handlePanelResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth =
      drawerRef.current?.offsetWidth ?? window.innerWidth * 0.55;
    let raf = 0;
    let finalWidth = startWidth;
    setPanelResizing(true);

    const onMouseMove = (ev: MouseEvent) => {
      const maxWidth = window.innerWidth * PANEL_MAX_RATIO;
      finalWidth = Math.max(
        PANEL_MIN,
        Math.min(maxWidth, startWidth - (ev.clientX - startX)),
      );
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (drawerRef.current) {
          drawerRef.current.style.width = finalWidth + "px";
        }
      });
    };
    const onMouseUp = () => {
      cancelAnimationFrame(raf);
      setPanelWidth(finalWidth);
      setPanelResizing(false);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  // --- Computed ---

  const hasPr = !!(prStatus && prStatus.state === "OPEN");
  const effectiveTab = hasPr ? panelTab : "changes";
  useEffect(() => {
    if (!hasPr && panelTab === "pr") setPanelTab("changes");
  }, [hasPr, panelTab, setPanelTab]);

  const activeFiles = diffTab === "unstaged" ? unstagedFiles : stagedFiles;
  const unstagedCount =
    (changes?.unstaged.length ?? 0) + (changes?.untracked.length ?? 0);
  const stagedCount = changes?.staged.length ?? 0;
  const hasStaged = stagedCount > 0;
  const folderName = rootPath?.split("/").pop() ?? "";
  const branchName = gitStatus?.branch ?? "";
  const createPrVisible = !hasPr && commits.length > 0;

  // Auto-size sidebar width based on longest file name (unless user has manually resized)
  const allFiles = [...unstagedFiles, ...stagedFiles];
  const autoWidth = (() => {
    if (allFiles.length === 0) return SIDEBAR_MIN;
    const longestName = allFiles.reduce((max, f) => {
      const name = (f.newPath || f.oldPath).split("/").pop() ?? "";
      return name.length > max ? name.length : max;
    }, 0);
    // ~7.5px per char at 12px font + 14px status + 6px gap + ~30px stats + 20px padding
    const estimated = Math.round(longestName * 7.5) + 76;
    return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, estimated));
  })();

  const effectiveSidebarWidth =
    userResized && sidebarWidth !== null ? sidebarWidth : autoWidth;

  // Recalculate sidebar width when new files appear (even if user previously resized)
  const fileFingerprint = allFiles
    .map((f) => f.newPath || f.oldPath)
    .sort()
    .join("\n");
  useEffect(() => {
    if (!fileFingerprint) return;
    if (
      lastFileFingerprint.current &&
      fileFingerprint !== lastFileFingerprint.current
    ) {
      const oldPaths = new Set(lastFileFingerprint.current.split("\n"));
      const hasNewFiles = fileFingerprint
        .split("\n")
        .some((p) => !oldPaths.has(p));
      if (hasNewFiles) {
        setUserResized(false);
        setSidebarWidth(null);
      }
    }
    lastFileFingerprint.current = fileFingerprint;
  }, [fileFingerprint]);

  // Auto-select first file when list populates
  useEffect(() => {
    if (activeFiles.length > 0 && !selectedFile) {
      setSelectedFile(activeFiles[0].newPath || activeFiles[0].oldPath);
    }
  }, [activeFiles, selectedFile]);

  // Reset selection when switching unstaged/staged
  useEffect(() => {
    setSelectedFile(null);
    setSelectedCommit(null);
    setCommitFiles([]);
    setSelectedCommitFile(null);
  }, [diffTab]);

  if (!mounted) return null;

  const expanded = open && entered;
  const selectedDiffFile = activeFiles.find(
    (f) => (f.newPath || f.oldPath) === selectedFile,
  );

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 9999,
        pointerEvents: expanded ? "auto" : "none",
      }}
      onClick={closePanel}
    >
      {/* Drawer */}
      <div
        ref={drawerRef}
        className="git-diff-overlay"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: panelWidth != null ? panelWidth : "55vw",
          minWidth: 500,
          background: "#1a1a1a",
          display: "flex",
          flexDirection: "row",
          overflow: "hidden",
          boxShadow: "-4px 0 16px rgba(0,0,0,0.25)",
          transform: expanded ? "translateX(0)" : "translateX(100%)",
          transition: expanded
            ? "transform 200ms ease-out"
            : "transform 160ms ease-in",
        }}
      >
        {/* Left edge resize handle */}
        <div
          onMouseDown={handlePanelResize}
          style={{
            width: 6,
            minWidth: 6,
            cursor: "col-resize",
            display: "flex",
            alignItems: "stretch",
            justifyContent: "center",
            flexShrink: 0,
            borderLeft: "1px solid rgba(255, 255, 255, 0.12)",
          }}
        >
          <div
            style={{
              width: 1,
              background: "transparent",
              pointerEvents: "none",
            }}
          />
        </div>

        {/* Panel content */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            minWidth: 0,
            position: "relative",
          }}
        >
          {/* Drag overlay — blocks mouse events from hitting heavy content during resize */}
          {panelResizing && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 9999,
                cursor: "col-resize",
              }}
            />
          )}
          {/* Header */}
          <div style={ms.header}>
            <span style={ms.repoName}>{folderName}</span>

            {hasPr && (
              <>
                <div
                  style={{
                    width: 1,
                    height: 14,
                    background: "#333",
                    margin: "0 4px",
                  }}
                />
                <button
                  onClick={() => setPanelTab("changes")}
                  style={effectiveTab === "changes" ? ms.tabActive : ms.tab}
                >
                  Changes
                  {unstagedCount + stagedCount > 0 && (
                    <span style={ms.tabBadge}>
                      {unstagedCount + stagedCount}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => setPanelTab("pr")}
                  style={effectiveTab === "pr" ? ms.tabActive : ms.tab}
                >
                  PR #{prStatus!.number}
                </button>
              </>
            )}

            <div style={{ flex: 1, minWidth: 0 }} />

            {branchName && rootPath && (
              <BranchSwitcher
                rootPath={rootPath}
                branchName={branchName}
                mainBranch={mainBranch}
                onBranchChanged={() => {
                  refreshGitStatusForPath(rootPath, mainBranch).catch(() => {});
                  refreshPrStatusForPath(rootPath).catch(() => {});
                }}
                variant="pill"
              />
            )}
          </div>

          {/* Sub-header: Unstaged/Staged tabs + action pills — spans full width */}
          {effectiveTab === "changes" && rootPath && (
            <div style={ms.subHeader}>
              <button
                onClick={() => setDiffTab("unstaged")}
                style={diffTab === "unstaged" ? ms.sideTabActive : ms.sideTab}
              >
                Unstaged{changes ? ` \u00B7 ${unstagedCount}` : ""}
              </button>
              <button
                onClick={() => setDiffTab("staged")}
                style={diffTab === "staged" ? ms.sideTabActive : ms.sideTab}
              >
                Staged{changes ? ` \u00B7 ${stagedCount}` : ""}
              </button>
              <div style={{ flex: 1 }} />
              {diffTab === "unstaged" && unstagedCount > 0 && (
                <>
                  <button
                    onClick={handleRevertAll}
                    style={revertConfirming ? ms.actionBtnDanger : ms.actionBtn}
                  >
                    {revertConfirming ? "Confirm?" : "Revert"}
                  </button>
                  <button onClick={handleStageAll} style={ms.actionBtn}>
                    Stage all
                  </button>
                </>
              )}
              {diffTab === "staged" && stagedCount > 0 && (
                <button onClick={handleUnstageAll} style={ms.actionBtn}>
                  Unstage all
                </button>
              )}
              {(hasStaged || unstagedCount > 0) && (
                <>
                  {(diffTab === "unstaged"
                    ? unstagedCount > 0
                    : stagedCount > 0) && (
                    <div style={{ width: 1, height: 12, background: "#333" }} />
                  )}
                  <button
                    ref={commitBtnRef}
                    onClick={() => setCommitModalOpen(true)}
                    disabled={!hasStaged && unstagedCount === 0}
                    style={{
                      ...ms.actionBtn,
                      opacity: hasStaged || unstagedCount > 0 ? 1 : 0.4,
                    }}
                  >
                    Commit
                  </button>
                </>
              )}
              {createPrVisible && (
                <button
                  onClick={handleCreatePr}
                  disabled={creatingPr}
                  style={{ ...ms.actionBtn, opacity: creatingPr ? 0.5 : 1 }}
                >
                  {creatingPr ? "Creating..." : "Create PR"}
                </button>
              )}
            </div>
          )}

          {/* Commit selection indicator */}
          {effectiveTab === "changes" && selectedCommit && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 12px",
                background: "#1a1a1a",
                borderBottom: "1px solid #2a2a2a",
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  color: "#e6edf3",
                  fontWeight: 500,
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {commits.find((c) => c.sha === selectedCommit)?.message ??
                  "Commit"}
              </span>
              <button
                onClick={() => {
                  setSelectedCommit(null);
                  setCommitFiles([]);
                  setSelectedCommitFile(null);
                }}
                style={{ ...ms.actionBtn, padding: "2px 6px", fontSize: 10 }}
              >
                {"\u2715"}
              </button>
            </div>
          )}

          {/* Content */}
          <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
            {effectiveTab === "changes" && rootPath && (
              <>
                {/* File sidebar */}
                <div
                  ref={sidebarRef}
                  style={{ ...ms.sidebar, width: effectiveSidebarWidth }}
                >
                  {/* File list */}
                  <div style={ms.fileList}>
                    {diffLoading && (
                      <div style={ms.loadingContainer}>
                        <div style={ms.loadingDots}>
                          <span
                            style={{ ...ms.loadingDot, animationDelay: "0s" }}
                          />
                          <span
                            style={{
                              ...ms.loadingDot,
                              animationDelay: "0.15s",
                            }}
                          />
                          <span
                            style={{ ...ms.loadingDot, animationDelay: "0.3s" }}
                          />
                        </div>
                      </div>
                    )}
                    {!diffLoading && activeFiles.length === 0 && (
                      <div style={ms.emptyFiles}>
                        {diffTab === "unstaged"
                          ? "No unstaged changes"
                          : "No staged changes"}
                      </div>
                    )}
                    {!diffLoading &&
                      activeFiles.map((file) => {
                        const fp = file.newPath || file.oldPath;
                        const isSelected = fp === selectedFile;
                        const fileName = fp.split("/").pop() ?? fp;
                        const dirPath = fp.includes("/")
                          ? fp.slice(0, fp.lastIndexOf("/"))
                          : "";
                        return (
                          <button
                            key={fp}
                            onClick={() => setSelectedFile(fp)}
                            style={{
                              ...ms.fileItem,
                              background: isSelected
                                ? "rgba(255,255,255,0.08)"
                                : "transparent",
                            }}
                            className="file-list-item"
                          >
                            <span
                              style={{
                                ...ms.fileStatus,
                                color: file.isNew
                                  ? "#7ddf7d"
                                  : file.isDeleted
                                    ? "#f85149"
                                    : file.isRenamed
                                      ? "#d2a8ff"
                                      : "#e3b341",
                              }}
                            >
                              {file.isNew
                                ? "A"
                                : file.isDeleted
                                  ? "D"
                                  : file.isRenamed
                                    ? "R"
                                    : "M"}
                            </span>
                            <span style={ms.fileItemName}>{fileName}</span>
                            {dirPath && (
                              <span style={ms.fileDir}>{dirPath}</span>
                            )}
                            <span style={ms.fileStats}>
                              {file.additions > 0 && (
                                <span style={{ color: "#7ddf7d" }}>
                                  +{file.additions}
                                </span>
                              )}
                              {file.deletions > 0 && (
                                <span
                                  style={{
                                    color: "#f85149",
                                    marginLeft: file.additions > 0 ? 3 : 0,
                                  }}
                                >
                                  -{file.deletions}
                                </span>
                              )}
                            </span>
                          </button>
                        );
                      })}
                  </div>

                  {/* Commits section at bottom */}
                  {!diffLoading && commits.length > 0 && (
                    <>
                      {/* Vertical resize divider */}
                      <div
                        onMouseDown={handleCommitsResize}
                        style={{
                          height: 6,
                          minHeight: 6,
                          cursor: "row-resize",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                        }}
                      >
                        <div
                          style={{
                            height: 1,
                            width: "100%",
                            background: "#2a2a2a",
                          }}
                        />
                      </div>

                      {/* Commits list */}
                      <div
                        style={{
                          ...ms.commitsSection,
                          height: commitsHeight,
                          flexShrink: 0,
                        }}
                      >
                        <div style={ms.commitsSectionHeader}>
                          <button
                            onClick={() => setCommitsExpanded((v) => !v)}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              flex: 1,
                              minWidth: 0,
                              padding: 0,
                              border: "none",
                              background: "transparent",
                              cursor: "pointer",
                              fontSize: 11,
                              fontWeight: 600,
                              color: "#e6edf3",
                              textAlign: "left",
                            }}
                            className="changes-section-btn"
                          >
                            <svg
                              width="10"
                              height="10"
                              viewBox="0 0 12 12"
                              fill="none"
                              style={{
                                transform: commitsExpanded
                                  ? "rotate(90deg)"
                                  : "none",
                                flexShrink: 0,
                              }}
                            >
                              <path
                                d="M4 2.4L8 6L4 9.6"
                                stroke="currentColor"
                                strokeWidth="1.3"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                            <span style={{ flex: 1 }}>Commits</span>
                            <span style={ms.badge}>{commits.length}</span>
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              fetchDiffs();
                            }}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              width: 20,
                              height: 20,
                              border: "none",
                              background: "transparent",
                              color: "#888",
                              cursor: "pointer",
                              padding: 0,
                              flexShrink: 0,
                            }}
                            className="icon-btn"
                            title="Refresh commits"
                          >
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 16 16"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M1.5 1.5v4h4" />
                              <path d="M1.5 5.5a6.5 6.5 0 0 1 11.48-2" />
                              <path d="M14.5 14.5v-4h-4" />
                              <path d="M14.5 10.5a6.5 6.5 0 0 1-11.48 2" />
                            </svg>
                          </button>
                        </div>
                        {commitsExpanded && (
                          <div style={{ overflow: "auto", flex: 1 }}>
                            {commits.map((c) => {
                              const isSelected = selectedCommit === c.sha;
                              return (
                                <div key={c.sha}>
                                  <button
                                    onClick={() => handleCommitClick(c.sha)}
                                    onContextMenu={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      showContextMenu([
                                        {
                                          label: "Copy SHA",
                                          action: () =>
                                            navigator.clipboard.writeText(
                                              c.sha,
                                            ),
                                        },
                                        {
                                          label: "Copy Short SHA",
                                          action: () =>
                                            navigator.clipboard.writeText(
                                              c.sha.slice(0, 7),
                                            ),
                                        },
                                      ]);
                                    }}
                                    style={{
                                      ...ms.commitRow,
                                      background: isSelected
                                        ? "rgba(255,255,255,0.08)"
                                        : "transparent",
                                    }}
                                    className="file-list-item"
                                  >
                                    <span style={ms.commitMsg}>
                                      {c.message}
                                    </span>
                                    <span style={ms.commitTime}>
                                      {relativeTime(c.date)}
                                    </span>
                                  </button>
                                  {isSelected &&
                                    !commitDiffLoading &&
                                    commitFiles.map((file) => {
                                      const fp =
                                        file.newPath || file.oldPath;
                                      const fileName =
                                        fp.split("/").pop() ?? fp;
                                      const dirPath = fp.includes("/")
                                        ? fp.slice(
                                            0,
                                            fp.lastIndexOf("/"),
                                          )
                                        : "";
                                      const isFileSelected =
                                        fp === selectedCommitFile;
                                      return (
                                        <button
                                          key={fp}
                                          onClick={() =>
                                            setSelectedCommitFile(fp)
                                          }
                                          style={{
                                            ...ms.fileItem,
                                            paddingLeft: 20,
                                            background: isFileSelected
                                              ? "rgba(255,255,255,0.08)"
                                              : "transparent",
                                          }}
                                          className="file-list-item"
                                        >
                                          <span
                                            style={{
                                              ...ms.fileStatus,
                                              color: file.isNew
                                                ? "#7ddf7d"
                                                : file.isDeleted
                                                  ? "#f85149"
                                                  : file.isRenamed
                                                    ? "#d2a8ff"
                                                    : "#e3b341",
                                            }}
                                          >
                                            {file.isNew
                                              ? "A"
                                              : file.isDeleted
                                                ? "D"
                                                : file.isRenamed
                                                  ? "R"
                                                  : "M"}
                                          </span>
                                          <span style={ms.fileItemName}>
                                            {fileName}
                                          </span>
                                          {dirPath && (
                                            <span style={ms.fileDir}>
                                              {dirPath}
                                            </span>
                                          )}
                                        </button>
                                      );
                                    })}
                                  {isSelected && commitDiffLoading && (
                                    <div
                                      style={{
                                        padding: "8px 20px",
                                        fontSize: 11,
                                        color: "#666",
                                      }}
                                    >
                                      Loading...
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>

                {/* Resize handle */}
                <div onMouseDown={handleSidebarResize} style={ms.resizeHandle}>
                  <div style={ms.resizeLine} />
                </div>

                {/* Diff viewer */}
                <div style={ms.diffViewer}>
                  {selectedCommit && selectedCommitFile ? (
                    (() => {
                      const file = commitFiles.find(
                        (f) =>
                          (f.newPath || f.oldPath) === selectedCommitFile,
                      );
                      return file ? (
                        <DiffFileSection
                          file={file}
                          defaultExpanded={true}
                          tab="pr"
                        />
                      ) : null;
                    })()
                  ) : selectedDiffFile ? (
                    <DiffFileSection
                      file={selectedDiffFile}
                      defaultExpanded={true}
                      tab={diffTab}
                      onStage={handleStage}
                      onUnstage={handleUnstage}
                      onDiscard={handleDiscard}
                    />
                  ) : !diffLoading ? (
                    <div style={ms.emptyDiff}>
                      Select a file to view its diff
                    </div>
                  ) : null}
                </div>
              </>
            )}

            {effectiveTab === "pr" && rootPath && hasPr && (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden",
                }}
              >
                <PrReviewContent
                  rootPath={rootPath}
                  onClose={closePanel}
                  scrollToFile={prScrollToFile}
                />
              </div>
            )}
          </div>
        </div>
        {/* close panel content wrapper */}
      </div>
      {/* close drawer */}

      {/* Commit Modal */}
      {rootPath && (
        <CommitModal
          open={commitModalOpen}
          onClose={() => setCommitModalOpen(false)}
          rootPath={rootPath}
          branch={branchName}
          stagedCount={stagedCount}
          unstagedCount={unstagedCount}
          additions={diffStatAdd}
          deletions={diffStatDel}
          onCommitted={fetchDiffs}
          anchorRef={commitBtnRef}
          hasPr={hasPr}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal Styles
// ---------------------------------------------------------------------------

const ms: Record<string, React.CSSProperties> = {
  header: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "0 12px",
    minHeight: 29,
    maxHeight: 29,
    background: "#1a1a1a",
    borderBottom: "1px solid #2a2a2a",
    flexShrink: 0,
  },
  repoName: {
    fontSize: 13,
    color: "#e6edf3",
    fontWeight: 600,
    pointerEvents: "none",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
  tab: {
    padding: "8px 10px",
    background: "none",
    border: "none",
    borderBottom: "2px solid transparent",
    color: "#888",
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 500,
    transition: "color 150ms",
  },
  tabActive: {
    padding: "8px 10px",
    background: "none",
    border: "none",
    borderBottom: "2px solid #e0e0e0",
    color: "#e0e0e0",
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 600,
  },
  tabBadge: {
    marginLeft: 6,
    fontSize: 11,
    fontWeight: 600,
    color: "#999",
    background: "rgba(255,255,255,0.08)",
    borderRadius: 8,
    padding: "1px 6px",
    verticalAlign: "middle",
  },
  subHeader: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "0 12px",
    background: "#1a1a1a",
    borderBottom: "1px solid #2a2a2a",
    flexShrink: 0,
  },
  sidebar: {
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    overflow: "hidden",
  },
  resizeHandle: {
    width: 6,
    minWidth: 6,
    cursor: "col-resize",
    display: "flex",
    alignItems: "stretch",
    justifyContent: "center",
    flexShrink: 0,
  },
  resizeLine: {
    width: 1,
    background: "#2a2a2a",
    pointerEvents: "none" as const,
  },
  sideTab: {
    padding: "8px 8px",
    background: "none",
    border: "none",
    borderBottom: "2px solid transparent",
    color: "#888",
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 500,
    flexShrink: 0,
  },
  sideTabActive: {
    padding: "8px 8px",
    background: "none",
    border: "none",
    borderBottom: "2px solid #e0e0e0",
    color: "#e0e0e0",
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 600,
    flexShrink: 0,
  },
  actionBtn: {
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
    transition: "background 150ms",
    flexShrink: 0,
  },
  actionBtnDanger: {
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
    transition: "background 150ms",
    flexShrink: 0,
  },
  commitsSection: {
    borderTop: "1px solid #2a2a2a",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  commitsSectionHeader: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 10px",
    background: "#222",
    flexShrink: 0,
  },
  badge: {
    minWidth: 16,
    height: 14,
    padding: "0 4px",
    borderRadius: 7,
    background: "#404040",
    color: "#fff",
    fontSize: 10,
    fontWeight: 600,
    lineHeight: "14px",
    textAlign: "center" as const,
    boxSizing: "border-box" as const,
  },
  commitRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 10px",
    fontSize: 11,
    borderBottom: "1px solid #222",
    width: "100%",
    border: "none",
    cursor: "pointer",
    textAlign: "left" as const,
    transition: "none",
  },
  commitTime: {
    fontSize: 10,
    color: "#666",
    flexShrink: 0,
    whiteSpace: "nowrap" as const,
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
  fileList: {
    flex: 1,
    overflow: "auto",
    paddingTop: 6,
  },
  fileItem: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    padding: "5px 10px",
    border: "none",
    cursor: "pointer",
    fontSize: 12,
    textAlign: "left" as const,
    transition: "none",
  },
  fileStatus: {
    width: 14,
    fontSize: 11,
    fontWeight: 700,
    fontFamily: "'SF Mono', 'Menlo', monospace",
    textAlign: "center" as const,
    flexShrink: 0,
  },
  fileItemName: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    color: "#e6edf3",
    fontWeight: 500,
  },
  fileDir: {
    fontSize: 10,
    color: "#666",
    flexShrink: 0,
    maxWidth: 120,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  fileStats: {
    fontSize: 11,
    fontFamily: "'SF Mono', 'Menlo', monospace",
    flexShrink: 0,
    fontWeight: 500,
  },
  diffViewer: {
    flex: 1,
    overflow: "auto",
    padding: "12px 10px",
  },
  emptyDiff: {
    padding: 48,
    textAlign: "center" as const,
    color: "#666",
    fontSize: 13,
  },
  emptyFiles: {
    padding: 24,
    textAlign: "center" as const,
    color: "#666",
    fontSize: 12,
  },
  loadingContainer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "32px 0",
  },
  loadingDots: {
    display: "flex",
    gap: 6,
  },
  loadingDot: {
    width: 5,
    height: 5,
    borderRadius: "50%",
    background: "#555",
    animation: "claude-dot 1.4s ease-in-out infinite",
  },
};
