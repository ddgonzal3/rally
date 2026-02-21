import React, { useState, useEffect, useCallback, useRef } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/tauri";
import { showContextMenu } from "../lib/contextMenu";
import { startFileDrag } from "../lib/dragContext";
import { ChevronIcon, FileIcon } from "./FileIcons";
import { TaskPanel } from "./TaskPanel";
import { ScrollArea } from "./ScrollArea";
import { addToast } from "./ToastContainer";
import type { GitStatus, PrStatus, ChangesSummary } from "../lib/types";

const FILE_DRAG_THRESHOLD = 8;
const FILE_DRAG_MIN_HOLD_MS = 120;

/** Module-level set of expanded folder paths — survives component unmount/remount */
const expandedPaths = new Set<string>();

/** Module-level cache of directory listings — survives component unmount/remount */
const directoryCache = new Map<string, FileEntry[]>();

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileEntry[];
}

// --- Shared tree node ---

function relativePath(filePath: string, rootPath: string): string {
  return filePath.startsWith(rootPath)
    ? filePath.slice(rootPath.length).replace(/^\//, "")
    : filePath;
}

function fileContextMenu(
  filePath: string,
  rootPath: string,
  onRefresh?: () => void,
) {
  return [
    {
      label: "Copy Relative Path",
      action: () =>
        navigator.clipboard.writeText(relativePath(filePath, rootPath)),
    },
    {
      label: "Copy Full Path",
      action: () => navigator.clipboard.writeText(filePath),
    },
    "separator" as const,
    { label: "Reveal in Finder", action: () => api.revealInFinder(filePath) },
    "separator" as const,
    {
      label: "Move to Trash",
      action: async () => {
        try {
          await api.trashFile(filePath);
          onRefresh?.();
        } catch (e) {
          console.error("Failed to trash file:", e);
        }
      },
    },
  ];
}

const FileTreeNode = React.memo(
  function FileTreeNode({
    entry,
    depth,
    rootPath,
    activeWorkspaceId,
    activeFilePath,
    onOpenFile,
    removeChild,
  }: {
    entry: FileEntry;
    depth: number;
    rootPath: string;
    activeWorkspaceId: string | null;
    /** Path of the file currently open in the active editor pane */
    activeFilePath: string | null;
    onOpenFile: (workspaceId: string, filePath: string) => void;
    /** Called by parent to remove a child by path after trash */
    removeChild?: (path: string) => void;
  }) {
    const hasPresetChildren = Boolean(
      entry.children && entry.children.length > 0,
    );
    const [expanded, setExpanded] = useState(
      () => entry.is_dir && expandedPaths.has(entry.path),
    );
    const [children, setChildren] = useState<FileEntry[]>(
      entry.children ?? directoryCache.get(entry.path) ?? [],
    );
    const [loaded, setLoaded] = useState(
      hasPresetChildren || directoryCache.has(entry.path),
    );
    const btnRef = useRef<HTMLButtonElement>(null);

    const isActiveFile = !entry.is_dir && entry.path === activeFilePath;
    // This directory is an ancestor of the active file — should auto-expand
    const isAncestorOfActive =
      entry.is_dir &&
      activeFilePath !== null &&
      activeFilePath.startsWith(entry.path + "/");

    // Auto-load children when remounting a previously-expanded folder
    useEffect(() => {
      if (expanded && !loaded && entry.is_dir) {
        invoke<FileEntry[]>("list_directory", { path: entry.path })
          .then((entries) => {
            directoryCache.set(entry.path, entries);
            setChildren(entries);
            setLoaded(true);
          })
          .catch((e) => console.error("Failed to load directory:", e));
      }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Auto-expand ancestor directories when active file changes
    useEffect(() => {
      if (!isAncestorOfActive) return;
      expandedPaths.add(entry.path);
      setExpanded(true);
      if (!loaded && !hasPresetChildren) {
        invoke<FileEntry[]>("list_directory", { path: entry.path })
          .then((entries) => {
            directoryCache.set(entry.path, entries);
            setChildren(entries);
            setLoaded(true);
          })
          .catch((e) => console.error("Failed to load directory:", e));
      }
    }, [isAncestorOfActive]); // eslint-disable-line react-hooks/exhaustive-deps

    // Scroll active file into view
    useEffect(() => {
      if (isActiveFile && btnRef.current) {
        btnRef.current.scrollIntoView({ block: "nearest" });
      }
    }, [isActiveFile]);

    const suppressNextClickRef = useRef(false);

    const handleClick = useCallback(async () => {
      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false;
        return;
      }
      if (entry.is_dir) {
        if (!loaded) {
          try {
            const entries = await invoke<FileEntry[]>("list_directory", {
              path: entry.path,
            });
            directoryCache.set(entry.path, entries);
            setChildren(entries);
            setLoaded(true);
          } catch (e) {
            console.error("Failed to list directory:", e);
          }
        }
        setExpanded((prev) => {
          const next = !prev;
          if (next) expandedPaths.add(entry.path);
          else expandedPaths.delete(entry.path);
          return next;
        });
      } else if (activeWorkspaceId) {
        onOpenFile(activeWorkspaceId, entry.path);
      }
    }, [entry, loaded, activeWorkspaceId, onOpenFile]);

    const handleRemoveChild = useCallback(
      (path: string) => {
        setChildren((prev) => {
          const updated = prev.filter((ch) => ch.path !== path);
          directoryCache.set(entry.path, updated);
          return updated;
        });
      },
      [entry.path],
    );

    const dragStartRef = useRef<{
      x: number;
      y: number;
      startedAt: number;
    } | null>(null);

    const handleMouseDown = useCallback(
      (e: React.MouseEvent) => {
        if (entry.is_dir || e.button !== 0) return;
        const startX = e.clientX;
        const startY = e.clientY;
        dragStartRef.current = { x: startX, y: startY, startedAt: Date.now() };

        const onMouseMove = (ev: MouseEvent) => {
          if (!dragStartRef.current) return;
          if ((ev.buttons & 1) !== 1) return;
          const dx = ev.clientX - dragStartRef.current.x;
          const dy = ev.clientY - dragStartRef.current.y;
          const heldLongEnough =
            Date.now() - dragStartRef.current.startedAt >=
            FILE_DRAG_MIN_HOLD_MS;
          if (
            heldLongEnough &&
            (Math.abs(dx) > FILE_DRAG_THRESHOLD ||
              Math.abs(dy) > FILE_DRAG_THRESHOLD)
          ) {
            suppressNextClickRef.current = true;
            startFileDrag([entry.path], ev.clientX, ev.clientY);
            dragStartRef.current = null;
            document.removeEventListener("mousemove", onMouseMove);
            document.removeEventListener("mouseup", onMouseUp);
          }
        };
        const onMouseUp = () => {
          dragStartRef.current = null;
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);
        };
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
      },
      [entry.is_dir, entry.path],
    );

    return (
      <div>
        <button
          ref={btnRef}
          className={`file-node${isActiveFile ? " file-node-active" : ""}`}
          onClick={handleClick}
          onMouseDown={handleMouseDown}
          onContextMenu={(e) => {
            e.preventDefault();
            showContextMenu(
              fileContextMenu(
                entry.path,
                rootPath,
                removeChild ? () => removeChild(entry.path) : undefined,
              ),
            );
          }}
          style={{ ...styles.node, paddingLeft: depth * 10 }}
        >
          {entry.is_dir ? (
            <ChevronIcon open={expanded} />
          ) : (
            <span style={styles.spacer} />
          )}
          <FileIcon name={entry.name} isDir={entry.is_dir} isOpen={expanded} />
          <span style={styles.name}>{entry.name}</span>
        </button>
        {expanded &&
          children.map((c) => (
            <FileTreeNode
              key={c.path}
              entry={c}
              depth={depth + 1}
              rootPath={rootPath}
              activeWorkspaceId={activeWorkspaceId}
              activeFilePath={activeFilePath}
              onOpenFile={onOpenFile}
              removeChild={handleRemoveChild}
            />
          ))}
      </div>
    );
  },
  (prev, next) => {
    // Custom comparison: skip re-render when activeFilePath changes but
    // this node's active/ancestor status hasn't changed. This reduces
    // re-renders from ~200 nodes (entire tree) to ~4 (old/new active + ancestors).
    if (prev.entry !== next.entry) return false;
    if (prev.depth !== next.depth) return false;
    if (prev.rootPath !== next.rootPath) return false;
    if (prev.activeWorkspaceId !== next.activeWorkspaceId) return false;
    if (prev.onOpenFile !== next.onOpenFile) return false;
    if (prev.removeChild !== next.removeChild) return false;

    // Only re-render if this node's relevance to activeFilePath changed
    const prevActive =
      !prev.entry.is_dir && prev.activeFilePath === prev.entry.path;
    const nextActive =
      !next.entry.is_dir && next.activeFilePath === next.entry.path;
    if (prevActive !== nextActive) return false;

    const prevAncestor =
      prev.entry.is_dir &&
      !!prev.activeFilePath?.startsWith(prev.entry.path + "/");
    const nextAncestor =
      next.entry.is_dir &&
      !!next.activeFilePath?.startsWith(next.entry.path + "/");
    if (prevAncestor !== nextAncestor) return false;

    return true; // equal — skip re-render
  },
);

// --- Git status components ---

function PrBadge({ pr }: { pr?: PrStatus | null }) {
  if (!pr || pr.state !== "OPEN") return null;
  const detail = pr.is_draft
    ? "draft"
    : pr.review_decision === "APPROVED"
      ? "approved"
      : pr.mergeable === "CONFLICTING"
        ? "conflicts"
        : pr.review_decision === "CHANGES_REQUESTED"
          ? "changes req"
          : "open";
  let bg = "#3a3a2d";
  if (
    pr.mergeable === "CONFLICTING" ||
    pr.review_decision === "CHANGES_REQUESTED"
  )
    bg = "#5a2d2d";
  else if (pr.review_decision === "APPROVED" && pr.mergeable === "MERGEABLE")
    bg = "#2d5a2d";
  return (
    <span style={{ ...styles.prBadge, background: bg }}>
      PR #{pr.number} {detail}
    </span>
  );
}

// --- Icons ---

/** Git branch icon with blue change count badge. Icon turns amber when sync needed. */
function GitStatusIcon({
  status,
  syncNeeded,
  onClick,
}: {
  status?: GitStatus;
  syncNeeded?: boolean;
  onClick?: () => void;
}) {
  const changeCount =
    (status?.modified_files.length ?? 0) +
    (status?.untracked_files.length ?? 0);
  const iconColor = syncNeeded ? "#e8b930" : "#ddd";

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (onClick) onClick();
      }}
      className={`git-status-btn${syncNeeded ? " pulse-dot" : ""}`}
      title={
        syncNeeded
          ? "Sync needed — behind main"
          : changeCount > 0
            ? `${changeCount} changes — view diff`
            : "Clean"
      }
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "none",
        border: "none",
        padding: "2px",
        flexShrink: 0,
        borderRadius: 4,
        position: "relative" as const,
      }}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill={iconColor}
        style={{ flexShrink: 0 }}
      >
        <path d="M21.007 8.222A3.738 3.738 0 0 0 15.045 5.2a3.737 3.737 0 0 0 1.156 6.583 2.988 2.988 0 0 1-2.668 1.67h-2.99a4.456 4.456 0 0 0-2.989 1.165V7.4a3.737 3.737 0 1 0-1.494 0v9.117a3.776 3.776 0 1 0 1.816.099 2.99 2.99 0 0 1 2.668-1.667h2.99a4.484 4.484 0 0 0 4.223-3.039 3.736 3.736 0 0 0 3.25-3.687zM4.565 3.738a2.242 2.242 0 1 1 4.484 0 2.242 2.242 0 0 1-4.484 0zm4.484 16.441a2.242 2.242 0 1 1-4.484 0 2.242 2.242 0 0 1 4.484 0zm8.221-9.715a2.242 2.242 0 1 1 0-4.485 2.242 2.242 0 0 1 0 4.485z" />
      </svg>
      {changeCount > 0 && (
        <span
          style={{
            position: "absolute" as const,
            bottom: 0,
            right: 0,
            fontSize: 10,
            fontWeight: 800,
            lineHeight: "16px",
            color: "#fff",
            background: "#3f8eff",
            borderRadius: 8,
            padding: "0 4px",
            minWidth: 16,
            height: 16,
            textAlign: "center" as const,
            boxSizing: "border-box" as const,
          }}
        >
          {changeCount}
        </span>
      )}
    </button>
  );
}

