import React, { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/tauri";
import { showContextMenu, type MenuAction } from "../lib/contextMenu";
import { startFileDrag } from "../lib/dragContext";
import { ChevronIcon, FileIcon } from "./FileIcons";
import { TaskPanel } from "./TaskPanel";
import { ScrollArea } from "./ScrollArea";
import { addToast, useToastStore } from "./ToastContainer";
import { parseUnifiedDiff, type DiffFile } from "../lib/diffParser";
import type { GitStatus, PrStatus, ChangesSummary, LayoutPreset } from "../lib/types";

const FILE_DRAG_THRESHOLD = 8;
const FILE_DRAG_MIN_HOLD_MS = 120;
const REPO_DRAG_THRESHOLD = 4;
const REPO_REORDER_TRANSITION = "transform 170ms cubic-bezier(0.2, 0, 0, 1)";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function elementOuterHeight(el: HTMLElement): number {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  const marginTop = Number.parseFloat(style.marginTop) || 0;
  const marginBottom = Number.parseFloat(style.marginBottom) || 0;
  return rect.height + marginTop + marginBottom;
}

function computeRepoInsertIndex(
  orderedPaths: string[],
  draggedPath: string,
  cardRefs: Map<string, HTMLDivElement>,
  pointerY: number,
): number {
  if (orderedPaths.length <= 1) return 0;
  const dragIdx = orderedPaths.indexOf(draggedPath);
  let insertionIndex = 0;
  for (let i = 0; i < orderedPaths.length; i++) {
    const path = orderedPaths[i];
    if (path === draggedPath) continue;
    const el = cardRefs.get(path);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    const threshold = Math.min(rect.height * 0.2, 28);
    // Direction-aware: swap triggers when pointer enters the NEAR edge
    // of each card. Cards above → use bottom edge; cards below → use top edge.
    const crossLine =
      i < dragIdx
        ? rect.bottom - threshold // dragging UP past this card
        : rect.top + threshold; // dragging DOWN past this card
    if (pointerY > crossLine) {
      insertionIndex++;
    }
  }
  return clamp(insertionIndex, 0, orderedPaths.length - 1);
}

/** Module-level set of expanded folder paths — persisted to localStorage */
const expandedPaths = new Set<string>(
  (() => {
    try {
      const saved = localStorage.getItem("rally:expandedPaths");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  })(),
);

function saveExpandedPaths() {
  localStorage.setItem(
    "rally:expandedPaths",
    JSON.stringify([...expandedPaths]),
  );
}

/** Return current expanded paths (for layout preset save). */
export function getExpandedPaths(): string[] {
  return [...expandedPaths];
}

/**
 * Replace expanded paths under given root prefixes and persist.
 * If no roots provided, replaces ALL expanded paths.
 * Used by layout preset restore to swap explorer state for one workspace
 * without affecting expanded paths from other workspaces.
 */
export function setExpandedPaths(paths: string[], roots?: string[]): void {
  if (roots && roots.length > 0) {
    // Remove only paths belonging to the specified roots, then add the new ones
    for (const ep of [...expandedPaths]) {
      if (roots.some((r) => ep === r || ep.startsWith(r + "/"))) {
        expandedPaths.delete(ep);
      }
    }
  } else {
    expandedPaths.clear();
  }
  for (const p of paths) expandedPaths.add(p);
  saveExpandedPaths();
  document.dispatchEvent(new Event("rally:expanded-paths-changed"));
}

/** Module-level cache of directory listings — survives component unmount/remount */
const directoryCache = new Map<string, FileEntry[]>();

/** Module-level cache of gitignored file names per directory */
const gitIgnoredCache = new Map<string, Set<string>>();

/** Fetch gitignored names for a directory and cache them */
function fetchGitIgnored(dirPath: string) {
  api.listGitignored(dirPath)
    .then((names) => {
      gitIgnoredCache.set(dirPath, new Set(names));
    })
    .catch(() => {
      // Not a git repo or error — no ignored files
      gitIgnoredCache.set(dirPath, new Set());
    });
}

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
    return () =>
      document.removeEventListener("rally:selection-change", handler);
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

type InlineEditState =
  | {
      type: "rename";
      path: string;
    }
  | {
      type: "create";
      parentPath: string;
      isDir: boolean;
      template?: string;
    }
  | null;

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
    setTimeout(() => {
      inlineEditCooldown = false;
    }, 50);
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

  const commit = useCallback(
    (value: string) => {
      if (committed.current) return;
      committed.current = true;
      const trimmed = value.trim();
      if (trimmed && trimmed !== defaultValue) {
        onCommit(trimmed);
      } else {
        onCancel();
      }
    },
    [defaultValue, onCommit, onCancel],
  );

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
      <FileIcon
        name={defaultValue || (isDir ? "folder" : "file")}
        isDir={!!isDir}
      />
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
        style={
          {
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
          } as React.CSSProperties
        }
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
    const renameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const editState = useInlineEdit();
    const isRenaming =
      editState?.type === "rename" && editState.path === entry.path;
    const isCreatingHere =
      editState?.type === "create" && editState.parentPath === entry.path;
    const selected = useSelectedFilePath();
    const isSelected = entry.path === selected;

    // Check if this entry is gitignored (by checking parent directory's cache)
    const parentPath = entry.path.replace(/\/[^/]+$/, "");
    const isGitIgnored = gitIgnoredCache.get(parentPath)?.has(entry.name) ?? false;

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
            fetchGitIgnored(entry.path);
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
            fetchGitIgnored(entry.path);
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

    const handleClick = useCallback(
      async (e: React.MouseEvent) => {
        if (suppressNextClickRef.current) {
          suppressNextClickRef.current = false;
          return;
        }
        if (renameTimerRef.current) {
          clearTimeout(renameTimerRef.current);
          renameTimerRef.current = null;
        }
        const wasSelected = selectedFilePath === entry.path;
        // Only trigger rename if click was on the text label, not chevron/icon
        const clickedOnText =
          (e.target as HTMLElement).closest("[data-file-name]") !== null;
        setSelectedFilePath(entry.path);
        if (entry.is_dir) {
          if (!loaded) {
            try {
              const entries = await invoke<FileEntry[]>("list_directory", {
                path: entry.path,
              });
              directoryCache.set(entry.path, entries);
              fetchGitIgnored(entry.path);
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
        } else if (wasSelected && clickedOnText) {
          // Already selected file, clicked on text — start rename after delay
          renameTimerRef.current = setTimeout(() => {
            renameTimerRef.current = null;
            setInlineEdit({ type: "rename", path: entry.path });
          }, 350);
        } else if (activeWorkspaceId) {
          onOpenFile(activeWorkspaceId, entry.path);
        }
      },
      [entry, loaded, activeWorkspaceId, onOpenFile],
    );

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
          fetchGitIgnored(entry.path);
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

    // Re-fetch directory listing when filesystem changes are detected
    useEffect(() => {
      if (!entry.is_dir || !expanded) return;
      const handler = (e: Event) => {
        const detail = (e as CustomEvent<{ rootPath: string }>).detail;
        // Refresh if this directory is under the changed root
        if (detail?.rootPath && entry.path.startsWith(detail.rootPath)) {
          refreshChildren();
        }
      };
      document.addEventListener(FS_CHANGED_EVENT, handler);
      return () => document.removeEventListener(FS_CHANGED_EVENT, handler);
    }, [entry.is_dir, entry.path, expanded, refreshChildren]);

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
                const entries = await invoke<FileEntry[]>("list_directory", {
                  path: parent,
                });
                directoryCache.set(parent, entries);
                fetchGitIgnored(parent);
                // Force re-render via a DOM event
                document.dispatchEvent(
                  new CustomEvent("rally:dir-refresh", {
                    detail: { path: parent },
                  }),
                );
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
            onDoubleClick={() => {
              if (renameTimerRef.current) {
                clearTimeout(renameTimerRef.current);
                renameTimerRef.current = null;
              }
            }}
            onMouseDown={handleMouseDown}
            onContextMenu={(e) => {
              e.preventDefault();
              setSelectedFilePath(entry.path);
              showContextMenu(
                fileContextMenu(entry.path, rootPath, entry.is_dir, {
                  onTrash: removeChild
                    ? () => removeChild(entry.path)
                    : undefined,
                  onRename: () =>
                    setInlineEdit({ type: "rename", path: entry.path }),
                  onNewFile: (p) =>
                    setInlineEdit({
                      type: "create",
                      parentPath: p,
                      isDir: false,
                    }),
                  onNewFolder: (p) =>
                    setInlineEdit({
                      type: "create",
                      parentPath: p,
                      isDir: true,
                    }),
                }),
              );
            }}
            style={{ ...styles.node, paddingLeft: depth * 10, ...(isGitIgnored ? { opacity: 0.4 } : undefined) }}
          >
            {entry.is_dir ? (
              <ChevronIcon open={expanded} />
            ) : (
              <span style={styles.spacer} />
            )}
            <FileIcon name={entry.name} isDir={entry.is_dir} isOpen={false} />
            <span data-file-name style={styles.name}>
              {entry.name}
            </span>
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

function PrIcon({ color = "#999" }: { color?: string }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      style={{ flexShrink: 0 }}
    >
      <path
        d="M9 6C9 7.65685 7.65685 9 6 9C4.34315 9 3 7.65685 3 6C3 4.34315 4.34315 3 6 3C7.65685 3 9 4.34315 9 6Z"
        stroke={color}
        strokeWidth="1.5"
      />
      <path
        d="M9 18C9 19.6569 7.65685 21 6 21C4.34315 21 3 19.6569 3 18C3 16.3431 4.34315 15 6 15C7.65685 15 9 16.3431 9 18Z"
        stroke={color}
        strokeWidth="1.5"
      />
      <path
        d="M21 18C21 19.6569 19.6569 21 18 21C16.3431 21 15 19.6569 15 18C15 16.3431 16.3431 15 18 15C19.6569 15 21 16.3431 21 18Z"
        stroke={color}
        strokeWidth="1.5"
      />
      <path
        d="M12 6C14.8284 6 16.2426 6 17.1213 6.87868C18 7.75736 18 9.17157 18 12V15"
        stroke={color}
        strokeWidth="1.5"
      />
      <path
        d="M15 3L12.0605 5.93945C12.0271 5.97289 12.0271 6.02711 12.0605 6.06055L15 9"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 15V9"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PrBadge({
  pr,
  onClick,
}: {
  pr?: PrStatus | null;
  onClick?: () => void;
}) {
  if (!pr || pr.state !== "OPEN") return null;
  const color = pr.is_draft ? "#e8b930" : "#999";
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      className="repo-action-btn"
      title={pr.is_draft ? `Draft PR #${pr.number}` : `PR #${pr.number}`}
      style={{
        ...styles.prBadge,
        cursor: onClick ? "pointer" : "default",
      }}
    >
      <PrIcon color={color} />
    </button>
  );
}

// --- Icons ---

/** Git branch icon with blue change count badge. */
function GitStatusIcon({
  status,
  onClick,
  active,
}: {
  status?: GitStatus;
  onClick?: () => void;
  active?: boolean;
}) {
  const changeCount = status?.modified_files.length ?? 0;

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (onClick) onClick();
      }}
      className="repo-action-btn"
      title={changeCount > 0 ? `${changeCount} changes — view diff` : "Clean"}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: active ? "rgba(255, 255, 255, 0.1)" : "none",
        border: "none",
        padding: "4px",
        flexShrink: 0,
        borderRadius: 6,
        position: "relative" as const,
      }}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill={active ? "#fff" : "#ddd"}
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
            fontSize: 10,
            fontWeight: 700,
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
            lineHeight: "14px",
            color: "#fff",
            background: "#3478e0",
            borderRadius: 7,
            padding: "0 4px",
            minWidth: 14,
            height: 14,
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

