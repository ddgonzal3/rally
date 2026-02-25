import React, { useState, useEffect, useCallback, useRef } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { api, openUrl } from "../lib/tauri";
import { addToast } from "./ToastContainer";
import { GitDiffContent } from "./GitDiffOverlay";
import { PrReviewContent } from "./PrReviewOverlay";
export function UnifiedGitPanel() {
  const open = useWorkspaceStore((s) => s.unifiedGitPanelOpen);
  const rootPath = useWorkspaceStore((s) => s.unifiedGitPanelPath);
  const activeTab = useWorkspaceStore((s) => s.unifiedGitPanelTab);
  const setActiveTab = useWorkspaceStore((s) => s.setUnifiedGitPanelTab);
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
  const store = useWorkspaceStore.getState;

  const [mounted, setMounted] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const loadingRef = useRef<Record<string, boolean>>({});
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Mount/unmount with CSS animation (no rAF delay)
  useEffect(() => {
    if (open) {
      setExiting(false);
      setMounted(true);
    } else if (mounted) {
      setExiting(true);
      const timer = setTimeout(() => {
        setMounted(false);
        setExiting(false);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape key to close
  useEffect(() => {
    if (!mounted || !open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        if (dropdownOpen) {
          setDropdownOpen(false);
        } else {
          closePanel();
        }
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [mounted, open, closePanel, dropdownOpen]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  // --- Action handlers ---

  const withLoading = useCallback(
    (key: string, fn: (currentPath: string, currentMain: string) => Promise<unknown>) => async () => {
      if (loadingRef.current[key]) return;
      // Read current values from store to avoid stale closures
      const st = store();
      const currentPath = st.unifiedGitPanelPath;
      const ws = st.workspaces.find((w) => currentPath && w.paths.includes(currentPath));
      const currentMain = ws?.main_branch ?? "main";
      if (!currentPath) return;
      loadingRef.current = { ...loadingRef.current, [key]: true };
      setLoading((prev) => ({ ...prev, [key]: true }));
      try {
        await fn(currentPath, currentMain);
        await Promise.all([
          st.refreshGitStatusForPath(currentPath, currentMain),
          st.refreshPrStatusForPath(currentPath),
        ]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        addToast({ type: "warning", title: "Error", message: msg });
      } finally {
        loadingRef.current = { ...loadingRef.current, [key]: false };
        setLoading((prev) => ({ ...prev, [key]: false }));
      }
      setDropdownOpen(false);
    },
    [store],
  );

  const handlePush = withLoading("push", async (path) => {
    const result = await api.gitPush(path);
    addToast({ type: "success", title: "Pushed", message: result.output || "Pushed successfully" });
  });

  const handleCreatePr = withLoading("createPr", async (path) => {
    const url = await api.gitCreatePr(path);
    addToast({ type: "success", title: "PR Created", message: url });
  });

  const handleFetch = withLoading("fetch", async (path) => {
    await api.gitFetch(path);
    addToast({ type: "success", title: "Fetched", message: "Fetch complete" });
  });

  const handleRebase = withLoading("rebase", async (path, main) => {
    await store().rebaseOnMain(path, main);
    addToast({ type: "success", title: "Rebased", message: `Rebased on ${main}` });
  });

  const handleShip = useCallback(async () => {
    if (!rootPath) return;
    setDropdownOpen(false);
    await store().startShipSession(rootPath);
    closePanel();
  }, [rootPath, store, closePanel]);

  const changeCount = gitStatus
    ? gitStatus.modified_files.length + gitStatus.untracked_files.length
    : 0;
  const hasPr = !!(prStatus && prStatus.state === "OPEN");
  const folderName = rootPath?.split("/").pop() ?? "";
  const ahead = gitStatus?.ahead ?? 0;

  // When no PR, always show changes regardless of stored tab.
  // Sync back to store so we don't jump to a stale "pr" tab when a PR later opens.
  const effectiveTab = hasPr ? activeTab : "changes";
  useEffect(() => {
    if (!hasPr && activeTab === "pr") {
      setActiveTab("changes");
    }
  }, [hasPr, activeTab, setActiveTab]);

  if (!mounted) return null;

  return (
    <div
      className="git-diff-overlay"
      style={{
        ...s.backdrop,
        animation: exiting ? "panel-exit 100ms ease forwards" : "panel-enter 100ms ease forwards",
      }}
    >
      {/* Header */}
      <div style={s.header}>
        {hasPr ? (
          <>
            <button
              onClick={() => setActiveTab("changes")}
              style={effectiveTab === "changes" ? s.tabActive : s.tab}
            >
              Changes
              {changeCount > 0 && <span style={s.tabBadge}>{changeCount}</span>}
            </button>
            <button
              onClick={() => setActiveTab("pr")}
              style={effectiveTab === "pr" ? s.tabActive : s.tab}
            >
              PR #{prStatus!.number}
            </button>
          </>
        ) : null}

        <div style={{ flex: 1, minWidth: 0 }} />
        <span style={s.repoName}>{folderName}</span>
      </div>

      {/* Tab content */}
      <div style={s.content}>
        {effectiveTab === "changes" && rootPath && (
          <GitDiffContent rootPath={rootPath} />
        )}
        {effectiveTab === "pr" && rootPath && hasPr && (
          <PrReviewContent rootPath={rootPath} onClose={closePanel} scrollToFile={prScrollToFile} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dropdown Item
// ---------------------------------------------------------------------------

function DropdownItem({ icon, label, onClick, disabled, loading }: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  const inactive = disabled || loading;
  return (
    <button
      style={{
        ...s.dropdownItem,
        opacity: inactive ? 0.4 : 1,
        cursor: inactive ? "default" : "pointer",
      }}
      className="dropdown-item"
      onClick={inactive ? undefined : onClick}
      title={label}
    >
      {icon}
      <span>{label}</span>
      {loading && <span style={s.dropdownSpinner}>...</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// SVG Icons for Dropdown
// ---------------------------------------------------------------------------

const pushIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#999" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 12V4M5 7l3-3 3 3" />
  </svg>
);

const prIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#999" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="5" cy="4" r="2" />
    <circle cx="11" cy="12" r="2" />
    <path d="M5 6v6M11 6v4" />
  </svg>
);

const shipIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#999" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 11l2 3h8l2-3M4 11V5a1 1 0 011-1h6a1 1 0 011 1v6M6 4V2h4v2" />
  </svg>
);

const fetchIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#999" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 4v8M5 9l3 3 3-3" />
  </svg>
);

const rebaseIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#999" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="4" cy="4" r="1.5" />
    <circle cx="12" cy="12" r="1.5" />
    <circle cx="12" cy="4" r="1.5" />
    <path d="M4 5.5v5c0 1 1 1.5 2 1.5h4.5" />
  </svg>
);

const githubIcon = (
  <svg width="14" height="14" viewBox="0 0 98 96" fill="#999">
    <path fillRule="evenodd" clipRule="evenodd" d="M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.052-.08-9.127-13.59 2.934-16.42-5.867-16.42-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-3.015.324-3.015.324-3.015 4.934.326 7.523 5.052 7.523 5.052 4.367 7.496 11.404 5.378 14.235 4.074.404-3.178 1.699-5.378 3.074-6.6-10.839-1.141-22.243-5.378-22.243-24.283 0-5.378 1.94-9.778 5.014-13.2-.485-1.222-2.184-6.275.486-13.038 0 0 4.125-1.304 13.426 5.052a46.97 46.97 0 0 1 12.214-1.63c4.125 0 8.33.571 12.213 1.63 9.302-6.356 13.427-5.052 13.427-5.052 2.67 6.763.97 11.816.485 13.038 3.155 3.422 5.015 7.822 5.015 13.2 0 18.905-11.404 23.06-22.324 24.283 1.78 1.548 3.316 4.481 3.316 9.126 0 6.6-.08 11.897-.08 13.526 0 1.304.89 2.853 3.316 2.364 19.412-6.52 33.405-24.935 33.405-46.691C97.707 22 75.788 0 48.854 0z" />
  </svg>
);

// ---------------------------------------------------------------------------
// Panel Styles
// ---------------------------------------------------------------------------

const s: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "absolute",
    inset: 0,
    zIndex: 50,
    background: "#1a1a1a",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "0 16px",
    minHeight: 29,
    maxHeight: 29,
    borderBottom: "1px solid #2a2a2a",
    flexShrink: 0,
  },
  tab: {
    padding: "5px 10px",
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
    padding: "5px 10px",
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
  menuBtn: {
    background: "none",
    border: "none",
    color: "#999",
    cursor: "pointer",
    padding: "2px 4px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
    transition: "color 150ms",
  },
  branchPill: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 11,
    color: "#ddd",
    fontFamily: "'SF Mono', 'Menlo', monospace",
    fontWeight: 600,
    background: "none",
    padding: 0,
    lineHeight: "14px",
    minWidth: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
  content: {
    flex: 1,
    overflowX: "hidden",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
  },
  // Dropdown styles
  dropdown: {
    position: "absolute",
    top: "100%",
    right: 0,
    marginTop: 4,
    background: "rgba(36, 36, 36, 0.78)",
    WebkitBackdropFilter: "blur(20px) saturate(180%)",
    backdropFilter: "blur(20px) saturate(180%)",
    border: "1px solid rgba(255, 255, 255, 0.12)",
    borderRadius: 8,
    padding: "4px 0",
    minWidth: 160,
    zIndex: 100,
    boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
  },
  dropdownItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "7px 12px",
    background: "none",
    border: "none",
    color: "#ddd",
    fontSize: 12,
    fontWeight: 500,
    textAlign: "left" as const,
    transition: "background 100ms",
  },
  dropdownDivider: {
    height: 1,
    background: "#3a3a3a",
    margin: "4px 0",
  },
  dropdownSpinner: {
    marginLeft: "auto",
    color: "#666",
    fontSize: 11,
  },
};