// --- Root Section ---

function RootSection({
  rootPath,
  isGitRepo,
  showChanges,
  onToggleChanges,
  onSelectChangeFile,
}: {
  rootPath: string;
  isGitRepo: boolean;
  showChanges: boolean;
  onToggleChanges?: () => void;
  onSelectChangeFile: (
    rootPath: string,
    filePath: string,
    isUntracked: boolean,
  ) => void;
}) {
  const [filesExpanded, setFilesExpanded] = useState(true);
  const [fsEntries, setFsEntries] = useState<FileEntry[]>([]);
  const [fsLoaded, setFsLoaded] = useState(false);

  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const openFile = useWorkspaceStore((s) => s.openFile);
  const removePathFromWorkspace = useWorkspaceStore(
    (s) => s.removePathFromWorkspace,
  );
  const gitStatus = useWorkspaceStore((s) => s.gitStatuses[rootPath]);
  const prStatus = useWorkspaceStore((s) => s.prStatuses[rootPath]);
  const pathSyncNeeded = useWorkspaceStore((s) => s.syncNeeded[rootPath]);
  const canRemove = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    return (ws?.paths.length ?? 0) > 1;
  });
  // Derive active file path from the last-focused group's active editor pane.
  // Only returns a path if it's under this root — avoids cross-root highlighting.
  const activeFilePath = useWorkspaceStore((s) => {
    if (!activeWorkspaceId) return null;
    const layout = s.layouts[activeWorkspaceId];
    if (!layout) return null;
    const activeGroupId = s.activeGroupIds[activeWorkspaceId];
    const group = activeGroupId ? layout.groups[activeGroupId] : null;
    if (!group) return null;
    const pane = group.panes.find((p) => p.id === group.activePaneId);
    if (pane?.type === "editor" && pane.filePath?.startsWith(rootPath + "/")) {
      return pane.filePath;
    }
    return null;
  });
  const folderName = rootPath.split("/").pop() || rootPath;

  useEffect(() => {
    invoke<FileEntry[]>("list_directory", { path: rootPath })
      .then((r) => {
        setFsEntries(r);
        setFsLoaded(true);
      })
      .catch((e) => console.error("Failed to load root:", e));
  }, [rootPath]);

  const handleRemoveRootChild = useCallback((path: string) => {
    setFsEntries((prev) => prev.filter((e) => e.path !== path));
  }, []);

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    const actions: Parameters<typeof showContextMenu>[0] = [
      {
        label: "Copy Path",
        action: () => navigator.clipboard.writeText(rootPath),
      },
      "separator",
      { label: "Reveal in Finder", action: () => api.revealInFinder(rootPath) },
    ];
    if (canRemove) {
      actions.push("separator");
      actions.push({
        label: "Remove from Workspace",
        action: () =>
          activeWorkspaceId &&
          removePathFromWorkspace(activeWorkspaceId, rootPath),
      });
    }
    showContextMenu(actions);
  }

  return (
    <div>
      <div style={styles.rootRow} onContextMenu={handleContextMenu}>
        {isGitRepo ? (
          <GitStatusIcon
            status={gitStatus}
            syncNeeded={pathSyncNeeded}
            onClick={onToggleChanges}
          />
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setFilesExpanded(!filesExpanded);
            }}
            style={styles.rootExpandBtn}
          >
            <FileIcon name={folderName} isDir isOpen={filesExpanded} />
          </button>
        )}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 1,
            cursor: "pointer",
          }}
          onClick={() => setFilesExpanded(!filesExpanded)}
        >
          <span style={styles.rootName}>{folderName}</span>
          {isGitRepo && (
            <div style={styles.rootMeta}>
              <span style={styles.rootBranch}>
                {gitStatus?.branch ?? "..."}
                {gitStatus && gitStatus.ahead > 0 && (
                  <span style={styles.aheadCount}>+{gitStatus.ahead}</span>
                )}
              </span>
              <PrBadge pr={prStatus} />
            </div>
          )}
        </div>
      </div>

      {showChanges ? (
        <ChangesPanel
          rootPath={rootPath}
          onSelectFile={(filePath, isUntracked) =>
            onSelectChangeFile(rootPath, filePath, isUntracked)
          }
        />
      ) : (
        <>
          {filesExpanded &&
            fsLoaded &&
            fsEntries.map((e) => (
              <FileTreeNode
                key={e.path}
                entry={e}
                depth={1}
                rootPath={rootPath}
                activeWorkspaceId={activeWorkspaceId}
                activeFilePath={activeFilePath}
                onOpenFile={openFile}
                removeChild={handleRemoveRootChild}
              />
            ))}
          {activeWorkspaceId && (
            <TaskPanel rootPath={rootPath} workspaceId={activeWorkspaceId} />
          )}
        </>
      )}
    </div>
  );
}

