import React, { useState, useEffect, useCallback, useRef } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/tauri";
import { showContextMenu } from "../lib/contextMenu";
import { startFileDrag } from "../lib/dragContext";
import { ChevronIcon, FileIcon } from "./FileIcons";
import { TaskPanel } from "./TaskPanel";
import type { GitStatus, PrStatus, ChangesSummary } from "../lib/types";

const FILE_DRAG_THRESHOLD = 5;

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

function fileContextMenu(filePath: string, rootPath: string) {
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
  ];
}

const FileTreeNode = React.memo(function FileTreeNode({
  entry,
  depth,
  rootPath,
  activeWorkspaceId,
  activeFilePath,
  onOpenFile,
}: {
  entry: FileEntry;
  depth: number;
  rootPath: string;
  activeWorkspaceId: string | null;
  /** Path of the file currently open in the active editor pane */
  activeFilePath: string | null;
  onOpenFile: (workspaceId: string, filePath: string) => void;
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

  const handleClick = useCallback(async () => {
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

  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (entry.is_dir || e.button !== 0) return;
      const startX = e.clientX;
      const startY = e.clientY;
      dragStartRef.current = { x: startX, y: startY };

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragStartRef.current) return;
        const dx = ev.clientX - dragStartRef.current.x;
        const dy = ev.clientY - dragStartRef.current.y;
        if (
          Math.abs(dx) > FILE_DRAG_THRESHOLD ||
          Math.abs(dy) > FILE_DRAG_THRESHOLD
        ) {
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
          showContextMenu(fileContextMenu(entry.path, rootPath));
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
          />
        ))}
    </div>
  );
});

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
  const iconColor = syncNeeded ? "#e8b930" : "#ccc";

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
            fontSize: 9,
            fontWeight: 700,
            lineHeight: "14px",
            color: "#fff",
            background: "#3b82f6",
            borderRadius: 7,
            padding: "0 4px",
            minWidth: 14,
            height: 14,
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
  onGitClick,
}: {
  rootPath: string;
  isGitRepo: boolean;
  onGitClick?: () => void;
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
            onClick={onGitClick}
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
          />
        ))}
      {activeWorkspaceId && (
        <TaskPanel
          rootPath={rootPath}
          workspaceId={activeWorkspaceId}
        />
      )}
    </div>
  );
}

// --- Changes Panel (replaces file tree when viewing git changes) ---

const STATUS_COLORS: Record<string, string> = {
  M: "#e8b930",
  A: "#4caf50",
  D: "#df7d7d",
  R: "#5ba0d0",
  "?": "#888",
};

function ChangeFileItem({
  path,
  status,
  isSelected,
  onClick,
  actionLabel,
  onAction,
}: {
  path: string;
  status: string;
  isSelected: boolean;
  onClick: () => void;
  actionLabel: string;
  onAction: () => void;
}) {
  const fileName = path.split("/").pop() ?? path;
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

  return (
    <div
      className={`change-item${isSelected ? " change-item-selected" : ""}`}
      style={{
        ...styles.changeItem,
        ...(isSelected ? styles.changeItemSelected : {}),
      }}
      onClick={onClick}
    >
      <span
        style={{
          ...styles.statusLetter,
          color: STATUS_COLORS[status] ?? "#888",
        }}
      >
        {status}
      </span>
      <span style={styles.changeFileName}>{fileName}</span>
      {dir && <span style={styles.changeFileDir}>{dir}</span>}
      <button
        className="stage-btn"
        style={styles.stageBtn}
        onClick={(e) => {
          e.stopPropagation();
          onAction();
        }}
        title={actionLabel}
      >
        {actionLabel === "Stage" ? "+" : "−"}
      </button>
    </div>
  );
}

