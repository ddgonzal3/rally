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

/** Module-level set of expanded folder paths — persisted to localStorage */
const expandedPaths = new Set<string>(
  (() => {
    try {
      const saved = localStorage.getItem("rally:expandedPaths");
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  })(),
);

function saveExpandedPaths() {
  localStorage.setItem("rally:expandedPaths", JSON.stringify([...expandedPaths]));
}

/** Module-level cache of directory listings — survives component unmount/remount */
const directoryCache = new Map<string, FileEntry[]>();

/** Currently selected path in the file tree (for Enter-to-rename) */
let selectedFilePath: string | null = null;

function setSelectedFilePath(path: string | null) {
  selectedFilePath = path;
  document.dispatchEvent(new Event("rally:selection-change"));
}

function useSelectedFilePath() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const handler = () => setTick((t) => t + 1);
    document.addEventListener("rally:selection-change", handler);
    return () => document.removeEventListener("rally:selection-change", handler);
  }, []);
  return selectedFilePath;
}

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileEntry[];
}

// --- Inline edit state (module-level, shared across tree nodes) ---

type InlineEditState = {
  type: "rename";
  path: string;
} | {
  type: "create";
  parentPath: string;
  isDir: boolean;
  template?: string;
} | null;

let inlineEdit: InlineEditState = null;
let inlineEditVersion = 0;

let inlineEditCooldown = false;

function setInlineEdit(state: InlineEditState) {
  inlineEdit = state;
  inlineEditVersion++;
  // When clearing, set a brief cooldown to prevent the global Enter handler
  // from immediately re-entering rename mode in the same event cycle
  if (state === null) {
    inlineEditCooldown = true;
    setTimeout(() => { inlineEditCooldown = false; }, 50);
  }
  document.dispatchEvent(new Event("rally:inline-edit"));
}

/** Hook to subscribe to inline edit changes */
function useInlineEdit() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const handler = () => setTick((t) => t + 1);
    document.addEventListener("rally:inline-edit", handler);
    return () => document.removeEventListener("rally:inline-edit", handler);
  }, []);
  return inlineEdit;
}

// --- InlineInput component ---

function InlineInput({
  defaultValue,
  onCommit,
  onCancel,
  selectBasename,
  depth,
  isDir,
}: {
  defaultValue: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  selectBasename?: boolean;
  depth: number;
  isDir?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const committed = useRef(false);
  const didSelect = useRef(false);

  useEffect(() => {
    // Use rAF + setTimeout to ensure the input is fully rendered and the
    // no-select CSS override via .inline-edit-input is active before focusing.
    requestAnimationFrame(() => {
      setTimeout(() => {
        const el = inputRef.current;
        if (!el || didSelect.current) return;
        didSelect.current = true;
        el.focus();
        if (selectBasename && defaultValue.includes(".")) {
          el.setSelectionRange(0, defaultValue.lastIndexOf("."));
        } else {
          el.select();
        }
      }, 0);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = useCallback((value: string) => {
    if (committed.current) return;
    committed.current = true;
    const trimmed = value.trim();
    if (trimmed && trimmed !== defaultValue) {
      onCommit(trimmed);
    } else {
      onCancel();
    }
  }, [defaultValue, onCommit, onCancel]);

  return (
    <div
      className="inline-edit-input"
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        ...styles.node,
        paddingLeft: depth * 10,
      }}
    >
      {isDir ? <ChevronIcon open={false} /> : <span style={styles.spacer} />}
      <FileIcon name={defaultValue || (isDir ? "folder" : "file")} isDir={!!isDir} />
      <input
        ref={inputRef}
        defaultValue={defaultValue}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(e.currentTarget.value);
          }
          if (e.key === "Escape") {
            e.preventDefault();
            committed.current = true;
            onCancel();
          }
        }}
        onBlur={(e) => commit(e.currentTarget.value)}
        style={{
          flex: 1,
          minWidth: 0,
          background: "transparent",
          border: "1px solid #007acc",
          borderRadius: 2,
          color: "#e0e0e0",
          fontSize: 12,
          fontWeight: 600,
          fontFamily: "inherit",
          padding: "1px 4px",
          marginLeft: 2,
          outline: "none",
          lineHeight: "normal",
          boxShadow: "0 0 0 1px rgba(0,122,204,0.3)",
          WebkitUserSelect: "text",
          userSelect: "text",
        } as React.CSSProperties}
      />
    </div>
  );
}