// --- Changes Panel (replaces file tree when viewing git changes) ---

const STATUS_COLORS: Record<string, string> = {
  M: "#e8b930",
  A: "#4caf50",
  U: "#4caf50",
  D: "#df7d7d",
  R: "#5ba0d0",
  "?": "#888",
};
const GIT_CHANGES_REFRESH_EVENT = "rally:git-changes-refresh";
const BACKEND_GIT_CHANGES_UPDATED_EVENT = "git-changes-updated";

function ChangeStatusGlyph({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? "#888";
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <text
        x="8"
        y="11.4"
        textAnchor="middle"
        fill={color}
        fontSize="11.5"
        fontWeight="700"
        fontFamily="-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif"
      >
        {status}
      </text>
    </svg>
  );
}

function SectionChevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      style={{ transform: open ? "rotate(90deg)" : "none" }}
    >
      <path
        d="M4 2.4L8 6L4 9.6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StageActionGlyph({ label }: { label: string }) {
  if (label === "Stage") {
    return (
      <svg
        width="13"
        height="13"
        viewBox="0 0 13 13"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M6.5 2v9M2 6.5h9"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 13 13"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2 6.5h9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DiscardActionGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 13 13"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4 3.2V6h2.8M4 6c0-2.2 1.8-4 4-4a4 4 0 1 1-3.1 6.5"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChangeFileItem({
  path,
  status,
  isSelected,
  onClick,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
}: {
  path: string;
  status: string;
  isSelected: boolean;
  onClick: () => void;
  actionLabel: string;
  onAction: () => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
}) {
  const fileName = path.split("/").pop() ?? path;
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const displayStatus = status === "?" ? "U" : status;

  return (
    <div
      className={`change-item${isSelected ? " change-item-selected" : ""}`}
      style={{
        ...styles.changeItem,
        ...(isSelected ? styles.changeItemSelected : {}),
      }}
      onClick={onClick}
    >
      <FileIcon name={fileName} isDir={false} isOpen={false} />
      <span style={styles.changeFileName}>{fileName}</span>
      {dir && <span style={styles.changeFileDir}>{dir}</span>}
      <span style={{ flex: 1 }} />
      <div style={styles.changeRight}>
        {secondaryActionLabel && onSecondaryAction && (
          <button
            className="stage-btn change-action-btn"
            style={styles.stageBtn}
            onClick={(e) => {
              e.stopPropagation();
              onSecondaryAction();
            }}
            title={secondaryActionLabel}
          >
            <DiscardActionGlyph />
          </button>
        )}
        <button
          className="stage-btn change-action-btn"
          style={styles.stageBtn}
          onClick={(e) => {
            e.stopPropagation();
            onAction();
          }}
          title={actionLabel}
        >
          <StageActionGlyph label={actionLabel} />
        </button>
        <span style={styles.statusGlyphWrap}>
          <ChangeStatusGlyph status={displayStatus} />
        </span>
      </div>
    </div>
  );
}

type ChangeSectionKey = "staged" | "changes" | "untracked";

function ChangesSection({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  if (count === 0) return null;

  return (
    <div style={styles.changeSection}>
      <button
        className="changes-section-btn"
        style={styles.sectionHeaderButton}
        onClick={onToggle}
      >
        <span style={styles.sectionChevron}>
          <SectionChevron open={open} />
        </span>
        <span style={styles.sectionTitle}>{title}</span>
        <span style={{ flex: 1 }} />
        <span style={styles.sectionCountBadge}>{count}</span>
      </button>
      {open && <div style={styles.sectionBody}>{children}</div>}
    </div>
  );
}

function ChangesPanel({
  rootPath,
  onSelectFile,
}: {
  rootPath: string;
  onSelectFile: (filePath: string, isUntracked: boolean) => void;
}) {
  const [changes, setChanges] = useState<ChangesSummary | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [sectionOpen, setSectionOpen] = useState<
    Record<ChangeSectionKey, boolean>
  >({
    staged: true,
    changes: true,
    untracked: true,
  });

  const toggleSection = useCallback((section: ChangeSectionKey) => {
    setSectionOpen((prev) => ({ ...prev, [section]: !prev[section] }));
  }, []);

  useEffect(() => {
    setSectionOpen({
      staged: true,
      changes: true,
      untracked: true,
    });
  }, [rootPath]);

  const notifyChangesUpdated = useCallback(() => {
    document.dispatchEvent(
      new CustomEvent<{ rootPath: string }>(GIT_CHANGES_REFRESH_EVENT, {
        detail: { rootPath },
      }),
    );
  }, [rootPath]);

  const refresh = useCallback(async () => {
    try {
      setChanges(await api.gitChanges(rootPath));
    } catch (e) {
      console.error(e);
    }
  }, [rootPath]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    const onRefreshEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ rootPath?: string }>).detail;
      if (!detail || detail.rootPath === rootPath) {
        void refresh();
      }
    };
    document.addEventListener(GIT_CHANGES_REFRESH_EVENT, onRefreshEvent);
    return () =>
      document.removeEventListener(GIT_CHANGES_REFRESH_EVENT, onRefreshEvent);
  }, [refresh, rootPath]);

  async function stageFile(filePath: string) {
    try {
      await api.gitStageFile(rootPath, filePath);
      notifyChangesUpdated();
      await refresh();
    } catch (e) {
      addToast({
        type: "warning",
        title: "Stage failed",
        message: String(e),
      });
    }
  }
  async function unstageFile(filePath: string) {
    try {
      await api.gitUnstageFile(rootPath, filePath);
      notifyChangesUpdated();
      await refresh();
    } catch (e) {
      addToast({
        type: "warning",
        title: "Unstage failed",
        message: String(e),
      });
    }
  }
  async function discardFile(filePath: string, isUntracked: boolean) {
    try {
      await api.gitDiscardFile(rootPath, filePath, isUntracked);
      notifyChangesUpdated();
      if (selectedFile === filePath) setSelectedFile(null);
      await refresh();
    } catch (e) {
      addToast({
        type: "warning",
        title: "Discard failed",
        message: String(e),
      });
    }
  }

  function handleSelect(path: string, isUntracked: boolean) {
    setSelectedFile(path);
    onSelectFile(path, isUntracked);
  }

  const total = changes
    ? changes.staged.length + changes.unstaged.length + changes.untracked.length
    : 0;

  return (
    <>
      <ScrollArea style={{ flex: 1, padding: "0 4px", paddingBottom: 12 }}>
        {!changes ? (
          <div style={styles.emptyMsg}>Loading...</div>
        ) : total === 0 ? (
          <div style={styles.emptyMsg}>No changes</div>
        ) : (
          <>
            <ChangesSection
              title="Staged Changes"
              count={changes.staged.length}
              open={sectionOpen.staged}
              onToggle={() => toggleSection("staged")}
            >
              {changes.staged.map((f) => (
                <ChangeFileItem
                  key={`s-${f.path}`}
                  path={f.path}
                  status={f.status}
                  isSelected={selectedFile === f.path}
                  onClick={() => handleSelect(f.path, false)}
                  actionLabel="Unstage"
                  onAction={() => unstageFile(f.path)}
                />
              ))}
            </ChangesSection>
            <ChangesSection
              title="Changes"
              count={changes.unstaged.length}
              open={sectionOpen.changes}
              onToggle={() => toggleSection("changes")}
            >
              {changes.unstaged.map((f) => (
                <ChangeFileItem
                  key={`u-${f.path}`}
                  path={f.path}
                  status={f.status}
                  isSelected={selectedFile === f.path}
                  onClick={() => handleSelect(f.path, false)}
                  actionLabel="Stage"
                  onAction={() => stageFile(f.path)}
                  secondaryActionLabel="Discard"
                  onSecondaryAction={() => discardFile(f.path, false)}
                />
              ))}
            </ChangesSection>
            <ChangesSection
              title="Untracked"
              count={changes.untracked.length}
              open={sectionOpen.untracked}
              onToggle={() => toggleSection("untracked")}
            >
              {changes.untracked.map((p) => (
                <ChangeFileItem
                  key={`t-${p}`}
                  path={p}
                  status="?"
                  isSelected={selectedFile === p}
                  onClick={() => handleSelect(p, true)}
                  actionLabel="Stage"
                  onAction={() => stageFile(p)}
                  secondaryActionLabel="Discard"
                  onSecondaryAction={() => discardFile(p, true)}
                />
              ))}
            </ChangesSection>
          </>
        )}
      </ScrollArea>
    </>
  );
}