function ChangesPanel({
  rootPath,
  onBack,
  onSelectFile,
}: {
  rootPath: string;
  onBack: () => void;
  onSelectFile: (filePath: string, isUntracked: boolean) => void;
}) {
  const [changes, setChanges] = useState<ChangesSummary | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const folderName = rootPath.split("/").pop() ?? rootPath;

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

  async function stageFile(filePath: string) {
    await api.gitStageFile(rootPath, filePath);
    await refresh();
  }
  async function unstageFile(filePath: string) {
    await api.gitUnstageFile(rootPath, filePath);
    await refresh();
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
      <div style={styles.header}>
        <button
          onClick={onBack}
          title="Back to Projects"
          style={styles.headerBtn}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M10 3L5 8L10 13"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <span style={styles.headerTitle}>{folderName}</span>
        <span style={styles.changeCount}>{total}</span>
        <span style={{ flex: 1 }} />
        <button
          onClick={refresh}
          title="Refresh changes"
          style={styles.headerBtn}
        >
          <span style={{ fontSize: 13 }}>↻</span>
        </button>
      </div>

      <div style={styles.tree}>
        {!changes ? (
          <div style={styles.emptyMsg}>Loading...</div>
        ) : total === 0 ? (
          <div style={styles.emptyMsg}>No changes</div>
        ) : (
          <>
            {changes.staged.length > 0 && (
              <>
                <div style={styles.sectionHeader}>
                  STAGED{" "}
                  <span style={styles.sectionCount}>
                    {changes.staged.length}
                  </span>
                </div>
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
              </>
            )}
            {changes.unstaged.length > 0 && (
              <>
                <div style={styles.sectionHeader}>
                  CHANGES{" "}
                  <span style={styles.sectionCount}>
                    {changes.unstaged.length}
                  </span>
                </div>
                {changes.unstaged.map((f) => (
                  <ChangeFileItem
                    key={`u-${f.path}`}
                    path={f.path}
                    status={f.status}
                    isSelected={selectedFile === f.path}
                    onClick={() => handleSelect(f.path, false)}
                    actionLabel="Stage"
                    onAction={() => stageFile(f.path)}
                  />
                ))}
              </>
            )}
            {changes.untracked.length > 0 && (
              <>
                <div style={styles.sectionHeader}>
                  UNTRACKED{" "}
                  <span style={styles.sectionCount}>
                    {changes.untracked.length}
                  </span>
                </div>
                {changes.untracked.map((p) => (
                  <ChangeFileItem
                    key={`t-${p}`}
                    path={p}
                    status="?"
                    isSelected={selectedFile === p}
                    onClick={() => handleSelect(p, true)}
                    actionLabel="Stage"
                    onAction={() => stageFile(p)}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>
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
  const [changesPath, setChangesPath] = useState<string | null>(null);
  // Suppress pointer events briefly after view switch to prevent flash
  const [suppressHover, setSuppressHover] = useState(false);


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

  // Clear changes view when workspace changes
  useEffect(() => {
    setChangesPath(null);
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
    // Switch to changes view
    setChangesPath(rootPath);
  }

  function handleSelectFile(filePath: string, isUntracked: boolean) {
    if (!activeWorkspaceId || !changesPath) return;
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
          cwd: changesPath,
          command: isUntracked ? "untracked" : undefined,
        });
        store.setActivePane(activeWorkspaceId, gid, existing.id);
        return;
      }
    }

    // No existing diff pane — open one
    openDiff(activeWorkspaceId, changesPath);
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
              cwd: changesPath,
              command: isUntracked ? "untracked" : undefined,
            });
          break;
        }
      }
    }, 50);
  }

  return (
    <div className="no-select" style={styles.container}>
      {changesPath ? (
        <ChangesPanel
          rootPath={changesPath}
          onBack={() => {
            setSuppressHover(true);
            setChangesPath(null);
            setTimeout(() => setSuppressHover(false), 150);
          }}
          onSelectFile={handleSelectFile}
        />
      ) : (
        <>
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
          <div
            style={{
              ...styles.tree,
              ...(suppressHover ? { pointerEvents: "none" as const } : {}),
            }}
          >
            {ws.paths.map((p, index) => (
              <div
                key={p}
                style={{ ...styles.card, marginTop: index === 0 ? 2 : 4 }}
              >
                <RootSection
                  rootPath={p}
                  isGitRepo={gitRoots.has(p)}
                  onGitClick={() => handleGitIconClick(p)}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    background: "#1c1c1c",
    overflow: "hidden",
    userSelect: "none",
  },
  header: {
    display: "flex",
    alignItems: "center",
    padding: "8px 8px 8px 12px",
    background: "#1a1a1a",
    borderBottom: "1px solid #333",
    minHeight: 32,
    gap: 4,
  },
  headerBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "none",
    border: "none",
    color: "#666",
    cursor: "pointer",
    padding: 2,
    borderRadius: 4,
    flexShrink: 0,
  },
  headerTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: "#888",
  },
  tree: {
    flex: 1,
    overflow: "auto",
    padding: "0 4px 0 4px",
    userSelect: "none",
  },
  card: {
    background: "#1c1c1c",
    borderRadius: 6,
    margin: "2px -2px",
    overflow: "hidden",
    border: "1px solid #2a2a2a",
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
    color: "#777",
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
    padding: "4px 4px",
    cursor: "pointer",
    minHeight: 32,
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
    color: "#bbb",
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
    color: "#ccc",
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
    color: "#555",
    fontSize: 11,
  },
  // Changes panel styles
  changeCount: {
    fontSize: 10,
    padding: "1px 6px",
    borderRadius: 8,
    background: "#333",
    color: "#aaa",
    fontWeight: 600,
  },
  sectionHeader: {
    padding: "6px 12px 4px",
    fontSize: 10,
    fontWeight: 700,
    color: "#777",
    letterSpacing: "0.05em",
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  sectionCount: {
    fontSize: 9,
    color: "#555",
    fontWeight: 600,
  },
  changeItem: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 12px",
    cursor: "pointer",
    fontSize: 12,
    color: "#ccc",
    position: "relative" as const,
  },
  changeItemSelected: {
    background: "#2d2d2d",
  },
  statusLetter: {
    fontWeight: 700,
    fontSize: 11,
    width: 14,
    textAlign: "center" as const,
    flexShrink: 0,
  },
  changeFileName: {
    fontWeight: 500,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  changeFileDir: {
    fontSize: 10,
    color: "#555",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
  },
  stageBtn: {
    position: "absolute" as const,
    right: 8,
    background: "#333",
    border: "1px solid #444",
    borderRadius: 3,
    color: "#ccc",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 700,
    width: 20,
    height: 20,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
  },
};