// --- Clone Repo Modal ---

function CloneRepoModal({
  sourcePath,
  onClose,
}: {
  sourcePath: string;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState("");

  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const addPathToWorkspace = useWorkspaceStore((s) => s.addPathToWorkspace);

  const parentDir = sourcePath.replace(/\/[^/]+$/, "");
  const previewPath = name.trim()
    ? `${parentDir}/${name.trim()}`
    : "";

  async function handleClone() {
    if (!name.trim() || !activeWorkspaceId) return;
    setCloning(true);
    setError("");
    try {
      const newPath = await api.cloneRepo(sourcePath, name.trim());
      await addPathToWorkspace(activeWorkspaceId, newPath);
      useWorkspaceStore.getState().openTerminalInBottom(activeWorkspaceId, newPath);
      onClose();
    } catch (e: any) {
      setError(typeof e === "string" ? e : (e.message ?? "Clone failed"));
    } finally {
      setCloning(false);
    }
  }

  return createPortal(
    <div style={styles.cloneModalOverlay} onClick={onClose}>
      <div style={styles.cloneModal} onClick={(e) => e.stopPropagation()}>
        {/* Top row: icon + close */}
        <div style={styles.cloneModalTopRow}>
          <svg
            width="20"
            height="20"
            viewBox="0 0 16 16"
            fill="none"
            style={{ color: "#e0e0e0" }}
          >
            <path
              d="M8 1v4M8 11v4M1 8h4M11 8h4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <rect
              x="5"
              y="5"
              width="6"
              height="6"
              rx="1.5"
              stroke="currentColor"
              strokeWidth="1.5"
            />
          </svg>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={styles.cloneModalCloseBtn}>
            <svg width="14" height="14" viewBox="0 0 18 18" fill="none">
              <path
                d="M5 5l8 8M13 5l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div style={styles.cloneModalBody}>
          <div style={styles.cloneModalTitle}>New Checkout</div>

          <span style={styles.cloneModalLabel}>Name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError("");
            }}
            onKeyDown={(e) => e.key === "Enter" && handleClone()}
            style={styles.cloneModalInput}
          />

          {previewPath && (
            <div style={styles.cloneModalPreview}>{previewPath}</div>
          )}
          {error && <div style={styles.cloneModalError}>{error}</div>}

          <button
            onClick={handleClone}
            disabled={!name.trim() || cloning}
            style={{
              ...styles.cloneModalContinueBtn,
              opacity: name.trim() && !cloning ? 1 : 0.4,
            }}
          >
            {cloning ? "Cloning\u2026" : "Clone"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// --- Root Section ---

function RootSection({
  rootPath,
  isGitRepo,
  showChanges,
  showPrFiles,
  onToggleChanges,
  onSelectChangeFile,
  onSelectPrFile,
  onRootHeaderMouseDown,
  shouldSuppressHeaderClick,
}: {
  rootPath: string;
  isGitRepo: boolean;
  showChanges: boolean;
  showPrFiles: boolean;
  onToggleChanges?: () => void;
  onSelectChangeFile: (
    rootPath: string,
    filePath: string,
    isUntracked: boolean,
    section?: "staged" | "unstaged" | "untracked",
  ) => void;
  onSelectPrFile: (rootPath: string, filePath: string) => void;
  onRootHeaderMouseDown?: (
    e: React.MouseEvent<HTMLDivElement>,
    rootPath: string,
  ) => void;
  shouldSuppressHeaderClick?: () => boolean;
}) {
  const [filesExpanded, _setFilesExpanded] = useState(() => {
    const saved = localStorage.getItem(`rally:rootExpanded:${rootPath}`);
    return saved !== null ? saved === "true" : false;
  });
  const setFilesExpanded = useCallback(
    (v: boolean) => {
      _setFilesExpanded(v);
      localStorage.setItem(`rally:rootExpanded:${rootPath}`, String(v));
    },
    [rootPath],
  );
  const [repoCollapsed, _setRepoCollapsed] = useState(() => {
    const saved = localStorage.getItem(`rally:repoCollapsed:${rootPath}`);
    return saved === "true";
  });
  const setRepoCollapsed = useCallback(
    (v: boolean) => {
      _setRepoCollapsed(v);
      localStorage.setItem(`rally:repoCollapsed:${rootPath}`, String(v));
    },
    [rootPath],
  );
  const [fsEntries, setFsEntries] = useState<FileEntry[]>([]);
  const [fsLoaded, setFsLoaded] = useState(false);

  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const openFile = useWorkspaceStore((s) => s.openFile);
  const openUnifiedGitPanel = useWorkspaceStore((s) => s.openUnifiedGitPanel);
  const removePathFromWorkspace = useWorkspaceStore(
    (s) => s.removePathFromWorkspace,
  );
  const gitStatus = useWorkspaceStore((s) => s.gitStatuses[rootPath]);
  const prStatus = useWorkspaceStore((s) => s.prStatuses[rootPath]);
  const gitPanelActiveForRepo = useWorkspaceStore(
    (s) => s.unifiedGitPanelOpen && s.unifiedGitPanelPath === rootPath,
  );
  const rebaseOnMain = useWorkspaceStore((s) => s.rebaseOnMain);
  const refreshGitStatusForPath = useWorkspaceStore((s) => s.refreshGitStatusForPath);
  const mainBranch = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.paths.includes(rootPath));
    return ws?.main_branch ?? "main";
  });
  const canRemove = true;
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
        fetchGitIgnored(rootPath);
        setFsEntries(r);
        setFsLoaded(true);
      })
      .catch((e) => console.error("Failed to load root:", e));
  }, [rootPath]);

  const editState = useInlineEdit();
  // Only show root-level InlineInput when creating directly in root or in
  // directories that don't exist as loaded FileTreeNodes (scripts/, .claude/commands/).
  // Subfolders that ARE in the tree handle their own InlineInput via isCreatingHere.
  const isCreatingAtRoot =
    editState?.type === "create" &&
    (editState.parentPath === rootPath ||
      (editState.parentPath.startsWith(rootPath + "/") &&
        !fsEntries.some(
          (e) =>
            e.is_dir &&
            (editState.parentPath === e.path ||
              editState.parentPath.startsWith(e.path + "/")),
        )));

  const handleRemoveRootChild = useCallback((path: string) => {
    setFsEntries((prev) => prev.filter((e) => e.path !== path));
  }, []);

  const refreshRootEntries = useCallback(() => {
    invoke<FileEntry[]>("list_directory", { path: rootPath })
      .then((r) => {
        directoryCache.set(rootPath, r);
        fetchGitIgnored(rootPath);
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

  // Listen for filesystem changes (git watcher detected new/deleted files)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ rootPath: string }>).detail;
      if (detail?.rootPath === rootPath) refreshRootEntries();
    };
    document.addEventListener(FS_CHANGED_EVENT, handler);
    return () => document.removeEventListener(FS_CHANGED_EVENT, handler);
  }, [rootPath, refreshRootEntries]);

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    const actions: Parameters<typeof showContextMenu>[0] = [
      {
        label: "New File",
        action: () =>
          setInlineEdit({ type: "create", parentPath: rootPath, isDir: false }),
      },
      {
        label: "New Folder",
        action: () =>
          setInlineEdit({ type: "create", parentPath: rootPath, isDir: true }),
      },
      "separator",
      {
        label: "New Script",
        action: () =>
          setInlineEdit({
            type: "create",
            parentPath: rootPath + "/scripts",
            isDir: false,
            template: "#!/bin/bash\n\n",
          }),
      },
      {
        label: "New Command",
        action: () =>
          setInlineEdit({
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
      "separator",
      {
        label: "New Terminal",
        action: () =>
          activeWorkspaceId &&
          useWorkspaceStore.getState().openTerminalInActiveGroup(activeWorkspaceId, rootPath),
      },
    ];
    if (isGitRepo) {
      actions.push("separator");
      actions.push({
        label: "New Checkout\u2026",
        action: () => setShowCloneModal(true),
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

  const closeUnifiedGitPanel = useWorkspaceStore((s) => s.closeUnifiedGitPanel);
  const handleToggleChanges = useCallback(() => {
    const state = useWorkspaceStore.getState();
    if (state.unifiedGitPanelOpen && state.unifiedGitPanelPath === rootPath) {
      closeUnifiedGitPanel();
      return;
    }
    if (repoCollapsed) setRepoCollapsed(false);
    openUnifiedGitPanel(rootPath);
  }, [
    repoCollapsed,
    setRepoCollapsed,
    openUnifiedGitPanel,
    closeUnifiedGitPanel,
    rootPath,
  ]);

  const [creatingPr, setCreatingPr] = useState(false);
  const refreshPrStatusForPath = useWorkspaceStore(
    (s) => s.refreshPrStatusForPath,
  );
  const handleCreatePr = useCallback(async () => {
    if (creatingPr) return;
    setCreatingPr(true);
    try {
      const url = await api.gitCreatePr(rootPath);
      addToast({ type: "success", title: "PR Created", message: url });
      refreshPrStatusForPath(rootPath);
    } catch (e) {
      addToast({
        type: "warning",
        title: "Create PR failed",
        message: String(e instanceof Error ? e.message : e),
      });
    } finally {
      setCreatingPr(false);
    }
  }, [creatingPr, rootPath, refreshPrStatusForPath]);

  const [syncing, setSyncing] = useState(false);
  const [showCloneModal, setShowCloneModal] = useState(false);
  const [forcePullConfirm, setForcePullConfirm] = useState(false);
  const isOnMain = gitStatus?.branch === mainBranch;
  const handleSyncBehind = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      if (isOnMain) {
        await api.gitPull(rootPath);
        await refreshGitStatusForPath(rootPath, mainBranch);
        addToast({
          type: "success",
          title: "Pulled",
          message: `Updated ${mainBranch} from origin`,
        });
      } else {
        await rebaseOnMain(rootPath, mainBranch);
        addToast({
          type: "success",
          title: "Rebased",
          message: `Rebased onto ${mainBranch}`,
        });
      }
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      if (isOnMain && msg.startsWith("DIVERGED:")) {
        setForcePullConfirm(true);
      } else {
        addToast({
          type: "warning",
          title: isOnMain ? "Pull failed" : "Rebase failed",
          message: msg,
        });
      }
    } finally {
      setSyncing(false);
    }
  }, [syncing, isOnMain, rebaseOnMain, rootPath, mainBranch, refreshGitStatusForPath]);

  const handleForcePull = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await api.gitForcePull(rootPath);
      await refreshGitStatusForPath(rootPath, mainBranch);
      addToast({
        type: "success",
        title: "Force pulled",
        message: `Reset ${gitStatus?.branch ?? mainBranch} to origin`,
      });
    } catch (e) {
      addToast({
        type: "warning",
        title: "Force pull failed",
        message: String(e instanceof Error ? e.message : e),
      });
    } finally {
      setSyncing(false);
      setForcePullConfirm(false);
    }
  }, [syncing, rootPath, mainBranch, gitStatus?.branch, refreshGitStatusForPath]);

  return (
    <>
      <div>
        <div
          style={{
            ...styles.rootRowSticky,
            ...(repoCollapsed
              ? {
                  borderRadius: 6,
                  border: "1px solid #2e2e2e",
                }
              : {}),
          }}
          onMouseDown={(e) => onRootHeaderMouseDown?.(e, rootPath)}
          onContextMenu={handleContextMenu}
        >
          <div style={styles.rootRow}>
            <button
              onClick={(e) => {
                if (shouldSuppressHeaderClick?.()) {
                  e.preventDefault();
                  return;
                }
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
                if (shouldSuppressHeaderClick?.()) {
                  e.preventDefault();
                  return;
                }
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
                    {gitStatus && gitStatus.behind > 0 && (
                      <span
                        style={styles.behindCount}
                        title={`${gitStatus.behind} commit${gitStatus.behind !== 1 ? "s" : ""} behind ${mainBranch}`}
                      >
                        {`\u2212${gitStatus.behind}`}
                      </span>
                    )}
                  </span>
                </div>
              )}
            </div>
            <div style={styles.rootActions}>
              {isGitRepo && (
                <>
                  {gitStatus && gitStatus.behind > 0 && !forcePullConfirm && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSyncBehind();
                      }}
                      disabled={syncing}
                      className="repo-action-btn"
                      style={{
                        ...styles.rebaseBtn,
                        opacity: syncing ? 0.5 : 1,
                      }}
                      title={
                        syncing
                          ? (isOnMain ? "Pulling..." : "Rebasing...")
                          : (isOnMain ? `Pull from origin` : `Rebase onto ${mainBranch}`)
                      }
                    >
                      {isOnMain ? (
                        <svg width="18" height="18" viewBox="0 -960 960 960" fill="#999" style={syncing ? { animation: "spin 1s linear infinite" } : undefined}>
                          <path d="M440-800v487L216-537l-56 57 320 320 320-320-56-57-224 224v-487h-80Z" />
                        </svg>
                      ) : (
                        <svg width="18" height="18" viewBox="60 -880 860 860" fill="#999" style={syncing ? { animation: "spin 1s linear infinite" } : undefined}>
                          <path d="m430-30-56-57 73-73H313q-13 35-43.5 57.5T200-80q-50 0-85-35t-35-85q0-39 22.5-69.5T160-313v-334q-35-13-57.5-43.5T80-760q0-50 35-85t85-35q39 0 69.5 22.5T313-800h134l-73-73 56-57 170 170-170 170-56-57 73-73H313q-9 26-28 45t-45 28v334q26 9 45 28t28 45h134l-73-73 56-57 170 170L430-30Zm245-85q-35-35-35-85 0-40 22.5-70.5T720-313v-334q-35-12-57.5-42.5T640-760q0-50 35-85t85-35q50 0 85 35t35 85q0 40-22.5 70.5T800-647v334q35 13 57.5 43.5T880-200q0 50-35 85t-85 35q-50 0-85-35Zm-475-45q17 0 28.5-11.5T240-200q0-17-11.5-28.5T200-240q-17 0-28.5 11.5T160-200q0 17 11.5 28.5T200-160Zm560 0q17 0 28.5-11.5T800-200q0-17-11.5-28.5T760-240q-17 0-28.5 11.5T720-200q0 17 11.5 28.5T760-160ZM200-720q17 0 28.5-11.5T240-760q0-17-11.5-28.5T200-800q-17 0-28.5 11.5T160-760q0 17 11.5 28.5T200-720Zm560 0q17 0 28.5-11.5T800-760q0-17-11.5-28.5T760-800q-17 0-28.5 11.5T720-760q0 17 11.5 28.5T760-720ZM200-200Zm560 0ZM200-760Zm560 0Z" />
                        </svg>
                      )}
                    </button>
                  )}
                  {forcePullConfirm && (
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 3 }} onClick={(e) => e.stopPropagation()}>
                      <span style={{ fontSize: 10, color: "#e8a838", whiteSpace: "nowrap" }}>Reset to remote?</span>
                      <button
                        onClick={handleForcePull}
                        disabled={syncing}
                        style={{
                          background: "#c53030",
                          border: "none",
                          color: "#fff",
                          fontSize: 10,
                          fontWeight: 600,
                          cursor: syncing ? "default" : "pointer",
                          padding: "1px 6px",
                          borderRadius: 4,
                          opacity: syncing ? 0.5 : 1,
                        }}
                      >
                        Yes
                      </button>
                      <button
                        onClick={() => setForcePullConfirm(false)}
                        style={{
                          background: "transparent",
                          border: "1px solid rgba(255,255,255,0.2)",
                          color: "#ddd",
                          fontSize: 10,
                          cursor: "pointer",
                          padding: "1px 6px",
                          borderRadius: 4,
                        }}
                      >
                        No
                      </button>
                    </div>
                  )}
                  <PrBadge
                    pr={prStatus}
                    onClick={() => openUnifiedGitPanel(rootPath, "pr")}
                  />
                  <GitStatusIcon
                    status={gitStatus}
                    onClick={handleToggleChanges}
                    active={gitPanelActiveForRepo}
                  />
                </>
              )}
            </div>
          </div>
        </div>

        {!repoCollapsed && (
          <div style={{ position: "relative" }}>
            {/* File tree — invisible when panels active, stays in flow to hold card height */}
            <div
              style={showChanges || showPrFiles ? styles.treeHidden : undefined}
            >
              {filesExpanded &&
                isCreatingAtRoot &&
                editState.type === "create" && (
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
                          await api.writeFileContent(
                            newPath,
                            editState.template ?? "",
                          );
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
                <TaskPanel
                  rootPath={rootPath}
                  workspaceId={activeWorkspaceId}
                />
              )}
            </div>
            {/* Changes/PR panels — absolutely positioned over hidden file tree */}
            {showChanges && (
              <div style={styles.panelOverlay}>
                <ChangesPanel
                  rootPath={rootPath}
                  onSelectFile={(filePath, isUntracked, section) =>
                    onSelectChangeFile(rootPath, filePath, isUntracked, section)
                  }
                />
              </div>
            )}
            {showPrFiles && (
              <div style={styles.panelOverlay}>
                <PrFilesPanel
                  rootPath={rootPath}
                  onSelectFile={(filePath) =>
                    onSelectPrFile(rootPath, filePath)
                  }
                />
              </div>
            )}
          </div>
        )}
      </div>
      {showCloneModal && (
        <CloneRepoModal
          sourcePath={rootPath}
          onClose={() => setShowCloneModal(false)}
        />
      )}
    </>
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
/** Dispatched when filesystem changes are detected (via git watcher).
 *  RootSection + FileTreeNode listen for this to re-fetch directory listings. */