// --- Main FileExplorer ---

interface FileExplorerProps {
  onCollapse: () => void;
}

export function FileExplorer({ onCollapse }: FileExplorerProps) {
  // Individual selectors — avoids re-rendering on unrelated store changes
  // (git polls, ship polls, task output, etc.)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const addPathToWorkspace = useWorkspaceStore((s) => s.addPathToWorkspace);
  const openDiff = useWorkspaceStore((s) => s.openDiff);
  const setActivePathIndex = useWorkspaceStore((s) => s.setActivePathIndex);
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  const [gitRoots, setGitRoots] = useState<Set<string>>(new Set());
  const [changesOpen, setChangesOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!ws) return;
    const detected = new Set<string>();
    Promise.all(
      ws.paths.map(async (p) => {
        try {
          await api.detectGitInfo(p);
          detected.add(p);
        } catch {
          /* not git */
        }
      }),
    ).then(() => setGitRoots(detected));
  }, [ws?.paths]);

  useEffect(() => {
    const roots = ws?.paths ?? [];
    api.updateGitWatchRoots(roots).catch((e) => {
      console.error("Failed to update git watch roots:", e);
    });
  }, [ws?.id, ws?.paths]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    listen<{ rootPath: string }>(BACKEND_GIT_CHANGES_UPDATED_EVENT, (event) => {
      const rootPath = event.payload?.rootPath;
      if (!rootPath) return;
      document.dispatchEvent(
        new CustomEvent<{ rootPath: string }>(GIT_CHANGES_REFRESH_EVENT, {
          detail: { rootPath },
        }),
      );
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e) => console.error("Failed to listen for git updates:", e));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Clear changes view when workspace changes
  useEffect(() => {
    setChangesOpen(new Set());
  }, [activeWorkspaceId]);

  if (!ws) {
    return (
      <div className="no-select" style={styles.container}>
        <div style={styles.emptyMsg}>No workspace selected</div>
      </div>
    );
  }

  async function handleAddFolder() {
    if (!ws) return;
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") await addPathToWorkspace(ws.id, selected);
  }

  function handleGitIconClick(rootPath: string) {
    // Select this path as active
    if (ws) {
      const idx = ws.paths.indexOf(rootPath);
      if (idx >= 0) setActivePathIndex(ws.id, idx);
    }
    // Toggle this card between file tree and changes list
    setChangesOpen((prev) => {
      const next = new Set(prev);
      if (next.has(rootPath)) next.delete(rootPath);
      else next.add(rootPath);
      return next;
    });
  }

  function handleSelectFile(
    rootPath: string,
    filePath: string,
    isUntracked: boolean,
  ) {
    if (!activeWorkspaceId) return;
    // Open diff in the first pane
    const store = useWorkspaceStore.getState();
    const layout = store.getOrCreateLayout(activeWorkspaceId);

    // Find/reuse existing diff pane or open new
    for (const [gid, group] of Object.entries(layout.groups)) {
      const existing = group.panes.find((p) => p.type === "diff");
      if (existing) {
        // Update existing diff pane
        store.transformPane(activeWorkspaceId, gid, existing.id, {
          title: `Diff: ${filePath.split("/").pop() ?? filePath}`,
          filePath,
          cwd: rootPath,
          command: isUntracked ? "untracked" : undefined,
        });
        store.setActivePane(activeWorkspaceId, gid, existing.id);
        return;
      }
    }

    // No existing diff pane — open one
    openDiff(activeWorkspaceId, rootPath);
    // After opening, update it with the selected file
    setTimeout(() => {
      const updatedLayout = useWorkspaceStore
        .getState()
        .getOrCreateLayout(activeWorkspaceId);
      for (const [gid, group] of Object.entries(updatedLayout.groups)) {
        const pane = group.panes.find((p) => p.type === "diff");
        if (pane) {
          useWorkspaceStore
            .getState()
            .transformPane(activeWorkspaceId, gid, pane.id, {
              title: `Diff: ${filePath.split("/").pop() ?? filePath}`,
              filePath,
              cwd: rootPath,
              command: isUntracked ? "untracked" : undefined,
            });
          break;
        }
      }
    }, 50);
  }

  return (
    <div className="no-select" style={styles.container}>
      <div style={styles.explorerHeader}>
        <span style={styles.explorerTitle}>Explorer</span>
        <button
          className="tab-action"
          style={styles.explorerMenuBtn}
          onClick={(e) => {
            e.stopPropagation();
            showContextMenu([
              { label: "Add Folder to Workspace", action: handleAddFolder },
            ]);
          }}
          title="Explorer actions"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="3" r="1.2" fill="currentColor" />
            <circle cx="8" cy="8" r="1.2" fill="currentColor" />
            <circle cx="8" cy="13" r="1.2" fill="currentColor" />
          </svg>
        </button>
      </div>
      <ScrollArea style={{ flex: 1, padding: "4px 3px" }}>
        {ws.paths.map((p, index) => (
          <div
            key={p}
            style={{ ...styles.card, marginTop: index === 0 ? 0 : 6 }}
          >
            <RootSection
              rootPath={p}
              isGitRepo={gitRoots.has(p)}
              showChanges={changesOpen.has(p)}
              onToggleChanges={() => handleGitIconClick(p)}
              onSelectChangeFile={handleSelectFile}
            />
          </div>
        ))}
      </ScrollArea>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    background: "#161616",
    overflow: "hidden",
    userSelect: "none",
  },
  tree: {
    flex: 1,
    overflowY: "scroll",
    overflowX: "hidden",
    padding: "0 4px 0 4px",
    userSelect: "none",
  },
  card: {
    background: "#1b1b1b",
    borderRadius: 6,
    border: "1px solid #2e2e2e",
    overflow: "clip" as const,
    padding: 0,
  },
  explorerHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 8px 0 12px",
    minHeight: 34,
    borderBottom: "1px solid #333",
    flexShrink: 0,
  },
  explorerTitle: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    color: "#fff",
  },
  explorerMenuBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 22,
    background: "none",
    border: "none",
    color: "#999",
    cursor: "pointer",
    borderRadius: 4,
  },
  prBadge: {
    display: "inline-block",
    padding: "0 4px",
    borderRadius: 3,
    fontSize: 9,
    fontWeight: 600,
    color: "#ccc",
    background: "#333",
    lineHeight: "16px",
  },
  rootRow: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "4px 6px",
    cursor: "pointer",
    minHeight: 32,
    position: "sticky" as const,
    top: 0,
    zIndex: 5,
    background: "rgba(35, 35, 35, 0.82)",
    WebkitBackdropFilter: "blur(12px) saturate(1.2)",
    backdropFilter: "blur(12px) saturate(1.2)",
    borderRadius: "6px 6px 0 0",
  },
  rootExpandBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "none",
    border: "none",
    color: "#ccc",
    cursor: "pointer",
    padding: 0,
    flexShrink: 0,
  },
  rootName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    fontSize: 13,
    fontWeight: 600,
    color: "#eee",
  },
  rootMeta: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  rootBranch: {
    fontSize: 10,
    color: "#ccc",
    fontWeight: 600,
  },
  aheadCount: {
    color: "#e5a63a",
    marginLeft: 4,
    fontSize: 9,
    fontWeight: 600,
  },
  node: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    width: "100%",
    padding: "2px 2px",
    background: "none",
    border: "none",
    color: "#ddd",
    fontSize: 12,
    textAlign: "left" as const,
    lineHeight: 1.4,
    cursor: "pointer",
    position: "relative" as const,
  },
  spacer: {
    width: 14,
    flexShrink: 0,
  },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    marginLeft: 2,
    fontWeight: 600,
  },
  nodeHover: {
    background: "#2d2d2d",
  },
  emptyMsg: {
    padding: "8px 16px",
    color: "#888",
    fontSize: 11,
  },
  // Changes panel styles
  changeCount: {
    fontSize: 11,
    padding: "1px 6px",
    borderRadius: 8,
    background: "#404040",
    color: "#f2f2f2",
    fontWeight: 700,
  },
  changeSection: {
    marginTop: 2,
  },
  sectionHeaderButton: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "7px 10px 4px",
    border: "none",
    background: "none",
    cursor: "pointer",
    textAlign: "left" as const,
    textTransform: "uppercase" as const,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.045em",
    color: "#f0f0f0",
  },
  sectionChevron: {
    color: "#d4d4d4",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 12,
    flexShrink: 0,
  },
  sectionTitle: {
    color: "#f0f0f0",
    fontWeight: 700,
  },
  sectionCountBadge: {
    minWidth: 18,
    height: 16,
    padding: "0 5px",
    borderRadius: 8,
    background: "#404040",
    color: "#f5f5f5",
    fontSize: 11,
    fontWeight: 700,
    lineHeight: "16px",
    textAlign: "center" as const,
    boxSizing: "border-box" as const,
  },
  sectionBody: {
    paddingBottom: 4,
  },
  changeItem: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 10px",
    margin: "0 4px",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 12,
    color: "#ececec",
    minHeight: 24,
  },
  changeItemSelected: {
    background: "#2d2d2d",
  },
  changeFileName: {
    fontWeight: 500,
    color: "#f2f2f2",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  changeFileDir: {
    fontSize: 11,
    color: "#aeb3bb",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
    marginLeft: 2,
  },
  changeRight: {
    display: "flex",
    alignItems: "center",
    gap: 3,
    flexShrink: 0,
    marginLeft: 8,
  },
  statusGlyphWrap: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 16,
    marginLeft: 2,
    flexShrink: 0,
  },
  stageBtn: {
    background: "none",
    border: "none",
    borderRadius: 3,
    color: "#aeb2b8",
    cursor: "pointer",
    width: 18,
    height: 18,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    flexShrink: 0,
  },
};