// --- Shared tree node ---

function relativePath(filePath: string, rootPath: string): string {
  return filePath.startsWith(rootPath)
    ? filePath.slice(rootPath.length).replace(/^\//, "")
    : filePath;
}

function parentDir(filePath: string): string {
  return filePath.substring(0, filePath.lastIndexOf("/"));
}

function fileContextMenu(
  filePath: string,
  rootPath: string,
  isDir: boolean,
  callbacks: {
    onTrash?: () => void;
    onRename?: () => void;
    onNewFile?: (parentPath: string) => void;
    onNewFolder?: (parentPath: string) => void;
  },
) {
  const targetDir = isDir ? filePath : parentDir(filePath);
  return [
    {
      label: "New File",
      action: () => callbacks.onNewFile?.(targetDir),
    },
    {
      label: "New Folder",
      action: () => callbacks.onNewFolder?.(targetDir),
    },
    "separator" as const,
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
      label: "Rename",
      action: () => callbacks.onRename?.(),
    },
    {
      label: "Move to Trash",
      action: async () => {
        try {
          await api.trashFile(filePath);
          callbacks.onTrash?.();
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

    const editState = useInlineEdit();
    const isRenaming = editState?.type === "rename" && editState.path === entry.path;
    const isCreatingHere = editState?.type === "create" && editState.parentPath === entry.path;
    const selected = useSelectedFilePath();
    const isSelected = entry.path === selected;

    const isActiveFile = !entry.is_dir && entry.path === activeFilePath;
    // Check if this directory is an ancestor of a file being explicitly revealed
    const revealPath = useWorkspaceStore((s) => s.revealedFilePath);
    const isAncestorOfReveal =
      entry.is_dir &&
      revealPath !== null &&
      revealPath.startsWith(entry.path + "/");
    const isRevealTarget = !entry.is_dir && entry.path === revealPath;

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

    // Auto-expand ancestor directories only on explicit reveal
    useEffect(() => {
      if (!isAncestorOfReveal) return;
      expandedPaths.add(entry.path);
      saveExpandedPaths();
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
    }, [isAncestorOfReveal]); // eslint-disable-line react-hooks/exhaustive-deps

    // Scroll revealed file into view
    useEffect(() => {
      if (isRevealTarget && btnRef.current) {
        btnRef.current.scrollIntoView({ block: "nearest" });
      }
    }, [isRevealTarget]);

    const suppressNextClickRef = useRef(false);

    const handleClick = useCallback(async () => {
      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false;
        return;
      }
      setSelectedFilePath(entry.path);
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
          saveExpandedPaths();
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

    const refreshChildren = useCallback(() => {
      invoke<FileEntry[]>("list_directory", { path: entry.path })
        .then((entries) => {
          directoryCache.set(entry.path, entries);
          setChildren(entries);
          setLoaded(true);
        })
        .catch((e) => console.error("Failed to refresh directory:", e));
    }, [entry.path]);

    // Auto-expand directory when creating inside it
    useEffect(() => {
      if (isCreatingHere && !expanded) {
        expandedPaths.add(entry.path);
        saveExpandedPaths();
        setExpanded(true);
        if (!loaded) refreshChildren();
      }
    }, [isCreatingHere]); // eslint-disable-line react-hooks/exhaustive-deps

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
        {isRenaming ? (
          <InlineInput
            defaultValue={entry.name}
            selectBasename={!entry.is_dir}
            depth={depth}
            isDir={entry.is_dir}
            onCommit={async (newName) => {
              const newPath = parentDir(entry.path) + "/" + newName;
              try {
                await api.renameFile(entry.path, newPath);
                // Update caches
                const parent = parentDir(entry.path);
                directoryCache.delete(parent);
                // Notify parent to refresh
                removeChild?.(entry.path);
                // Re-list parent to get the renamed entry
                const entries = await invoke<FileEntry[]>("list_directory", { path: parent });
                directoryCache.set(parent, entries);
                // Force re-render via a DOM event
                document.dispatchEvent(new CustomEvent("rally:dir-refresh", { detail: { path: parent } }));
              } catch (e) {
                console.error("Rename failed:", e);
              }
              setInlineEdit(null);
            }}
            onCancel={() => setInlineEdit(null)}
          />
        ) : (
          <button
            ref={btnRef}
            className={`file-node${isActiveFile || isRevealTarget || isSelected ? " file-node-active" : ""}`}
            onClick={handleClick}
            onMouseDown={handleMouseDown}
            onContextMenu={(e) => {
              e.preventDefault();
              setSelectedFilePath(entry.path);
              showContextMenu(
                fileContextMenu(entry.path, rootPath, entry.is_dir, {
                  onTrash: removeChild ? () => removeChild(entry.path) : undefined,
                  onRename: () => setInlineEdit({ type: "rename", path: entry.path }),
                  onNewFile: (p) => setInlineEdit({ type: "create", parentPath: p, isDir: false }),
                  onNewFolder: (p) => setInlineEdit({ type: "create", parentPath: p, isDir: true }),
                }),
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
        )}
        {expanded && isCreatingHere && editState.type === "create" && (
          <InlineInput
            defaultValue=""
            depth={depth + 1}
            isDir={editState.isDir}
            onCommit={async (name) => {
              const newPath = entry.path + "/" + name;
              try {
                if (editState.isDir) {
                  await api.createDirectory(newPath);
                } else {
                  await api.writeFileContent(newPath, editState.template ?? "");
                }
                refreshChildren();
                if (!editState.isDir && activeWorkspaceId) {
                  onOpenFile(activeWorkspaceId, newPath);
                }
              } catch (e) {
                console.error("Create failed:", e);
              }
              setInlineEdit(null);
            }}
            onCancel={() => setInlineEdit(null)}
          />
        )}
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

    // Only re-render if this node's active-file highlight status changed
    const prevActive =
      !prev.entry.is_dir && prev.activeFilePath === prev.entry.path;
    const nextActive =
      !next.entry.is_dir && next.activeFilePath === next.entry.path;
    if (prevActive !== nextActive) return false;

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
        shapeRendering="geometricPrecision"
        style={{ flexShrink: 0 }}
      >
        <path d="M21.007 8.222A3.738 3.738 0 0 0 15.045 5.2a3.737 3.737 0 0 0 1.156 6.583 2.988 2.988 0 0 1-2.668 1.67h-2.99a4.456 4.456 0 0 0-2.989 1.165V7.4a3.737 3.737 0 1 0-1.494 0v9.117a3.776 3.776 0 1 0 1.816.099 2.99 2.99 0 0 1 2.668-1.667h2.99a4.484 4.484 0 0 0 4.223-3.039 3.736 3.736 0 0 0 3.25-3.687zM4.565 3.738a2.242 2.242 0 1 1 4.484 0 2.242 2.242 0 0 1-4.484 0zm4.484 16.441a2.242 2.242 0 1 1-4.484 0 2.242 2.242 0 0 1 4.484 0zm8.221-9.715a2.242 2.242 0 1 1 0-4.485 2.242 2.242 0 0 1 0 4.485z" />
      </svg>
      {changeCount > 0 && (
        <span
          style={{
            position: "absolute" as const,
            bottom: -2,
            right: changeCount < 10 ? -2 : -4,
            fontSize: 9,
            fontWeight: 700,
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
            lineHeight: "12px",
            color: "#fff",
            background: "#3478e0",
            borderRadius: 6,
            padding: "0 3px",
            minWidth: 12,
            height: 12,
            textAlign: "center" as const,
            boxSizing: "border-box" as const,
            WebkitFontSmoothing: "antialiased" as const,
          }}
        >
          {changeCount}
        </span>
      )}
    </button>
  );
}

// --- Repo Action Icons ---

function ShipIcon() {
  return (
    <svg width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" style={{ flexShrink: 0 }}>
      <path d="m240-198 79-32q-10-29-18.5-59T287-349l-47 32v119Zm160-42h160q18-40 29-97.5T600-455q0-99-33-187.5T480-779q-54 48-87 136.5T360-455q0 60 11 117.5t29 97.5Zm23.5-223.5Q400-487 400-520t23.5-56.5Q447-600 480-600t56.5 23.5Q560-553 560-520t-23.5 56.5Q513-440 480-440t-56.5-23.5ZM720-198v-119l-47-32q-5 30-13.5 60T641-230l79 32ZM480-881q99 72 149.5 183T680-440l84 56q17 11 26.5 29t9.5 38v237l-199-80H359L160-80v-237q0-20 9.5-38t26.5-29l84-56q0-147 50.5-258T480-881Z" />
    </svg>
  );
}

function ReviewIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path d="M12 5c-7 0-11 7-11 7s4 7 11 7 11-7 11-7-4-7-11-7z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function CreatePrIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="6" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="18" cy="18" r="2.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M6 8.5v7c0 1.4 1.1 2.5 2.5 2.5H15.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M13 15l3 3-3 3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MergeIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="6" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="18" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="12" cy="18" r="2.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M6 8.5v2c0 3 2.5 5 6 5M18 8.5v2c0 3-2.5 5-6 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function RepoActionButton({
  icon,
  tooltip,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  tooltip: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={disabled ? undefined : "repo-action-btn"}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      title={tooltip}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 22,
        height: 22,
        background: "none",
        border: "none",
        padding: "2px",
        flexShrink: 0,
        borderRadius: 4,
        color: disabled ? "#555" : "#999",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {icon}
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
  const [filesExpanded, _setFilesExpanded] = useState(() => {
    const saved = localStorage.getItem(`rally:rootExpanded:${rootPath}`);
    return saved !== null ? saved === "true" : false;
  });
  const setFilesExpanded = useCallback((v: boolean) => {
    _setFilesExpanded(v);
    localStorage.setItem(`rally:rootExpanded:${rootPath}`, String(v));
  }, [rootPath]);
  const [repoCollapsed, _setRepoCollapsed] = useState(() => {
    const saved = localStorage.getItem(`rally:repoCollapsed:${rootPath}`);
    return saved === "true";
  });
  const setRepoCollapsed = useCallback((v: boolean) => {
    _setRepoCollapsed(v);
    localStorage.setItem(`rally:repoCollapsed:${rootPath}`, String(v));
  }, [rootPath]);
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
  const openClaudeCommand = useWorkspaceStore((s) => s.openClaudeCommand);
  const startShipSession = useWorkspaceStore((s) => s.startShipSession);
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

  const editState = useInlineEdit();
  const isCreatingAtRoot = editState?.type === "create" && (
    editState.parentPath === rootPath ||
    editState.parentPath.startsWith(rootPath + "/")
  );

  const handleRemoveRootChild = useCallback((path: string) => {
    setFsEntries((prev) => prev.filter((e) => e.path !== path));
  }, []);

  const refreshRootEntries = useCallback(() => {
    invoke<FileEntry[]>("list_directory", { path: rootPath })
      .then((r) => {
        directoryCache.set(rootPath, r);
        setFsEntries(r);
        setFsLoaded(true);
      })
      .catch((e) => console.error("Failed to refresh root:", e));
  }, [rootPath]);

  // Listen for dir-refresh events (triggered by rename)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.path === rootPath) refreshRootEntries();
    };
    document.addEventListener("rally:dir-refresh", handler);
    return () => document.removeEventListener("rally:dir-refresh", handler);
  }, [rootPath, refreshRootEntries]);

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    const actions: Parameters<typeof showContextMenu>[0] = [
      {
        label: "New File",
        action: () => setInlineEdit({ type: "create", parentPath: rootPath, isDir: false }),
      },
      {
        label: "New Folder",
        action: () => setInlineEdit({ type: "create", parentPath: rootPath, isDir: true }),
      },
      "separator",
      {
        label: "New Script",
        action: () => setInlineEdit({
          type: "create",
          parentPath: rootPath + "/scripts",
          isDir: false,
          template: "#!/bin/bash\n\n",
        }),
      },
      {
        label: "New Command",
        action: () => setInlineEdit({
          type: "create",
          parentPath: rootPath + "/.claude/commands",
          isDir: false,
          template: "# Command Name\n\nDescribe what this command does.\n",
        }),
      },
      "separator",
      {
        label: "Copy Path",
        action: () => navigator.clipboard.writeText(rootPath),
      },
      { label: "Reveal in Finder", action: () => api.revealInFinder(rootPath) },
    ];
    if (isGitRepo && activeWorkspaceId) {
      const hasOpenPr = prStatus?.state === "OPEN";
      actions.push("separator");
      actions.push({
        label: hasOpenPr ? `Create PR (PR #${prStatus!.number} open)` : "Create PR",
        action: () => openClaudeCommand(activeWorkspaceId, rootPath, "/create-pr", "Create PR"),
        disabled: hasOpenPr,
      });
      actions.push({
        label: hasOpenPr ? "Review PR" : "Review PR (no open PR)",
        action: () => openClaudeCommand(activeWorkspaceId, rootPath, "/review-pr", "Review PR"),
        disabled: !hasOpenPr,
      });
      actions.push({
        label: hasOpenPr ? "Merge PR" : "Merge PR (no open PR)",
        action: () => openClaudeCommand(activeWorkspaceId, rootPath, "/merge-pr", "Merge PR"),
        disabled: !hasOpenPr,
      });
    }
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

  const handleToggleRepo = useCallback(() => {
    setRepoCollapsed(!repoCollapsed);
  }, [repoCollapsed, setRepoCollapsed]);

  const filesChevronOpen = !repoCollapsed && !showChanges && filesExpanded;

  const handleToggleFiles = useCallback(() => {
    if (repoCollapsed) {
      setRepoCollapsed(false);
      if (showChanges) onToggleChanges?.();
      if (!filesExpanded) setFilesExpanded(true);
      return;
    }
    if (showChanges) {
      if (!filesExpanded) setFilesExpanded(true);
      onToggleChanges?.();
      return;
    }
    setFilesExpanded(!filesExpanded);
  }, [
    repoCollapsed,
    setRepoCollapsed,
    showChanges,
    filesExpanded,
    setFilesExpanded,
    onToggleChanges,
  ]);

  const handleToggleChanges = useCallback(() => {
    if (repoCollapsed) setRepoCollapsed(false);
    onToggleChanges?.();
  }, [repoCollapsed, setRepoCollapsed, onToggleChanges]);

  return (
    <div>
      <div style={{
        ...styles.rootRowSticky,
        ...(repoCollapsed ? {
          borderRadius: 6,
          border: "1px solid #2e2e2e",
        } : {}),
      }} onContextMenu={handleContextMenu}>
        <div style={styles.rootRow}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleToggleFiles();
            }}
            style={styles.rootChevronBtn}
            title={filesChevronOpen ? "Hide files" : "Show files"}
          >
            <ChevronIcon open={filesChevronOpen} />
          </button>
          <div
            style={styles.rootInfo}
            onClick={(e) => {
              e.stopPropagation();
              handleToggleRepo();
            }}
            title={repoCollapsed ? "Expand repo" : "Collapse repo"}
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
          <div style={styles.rootActions}>
            {isGitRepo && (
              <>
                <RepoActionButton
                  icon={<ShipIcon />}
                  tooltip="Ship — commit, push, PR, review, merge"
                  disabled={false}
                  onClick={() => startShipSession(rootPath)}
                />
                <GitStatusIcon
                  status={gitStatus}
                  syncNeeded={pathSyncNeeded}
                  onClick={handleToggleChanges}
                />
              </>
            )}
          </div>
        </div>
      </div>

      {!repoCollapsed &&
        (showChanges ? (
          <ChangesPanel
            rootPath={rootPath}
            onSelectFile={(filePath, isUntracked) =>
              onSelectChangeFile(rootPath, filePath, isUntracked)
            }
          />
        ) : (
          <>
            {filesExpanded && isCreatingAtRoot && editState.type === "create" && (
              <InlineInput
                defaultValue={editState.template ? "" : ""}
                depth={1}
                isDir={editState.isDir}
                onCommit={async (name) => {
                  const targetDir = editState.parentPath;
                  const newPath = targetDir + "/" + name;
                  try {
                    // Ensure target directory exists (for scripts/, .claude/commands/)
                    await api.createDirectory(targetDir);
                    if (editState.isDir) {
                      await api.createDirectory(newPath);
                    } else {
                      await api.writeFileContent(newPath, editState.template ?? "");
                    }
                    refreshRootEntries();
                    // Open the file in editor if it's not a directory
                    if (!editState.isDir && activeWorkspaceId) {
                      openFile(activeWorkspaceId, newPath);
                    }
                  } catch (e) {
                    console.error("Create failed:", e);
                  }
                  setInlineEdit(null);
                }}
                onCancel={() => setInlineEdit(null)}
              />
            )}
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
        ))}
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
  const [changesOpen, setChangesOpen] = useState<Set<string>>(() => {
    if (!activeWorkspaceId) return new Set();
    try {
      const saved = localStorage.getItem(`rally:changesOpen:${activeWorkspaceId}`);
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });

  // Global Enter-to-rename: when a file is selected in the tree, Enter triggers rename
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.metaKey || e.ctrlKey || e.altKey) return;
      // Don't trigger if focus is in an input, textarea, or contentEditable
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || (active as HTMLElement).isContentEditable)) return;
      if (!selectedFilePath || inlineEdit || inlineEditCooldown) return;
      e.preventDefault();
      setInlineEdit({ type: "rename", path: selectedFilePath });
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const handleAddFolder = useCallback(async () => {
    if (!ws) {
      addToast({
        type: "warning",
        title: "No workspace selected",
        message: "Create or select a workspace first.",
      });
      return;
    }
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") await addPathToWorkspace(ws.id, selected);
  }, [ws, addPathToWorkspace]);

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

  // Restore changes view when workspace changes
  useEffect(() => {
    if (!activeWorkspaceId) { setChangesOpen(new Set()); return; }
    try {
      const saved = localStorage.getItem(`rally:changesOpen:${activeWorkspaceId}`);
      setChangesOpen(saved ? new Set(JSON.parse(saved)) : new Set());
    } catch { setChangesOpen(new Set()); }
  }, [activeWorkspaceId]);

  if (!ws) {
    return (
      <div className="no-select" style={styles.container}>
        <div style={styles.emptyMsg}>No workspace selected</div>
      </div>
    );
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
      if (activeWorkspaceId) {
        localStorage.setItem(`rally:changesOpen:${activeWorkspaceId}`, JSON.stringify([...next]));
      }
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
          style={styles.explorerAddBtn}
          onClick={(e) => {
            e.stopPropagation();
            void handleAddFolder();
          }}
          title="Add folder to workspace"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M6 2v8M2 6h8"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
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
    border: "1px solid transparent",
    borderBottomColor: "#2e2e2e",
    padding: 0,
  },
  explorerHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 8px 0 12px",
    minHeight: 29,
    maxHeight: 29,
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
  explorerAddBtn: {
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
  rootRowSticky: {
    position: "sticky" as const,
    top: 0,
    zIndex: 5,
    borderRadius: "6px 6px 0 0",
    overflow: "hidden",
    border: "1px solid #2e2e2e",
    borderBottom: "none",
    margin: "-1px -1px 0 -1px",
  },
  rootRow: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "4px 6px",
    minHeight: 32,
    background: "rgba(35, 35, 35, 0.82)",
    WebkitBackdropFilter: "blur(12px) saturate(1.2)",
    backdropFilter: "blur(12px) saturate(1.2)",
  },
  rootChevronBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 18,
    height: 18,
    background: "none",
    border: "none",
    borderRadius: 4,
    cursor: "pointer",
    padding: 0,
    flexShrink: 0,
  },
  rootInfo: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column" as const,
    gap: 1,
    cursor: "pointer",
  },
  rootActions: {
    display: "flex",
    alignItems: "center",
    gap: 0,
    marginLeft: 6,
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
    color: "#fff",
    fontWeight: 600,
    WebkitFontSmoothing: "antialiased" as const,
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
    color: "#fff",
    fontSize: 11,
    fontWeight: 600,
    lineHeight: "16px",
    textAlign: "center" as const,
    boxSizing: "border-box" as const,
    WebkitFontSmoothing: "antialiased" as const,
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