const FS_CHANGED_EVENT = "rally:fs-changed";

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
      <span style={styles.changeFileIcon}>
        <FileIcon name={fileName} isDir={false} isOpen={false} />
      </span>
      <span style={styles.changeFileInfo}>
        <span style={styles.changeFileName}>{fileName}</span>
        {dir && <span style={styles.changeFileDir}>{dir}</span>}
      </span>
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
  onSelectFile: (
    filePath: string,
    isUntracked: boolean,
    section?: "staged" | "unstaged" | "untracked",
  ) => void;
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

  function handleSelect(
    path: string,
    isUntracked: boolean,
    section?: "staged" | "unstaged" | "untracked",
  ) {
    setSelectedFile(path);
    onSelectFile(path, isUntracked, section);
  }

  const total = changes
    ? changes.staged.length + changes.unstaged.length + changes.untracked.length
    : 0;

  return (
    <>
      <ScrollArea style={{ flex: 1, padding: "0 4px", paddingBottom: 12 }}>
        {!changes ? null : total === 0 ? (
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
                  onClick={() => handleSelect(f.path, false, "staged")}
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
                  onClick={() => handleSelect(f.path, false, "unstaged")}
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
                  onClick={() => handleSelect(p, true, "untracked")}
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

// --- PR Files Panel (replaces file tree when PR overlay is open) ---

function derivePrFileStatus(file: DiffFile): string {
  if (file.isNew) return "A";
  if (file.isDeleted) return "D";
  if (file.isRenamed) return "R";
  return "M";
}

function PrFilesPanel({
  rootPath,
  onSelectFile,
}: {
  rootPath: string;
  onSelectFile: (filePath: string) => void;
}) {
  const [files, setFiles] = useState<{ path: string; status: string }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .gitPrDiff(rootPath)
      .then((rawDiff) => {
        if (cancelled) return;
        const parsed = parseUnifiedDiff(rawDiff);
        setFiles(
          parsed.map((f) => ({
            path: f.newPath || f.oldPath,
            status: derivePrFileStatus(f),
          })),
        );
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  return (
    <ScrollArea style={{ flex: 1, padding: "0 4px", paddingBottom: 12 }}>
      {loading ? (
        <div style={styles.emptyMsg}>Loading PR files...</div>
      ) : files.length === 0 ? (
        <div style={styles.emptyMsg}>No changed files</div>
      ) : (
        <>
          <div style={styles.sectionHeaderButton as React.CSSProperties}>
            <span style={styles.sectionTitle}>PR Files</span>
            <span style={{ flex: 1 }} />
            <span style={styles.sectionCountBadge}>{files.length}</span>
          </div>
          {files.map((f) => {
            const fileName = f.path.split("/").pop() ?? f.path;
            const dir = f.path.includes("/")
              ? f.path.slice(0, f.path.lastIndexOf("/"))
              : "";
            return (
              <div
                key={f.path}
                className="change-item"
                style={styles.changeItem}
                onClick={() => onSelectFile(f.path)}
              >
                <span style={styles.changeFileIcon}>
                  <FileIcon name={fileName} isDir={false} isOpen={false} />
                </span>
                <span style={styles.changeFileInfo}>
                  <span style={styles.changeFileName}>{fileName}</span>
                  {dir && <span style={styles.changeFileDir}>{dir}</span>}
                </span>
                <span style={styles.statusGlyphWrap}>
                  <ChangeStatusGlyph status={f.status} />
                </span>
              </div>
            );
          })}
        </>
      )}
    </ScrollArea>
  );
}

// --- Layout Presets Dropdown ---

const EMPTY_PRESETS: LayoutPreset[] = [];

function LayoutPresetsDropdown({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const presets = useWorkspaceStore((s) => {
    const arr = s.layoutPresets?.[workspaceId];
    return Array.isArray(arr) ? arr : EMPTY_PRESETS;
  });

  const activePresetId = useWorkspaceStore((s) => s.activePresetId[workspaceId]);
  const activePreset = presets.find((p) => p.id === activePresetId);

  const close = useCallback(() => {
    setOpen(false);
    setSaving(false);
    setName("");
  }, []);

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (dropdownRef.current?.contains(target)) return;
      if (btnRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDismiss = () => close();
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    document.addEventListener("rally:dismiss-popups", onDismiss);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("rally:dismiss-popups", onDismiss);
    };
  }, [open, close]);

  // Auto-focus input when entering save mode
  useEffect(() => {
    if (saving) inputRef.current?.focus();
  }, [saving]);

  const doSaveNew = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    useWorkspaceStore.getState().saveLayoutPreset(workspaceId, trimmed);
    setSaving(false);
    setName("");
  };

  const doSaveCurrent = () => {
    if (!activePresetId) return;
    useWorkspaceStore.getState().updateLayoutPreset(workspaceId, activePresetId);
    close();
  };

  const doRestore = (presetId: string) => {
    useWorkspaceStore.getState().restoreLayoutPreset(workspaceId, presetId);
    close();
  };

  const doDelete = (e: React.MouseEvent, presetId: string) => {
    e.stopPropagation();
    useWorkspaceStore.getState().deleteLayoutPreset(workspaceId, presetId);
  };

  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ top: 0, right: 0, left: -1 });

  const DROPDOWN_MIN_WIDTH = 200;

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (open) { close(); return; }
    // Measure button position for portal placement — prefer right-aligned,
    // but flip to left-aligned if that would push the dropdown off-screen.
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      const rightAligned = window.innerWidth - rect.right;
      // If right-aligning would push the dropdown past the left edge, left-align instead
      if (rect.right - DROPDOWN_MIN_WIDTH < 0) {
        setPos({ top: rect.bottom + 4, right: -1, left: rect.left });
      } else {
        setPos({ top: rect.bottom + 4, right: rightAligned, left: -1 });
      }
    }
    setOpen(true);
    setSaving(false);
    setName("");
  };

  const dropdown = open ? createPortal(
    <div
      ref={dropdownRef}
      style={{
        position: "fixed", top: pos.top,
        ...(pos.right >= 0 ? { right: pos.right } : { left: pos.left }),
        minWidth: DROPDOWN_MIN_WIDTH,
        background: "rgba(36,36,36,0.78)", backdropFilter: "blur(20px) saturate(180%)",
        WebkitBackdropFilter: "blur(20px) saturate(180%)",
        border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, padding: "4px 0",
        zIndex: 10000, boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
      }}
    >
      {/* Saved layouts — click to restore, hover shows X to delete */}
      {presets.map((p) => {
        const isActive = p.id === activePresetId;
        return (
          <div
            key={p.id}
            className="layout-preset-row"
            style={{
              display: "flex", alignItems: "center", padding: "0 6px 0 10px", height: 28, cursor: "pointer", borderRadius: 4, margin: "0 4px",
              borderLeft: isActive ? "2px solid rgba(255,255,255,0.5)" : "2px solid transparent",
            }}
            onClick={() => doRestore(p.id)}
          >
            <span style={{
              flex: 1, fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              color: "#e0e0e0",
            }}>{p.name}</span>
            <button
              className="layout-preset-delete"
              style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, background: "none", border: "none", color: "#e0e0e0", cursor: "pointer", borderRadius: 3, flexShrink: 0, opacity: 0 }}
              onClick={(e) => doDelete(e, p.id)}
              title="Delete layout"
            >
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        );
      })}

      {presets.length > 0 && (
        <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "4px 4px" }} />
      )}

      {/* Save as New Layout (safer action first) */}
      {saving ? (
        <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 6px" }}>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") doSaveNew();
              if (e.key === "Escape") { setSaving(false); setName(""); }
            }}
            placeholder="Layout name..."
            style={{
              flex: 1, background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.15)", borderRadius: 4,
              color: "#e0e0e0", fontSize: 13, fontWeight: 600, padding: "4px 8px", outline: "none",
            }}
          />
          <button
            className="tab-action"
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, background: "none", border: "none", color: "#e0e0e0", cursor: "pointer", borderRadius: 4, flexShrink: 0 }}
            onClick={doSaveNew}
            title="Save"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      ) : (
        <div
          className="layout-preset-row"
          style={{ display: "flex", alignItems: "center", padding: "0 10px", height: 28, cursor: "pointer", borderRadius: 4, margin: "0 4px" }}
          onClick={() => setSaving(true)}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: "#e0e0e0" }}>Save as new layout...</span>
        </div>
      )}

      {/* Update current layout (overwrite) — only if a preset is active */}
      {activePreset && (
        <div
          className="layout-preset-row"
          style={{ display: "flex", alignItems: "center", padding: "0 10px", height: 28, cursor: "pointer", borderRadius: 4, margin: "0 4px" }}
          onClick={doSaveCurrent}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: "#e0e0e0" }}>Update &lsquo;{activePreset.name}&rsquo;</span>
        </div>
      )}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={btnRef}
        className="tab-action"
        style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, background: "none", border: "none", color: "#999", cursor: "pointer", borderRadius: 4 }}
        onClick={handleToggle}
        title="Saved layouts"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="1" y="1" width="6.5" height="14" rx="1" stroke="currentColor" strokeWidth="1.3" />
          <rect x="9" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.3" />
          <rect x="9" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
      {dropdown}
    </>
  );
}

// --- Main FileExplorer ---

interface FileExplorerProps {
  onCollapse: () => void;
  flushLeft?: boolean;
}

export function FileExplorer({ onCollapse, flushLeft }: FileExplorerProps) {
  // Individual selectors — avoids re-rendering on unrelated store changes
  // (git polls, ship polls, task output, etc.)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const addPathToWorkspace = useWorkspaceStore((s) => s.addPathToWorkspace);
  const reorderWorkspacePath = useWorkspaceStore((s) => s.reorderWorkspacePath);
  const openUnifiedGitPanel = useWorkspaceStore((s) => s.openUnifiedGitPanel);
  const workspaceMode = useWorkspaceStore((s) => activeWorkspaceId ? s.workspaceModes[activeWorkspaceId] ?? "dev" : "dev");
  const isProductMode = workspaceMode === "product";
  const unifiedGitPanelOpen = useWorkspaceStore((s) => s.unifiedGitPanelOpen);
  const unifiedGitPanelPath = useWorkspaceStore((s) => s.unifiedGitPanelPath);
  const unifiedGitPanelTab = useWorkspaceStore((s) => s.unifiedGitPanelTab);
  const setActivePathIndex = useWorkspaceStore((s) => s.setActivePathIndex);
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  const [gitRoots, setGitRoots] = useState<Set<string>>(new Set());
  const [draggingRootPath, setDraggingRootPath] = useState<string | null>(null);
  const [dragRootToIndex, setDragRootToIndex] = useState<number | null>(null);
  const [dragRootOffsetY, setDragRootOffsetY] = useState(0);
  const [dragRootItemHeight, setDragRootItemHeight] = useState(0);
  const [dropSettling, setDropSettling] = useState(false);
  const repoCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const suppressRootClickRef = useRef(false);

  const clearRepoDragState = useCallback(() => {
    setDraggingRootPath(null);
    setDragRootToIndex(null);
    setDragRootOffsetY(0);
    setDragRootItemHeight(0);
  }, []);

  // Re-render when expandedPaths are replaced externally (layout preset restore)
  const [, setExpandedTick] = useState(0);
  useEffect(() => {
    const handler = () => setExpandedTick((t) => t + 1);
    document.addEventListener("rally:expanded-paths-changed", handler);
    return () => document.removeEventListener("rally:expanded-paths-changed", handler);
  }, []);

  // Cmd+N → New File: triggered via native menu → Tauri event → DOM event
  useEffect(() => {
    const handler = () => {
      // Determine parent directory: use selected file's parent, or first workspace path
      let parentPath: string | null = null;
      if (selectedFilePath) {
        // If selected item is a directory, create inside it; otherwise use its parent
        const stat = directoryCache.get(selectedFilePath);
        // Check if selectedFilePath is a directory by checking if it has a cache entry
        // or is in the workspace paths list
        const isDir = directoryCache.has(selectedFilePath) ||
          (ws?.paths ?? []).includes(selectedFilePath);
        parentPath = isDir ? selectedFilePath : selectedFilePath.replace(/\/[^/]+$/, "");
      } else if (ws?.paths?.[0]) {
        parentPath = ws.paths[0];
      }
      if (parentPath) {
        setInlineEdit({ type: "create", parentPath, isDir: false });
      }
    };
    document.addEventListener("rally-new-file", handler);
    return () => document.removeEventListener("rally-new-file", handler);
  }, [ws?.paths]);

  // Global Enter-to-rename: when a file is selected in the tree, Enter triggers rename
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.metaKey || e.ctrlKey || e.altKey) return;
      // Don't trigger if focus is in an input, textarea, or contentEditable
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          (active as HTMLElement).isContentEditable)
      )
        return;
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
    const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

    listen<{ rootPath: string }>(BACKEND_GIT_CHANGES_UPDATED_EVENT, (event) => {
      const rootPath = event.payload?.rootPath;
      if (!rootPath) return;
      const existing = refreshTimers.get(rootPath);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        refreshTimers.delete(rootPath);
        if (cancelled) return;
        // Refresh the git changes panel
        document.dispatchEvent(
          new CustomEvent<{ rootPath: string }>(GIT_CHANGES_REFRESH_EVENT, {
            detail: { rootPath },
          }),
        );
        // Invalidate directory cache for expanded paths under this root
        // so the file tree picks up new/deleted files created by Claude Code
        for (const cachedPath of directoryCache.keys()) {
          if (cachedPath === rootPath || cachedPath.startsWith(rootPath + "/")) {
            directoryCache.delete(cachedPath);
          }
        }
        // Notify RootSection + FileTreeNode to re-fetch their listings
        document.dispatchEvent(
          new CustomEvent<{ rootPath: string }>(FS_CHANGED_EVENT, {
            detail: { rootPath },
          }),
        );
      }, 120);
      refreshTimers.set(rootPath, timer);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e) => console.error("Failed to listen for git updates:", e));

    return () => {
      cancelled = true;
      for (const timer of refreshTimers.values()) clearTimeout(timer);
      refreshTimers.clear();
      unlisten?.();
    };
  }, []);

  const handleRepoHeaderMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, rootPath: string) => {
      if (!ws || e.button !== 0) return;
      if ((e.target as HTMLElement).closest("button,input,a")) return;

      const fromIndex = ws.paths.indexOf(rootPath);
      if (fromIndex < 0) return;
      const cardEl = repoCardRefs.current.get(rootPath);
      if (!cardEl) return;
      e.preventDefault();

      const orderedPaths = ws.paths.slice();
      const startX = e.clientX;
      const startY = e.clientY;
      const dragHeight = elementOuterHeight(cardEl);
      let dragging = false;
      let currentDropIndex = fromIndex;

      const onMouseMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;

        if (
          !dragging &&
          (Math.abs(dx) > REPO_DRAG_THRESHOLD ||
            Math.abs(dy) > REPO_DRAG_THRESHOLD)
        ) {
          dragging = true;
          setDraggingRootPath(rootPath);
          setDragRootToIndex(fromIndex);
          setDragRootItemHeight(dragHeight);
        }

        if (!dragging) return;

        ev.preventDefault();
        currentDropIndex = computeRepoInsertIndex(
          orderedPaths,
          rootPath,
          repoCardRefs.current,
          ev.clientY,
        );
        setDragRootOffsetY(dy);
        setDragRootToIndex(currentDropIndex);
      };

      const onWindowBlur = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        window.removeEventListener("blur", onWindowBlur);
        clearRepoDragState();
        suppressRootClickRef.current = false;
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("blur", onWindowBlur);
        if (!dragging) return;

        suppressRootClickRef.current = true;

        // Suppress CSS transitions during the settle frame so the DOM
        // reorder + transform clear don't fight each other and cause bounce.
        setDropSettling(true);

        if (currentDropIndex !== fromIndex) {
          void reorderWorkspacePath(ws.id, rootPath, currentDropIndex).catch(
            (error) => {
              console.error("Failed to reorder repos in explorer:", error);
            },
          );
        }

        clearRepoDragState();

        // Re-enable transitions after the browser has painted the settled layout.
        requestAnimationFrame(() => {
          setDropSettling(false);
          suppressRootClickRef.current = false;
        });
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp, { once: true });
      window.addEventListener("blur", onWindowBlur);
    },
    [ws, reorderWorkspacePath, clearRepoDragState],
  );

  const draggingFromIndex =
    ws && draggingRootPath ? ws.paths.indexOf(draggingRootPath) : -1;

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
    // Toggle the unified git panel's changes tab for this repo
    const state = useWorkspaceStore.getState();
    if (
      state.unifiedGitPanelOpen &&
      state.unifiedGitPanelPath === rootPath &&
      state.unifiedGitPanelTab === "changes"
    ) {
      state.closeUnifiedGitPanel();
    } else {
      state.openUnifiedGitPanel(rootPath, "changes");
    }
  }

  function handleSelectFile(
    rootPath: string,
    filePath: string,
    _isUntracked: boolean,
    section?: "staged" | "unstaged" | "untracked",
  ) {
    // Set the active tab (staged vs unstaged) and scroll-to-file before opening
    const store = useWorkspaceStore.getState();
    if (section === "staged") {
      store.setGitDiffActiveTab("staged");
    } else {
      store.setGitDiffActiveTab("unstaged");
    }
    // Set scroll-to-file so GitDiffContent can pick it up
    useWorkspaceStore.setState({ gitDiffScrollToFile: filePath });
    openUnifiedGitPanel(rootPath, "changes");
  }

  function handleSelectPrFile(rootPath: string, filePath: string) {
    // Set scroll-to-file so PrReviewContent can pick it up, then open PR tab
    useWorkspaceStore.setState({ prReviewScrollToFile: filePath });
    openUnifiedGitPanel(rootPath, "pr");
  }

  return (
    <div className="no-select" style={styles.container}>
      <div style={styles.explorerHeader}>
        <span style={styles.explorerTitle}>Explorer</span>
        <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
          {activeWorkspaceId && !isProductMode && (
            <LayoutPresetsDropdown workspaceId={activeWorkspaceId} />
          )}
          <button
            className="tab-action"
            style={styles.explorerAddBtn}
            onClick={(e) => {
              e.stopPropagation();
              void handleAddFolder();
            }}
            title="Add folder to workspace"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M6 2v8M2 6h8"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </div>
      <ScrollArea
        style={{
          flex: 1,
          padding: "4px 3px",
          paddingLeft: flushLeft ? 7 : undefined,
        }}
        onContextMenu={(e: React.MouseEvent) => {
          // Only show menu when clicking empty space, not on a repo card
          if ((e.target as HTMLElement).closest(".repo-card")) return;
          e.preventDefault();
          showContextMenu([
            {
              label: "Add Folder to Workspace...",
              action: () => void handleAddFolder(),
            },
          ]);
        }}
      >
        {ws.paths.length === 0 && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: "32px 16px",
              gap: 8,
              color: "#666",
              fontSize: 12,
              textAlign: "center",
              userSelect: "none",
            }}
          >
            <span>No folders in this workspace</span>
            <span
              style={{
                color: "#888",
                cursor: "pointer",
                textDecoration: "underline",
                textDecorationColor: "rgba(136,136,136,0.4)",
                textUnderlineOffset: 2,
              }}
              onClick={() => void handleAddFolder()}
            >
              Add a folder
            </span>
          </div>
        )}
        {ws.paths.map((p, index) => {
          const isDraggingCard = p === draggingRootPath;
          let transform: string | undefined;
          if (
            draggingRootPath &&
            dragRootToIndex !== null &&
            draggingFromIndex >= 0
          ) {
            if (isDraggingCard) {
              transform = `translateY(${dragRootOffsetY}px)`;
            } else if (
              draggingFromIndex < dragRootToIndex &&
              index > draggingFromIndex &&
              index <= dragRootToIndex
            ) {
              transform = `translateY(${-dragRootItemHeight}px)`;
            } else if (
              draggingFromIndex > dragRootToIndex &&
              index >= dragRootToIndex &&
              index < draggingFromIndex
            ) {
              transform = `translateY(${dragRootItemHeight}px)`;
            }
          }

          return (
            <div
              key={p}
              className="repo-card"
              ref={(node) => {
                if (node) repoCardRefs.current.set(p, node);
                else repoCardRefs.current.delete(p);
              }}
              style={{
                ...styles.card,
                marginTop: index === 0 ? 0 : 6,
                ...(isDraggingCard ? styles.cardDragging : {}),
                transform,
                transition:
                  isDraggingCard || dropSettling
                    ? "none"
                    : `${REPO_REORDER_TRANSITION}, background-color 120ms`,
                willChange: "transform",
              }}
            >
              <RootSection
                rootPath={p}
                isGitRepo={gitRoots.has(p)}
                showChanges={false}
                showPrFiles={false}
                onToggleChanges={() => handleGitIconClick(p)}
                onSelectChangeFile={handleSelectFile}
                onSelectPrFile={handleSelectPrFile}
                onRootHeaderMouseDown={handleRepoHeaderMouseDown}
                shouldSuppressHeaderClick={() => suppressRootClickRef.current}
              />
            </div>
          );
        })}
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
    position: "relative",
    zIndex: 0,
    background: "#1b1b1b",
    borderRadius: 6,
    border: "1px solid transparent",
    borderBottomColor: "#2e2e2e",
    padding: 0,
    overflow: "hidden",
  },
  cardDragging: {
    zIndex: 120,
    background: "rgba(28, 34, 44, 0.78)",
    boxShadow: "0 18px 40px rgba(0, 0, 0, 0.5)",
    backdropFilter: "blur(20px) saturate(145%)",
    WebkitBackdropFilter: "blur(20px) saturate(145%)",
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
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    padding: "2px 4px",
    background: "none",
    border: "none",
    fontSize: 11,
    fontWeight: 700,
    fontFamily: "'SF Mono', 'Menlo', monospace",
    lineHeight: "16px",
    flexShrink: 0,
    borderRadius: 4,
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
    cursor: "grab",
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
    fontSize: 14,
    fontWeight: 600,
    color: "#eee",
  },
  rootMeta: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  rootBranch: {
    fontSize: 12,
    color: "#bbb",
    fontWeight: 600,
  },
  aheadCount: {
    color: "#e5a63a",
    marginLeft: 4,
    fontSize: 11,
    fontWeight: 600,
  },
  behindCount: {
    color: "#e8b930",
    marginLeft: 4,
    fontSize: 11,
    fontWeight: 600,
  },
  rebaseBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "none",
    border: "none",
    padding: "4px",
    flexShrink: 0,
    borderRadius: 6,
    cursor: "pointer",
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
    gap: 5,
    padding: "7px 8px 4px 6px",
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
    gap: 5,
    padding: "5px 6px 5px 8px",
    margin: "0 2px",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 12,
    color: "#ececec",
    minHeight: 24,
  },
  changeItemSelected: {
    background: "#2d2d2d",
  },
  changeFileIcon: {
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
  },
  changeFileInfo: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  changeFileName: {
    fontWeight: 500,
    color: "#f2f2f2",
  },
  changeFileDir: {
    fontSize: 11,
    color: "#aeb3bb",
    marginLeft: 6,
  },
  changeRight: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    flexShrink: 0,
    marginLeft: 4,
  },
  statusGlyphWrap: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 16,
    marginLeft: 2,
    flexShrink: 0,
  },
  treeHidden: {
    visibility: "hidden" as const,
    pointerEvents: "none" as const,
  },
  panelOverlay: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
    display: "flex",
    flexDirection: "column" as const,
  },
  stageBtn: {
    background: "none",
    border: "none",
    borderRadius: 3,
    color: "#aeb2b8",
    cursor: "pointer",
    width: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    flexShrink: 0,
  },
  cloneModalOverlay: {
    position: "fixed" as const,
    inset: 0,
    zIndex: 9999,
    display: "flex",
    justifyContent: "center",
    background: "transparent",
  },
  cloneModal: {
    position: "absolute" as const,
    top: "24%",
    width: 300,
    maxWidth: "90vw",
    background: "#222222",
    borderRadius: 14,
    border: "0.5px solid rgba(255,255,255,0.08)",
    display: "flex",
    flexDirection: "column" as const,
    overflow: "hidden",
    boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
  },
  cloneModalTopRow: {
    display: "flex",
    alignItems: "center",
    padding: "16px 16px 0 16px",
  },
  cloneModalCloseBtn: {
    background: "none",
    border: "none",
    color: "#888",
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    borderRadius: 6,
  },
  cloneModalBody: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 10,
    padding: "0 16px 16px",
  },
  cloneModalTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: "#fff",
    letterSpacing: "-0.03em",
    lineHeight: "1.2",
    paddingTop: 12,
  },
  cloneModalLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: "#fff",
    letterSpacing: "-0.01em",
  },
  cloneModalInput: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.06)",
    background: "#1e1e1e",
    color: "#e0e0e0",
    fontSize: 13,
    fontFamily: "inherit",
    outline: "none",
    boxSizing: "border-box" as const,
  },
  cloneModalPreview: {
    fontSize: 12,
    color: "#888",
    wordBreak: "break-all" as const,
    marginTop: -4,
  },
  cloneModalError: {
    fontSize: 12,
    color: "#f85149",
    marginTop: -4,
  },
  cloneModalContinueBtn: {
    width: "100%",
    padding: "10px 0",
    borderRadius: 10,
    border: "none",
    background: "#fff",
    color: "#1a1a1a",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    transition: "opacity 150ms",
    letterSpacing: "-0.01em",
  },
};
