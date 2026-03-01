import React, { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { AddWorkspaceModal } from "./AddWorkspaceModal";
import { api } from "../lib/tauri";
import { showContextMenu } from "../lib/contextMenu";

const WORKSPACE_DRAG_THRESHOLD = 4;
const WORKSPACE_DRAG_SCROLL_EDGE = 28;
const WORKSPACE_DRAG_MAX_SCROLL_STEP = 14;
const WORKSPACE_REORDER_TRANSITION = "transform 170ms cubic-bezier(0.2, 0, 0, 1)";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function autoScrollWorkspaceList(listEl: HTMLElement | null, pointerY: number) {
  if (!listEl) return;
  const rect = listEl.getBoundingClientRect();
  if (pointerY < rect.top + WORKSPACE_DRAG_SCROLL_EDGE) {
    const strength =
      (rect.top + WORKSPACE_DRAG_SCROLL_EDGE - pointerY) /
      WORKSPACE_DRAG_SCROLL_EDGE;
    listEl.scrollTop -= Math.ceil(strength * WORKSPACE_DRAG_MAX_SCROLL_STEP);
    return;
  }
  if (pointerY > rect.bottom - WORKSPACE_DRAG_SCROLL_EDGE) {
    const strength =
      (pointerY - (rect.bottom - WORKSPACE_DRAG_SCROLL_EDGE)) /
      WORKSPACE_DRAG_SCROLL_EDGE;
    listEl.scrollTop += Math.ceil(strength * WORKSPACE_DRAG_MAX_SCROLL_STEP);
  }
}

function computeInsertIndex(
  orderedIds: string[],
  draggedId: string,
  itemRefs: Map<string, HTMLDivElement>,
  pointerY: number,
): number {
  if (orderedIds.length <= 1) return 0;
  let insertionIndex = 0;
  for (const id of orderedIds) {
    if (id === draggedId) continue;
    const el = itemRefs.get(id);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (pointerY > rect.top + rect.height / 2) {
      insertionIndex++;
    }
  }
  return clamp(insertionIndex, 0, orderedIds.length - 1);
}

export function Sidebar() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
  const reorderWorkspace = useWorkspaceStore((s) => s.reorderWorkspace);
  const [showAddModal, setShowAddModal] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragToIndex, setDragToIndex] = useState<number | null>(null);
  const [dragOffsetY, setDragOffsetY] = useState(0);
  const [dragItemHeight, setDragItemHeight] = useState(0);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const suppressClickRef = useRef(false);
  const renameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const openAddWorkspace = () => {
      setShowAddModal(true);
    };
    document.addEventListener("rally-open-add-workspace", openAddWorkspace);
    return () => {
      document.removeEventListener("rally-open-add-workspace", openAddWorkspace);
    };
  }, []);

  // Auto-focus and select text when entering rename mode
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const commitRename = useCallback(() => {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== workspaces.find((w) => w.id === renamingId)?.name) {
      renameWorkspace(renamingId, trimmed);
    }
    setRenamingId(null);
  }, [renamingId, renameValue, workspaces, renameWorkspace]);

  const startRename = useCallback((id: string, currentName: string) => {
    setRenamingId(id);
    setRenameValue(currentName);
  }, []);

  const handleListContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest(".sidebar-item")) return;
    e.preventDefault();
    showContextMenu([
      {
        label: "New Workspace...",
        action: () => setShowAddModal(true),
      },
    ]);
  }, []);

  const handleWorkspaceMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, workspaceId: string, isRenaming: boolean) => {
      if (e.button !== 0) return;
      if (renamingId || isRenaming) return;
      if ((e.target as HTMLElement).closest("input,button")) return;

      const fromIndex = workspaces.findIndex((w) => w.id === workspaceId);
      if (fromIndex < 0) return;
      const row = itemRefs.current.get(workspaceId);
      if (!row) return;

      const orderedIds = workspaces.map((w) => w.id);
      const startX = e.clientX;
      const startY = e.clientY;
      const rowHeight = row.getBoundingClientRect().height;
      let dragging = false;
      let currentDropIndex = fromIndex;

      const onMouseMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;

        if (
          !dragging &&
          (Math.abs(dx) > WORKSPACE_DRAG_THRESHOLD ||
            Math.abs(dy) > WORKSPACE_DRAG_THRESHOLD)
        ) {
          dragging = true;
          setDraggingId(workspaceId);
          setDragToIndex(fromIndex);
          setDragItemHeight(rowHeight);
        }

        if (!dragging) return;

        ev.preventDefault();
        autoScrollWorkspaceList(listRef.current, ev.clientY);
        currentDropIndex = computeInsertIndex(
          orderedIds,
          workspaceId,
          itemRefs.current,
          ev.clientY,
        );
        setDragOffsetY(dy);
        setDragToIndex(currentDropIndex);
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        if (!dragging) return;

        suppressClickRef.current = true;
        setDraggingId(null);
        setDragToIndex(null);
        setDragOffsetY(0);
        setDragItemHeight(0);
        if (currentDropIndex !== fromIndex) {
          void reorderWorkspace(workspaceId, currentDropIndex).catch((error) => {
            console.error("Failed to reorder workspaces:", error);
          });
        }
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp, { once: true });
    },
    [workspaces, renamingId, reorderWorkspace],
  );

  const draggingFromIndex =
    draggingId !== null ? workspaces.findIndex((w) => w.id === draggingId) : -1;

  return (
    <>
      <div className="no-select" style={styles.sidebar}>
        <div style={styles.header}>
          <span style={styles.title}>Workspaces</span>
          <button
            className="sidebar-btn"
            style={styles.headerAddBtn}
            onClick={() => setShowAddModal(true)}
            title="Add workspace"
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

        <div
          ref={listRef}
          style={styles.list}
          onContextMenu={handleListContextMenu}
        >
          {workspaces.map((ws, index) => {
            const isActive = ws.id === activeWorkspaceId;
            const isRenaming = renamingId === ws.id;
            const isDraggingRow = ws.id === draggingId;
            let transform: string | undefined;
            if (draggingId && dragToIndex !== null && draggingFromIndex >= 0) {
              if (isDraggingRow) {
                transform = `translateY(${dragOffsetY}px)`;
              } else if (
                draggingFromIndex < dragToIndex &&
                index > draggingFromIndex &&
                index <= dragToIndex
              ) {
                transform = `translateY(${-dragItemHeight}px)`;
              } else if (
                draggingFromIndex > dragToIndex &&
                index >= dragToIndex &&
                index < draggingFromIndex
              ) {
                transform = `translateY(${dragItemHeight}px)`;
              }
            }
            return (
              <div
                key={ws.id}
                ref={(node) => {
                  if (node) itemRefs.current.set(ws.id, node);
                  else itemRefs.current.delete(ws.id);
                }}
                className={`sidebar-item${isActive ? " sidebar-item-active" : ""}`}
                style={{
                  ...styles.item,
                  ...(isActive ? styles.itemActive : {}),
                  ...(isDraggingRow ? styles.itemDragging : {}),
                  transform,
                  transition: isDraggingRow
                    ? "box-shadow 120ms, background-color 120ms"
                    : `${WORKSPACE_REORDER_TRANSITION}, background-color 120ms`,
                  cursor: isRenaming ? "text" : isDraggingRow ? "grabbing" : "pointer",
                }}
                onMouseDown={(e) => handleWorkspaceMouseDown(e, ws.id, isRenaming)}
                onClick={(e) => {
                  if (suppressClickRef.current) return;
                  if (isRenaming) return;
                  if (renameTimerRef.current) {
                    clearTimeout(renameTimerRef.current);
                    renameTimerRef.current = null;
                  }
                  const clickedOnName = (e.target as HTMLElement).closest("[data-ws-name]") !== null;
                  if (isActive && clickedOnName) {
                    renameTimerRef.current = setTimeout(() => {
                      renameTimerRef.current = null;
                      startRename(ws.id, ws.name);
                    }, 350);
                  } else if (!isActive) {
                    setActive(ws.id);
                  }
                }}
                onDoubleClick={() => {
                  // Cancel pending rename on double-click
                  if (renameTimerRef.current) {
                    clearTimeout(renameTimerRef.current);
                    renameTimerRef.current = null;
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  showContextMenu([
                    {
                      label: "Rename",
                      action: () => startRename(ws.id, ws.name),
                    },
                    {
                      label: "Reveal in Finder",
                      action: () => api.revealInFinder(ws.paths[0]),
                    },
                    "separator",
                    {
                      label: "Remove Workspace",
                      action: () => removeWorkspace(ws.id),
                    },
                  ]);
                }}
              >
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    className="rename-input"
                    style={styles.renameInput}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename();
                      } else if (e.key === "Escape") {
                        setRenamingId(null);
                      }
                    }}
                  />
                ) : (
                  <div data-ws-name style={styles.itemName}>{ws.name}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {showAddModal && (
        <AddWorkspaceModal onClose={() => setShowAddModal(false)} />
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  sidebar: {
    background: "var(--bg-app)",
    display: "flex",
    flexDirection: "column",
    paddingTop: 0,
    overflow: "hidden",
    height: "100%",
    userSelect: "none",
    cursor: "default",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 8px 0 12px",
    minHeight: 29,
    maxHeight: 29,
    borderBottom: "1px solid var(--border)",
    flexShrink: 0,
  },
  title: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    color: "var(--text-primary)",
  },
  headerAddBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 22,
    background: "none",
    border: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
    borderRadius: 4,
    padding: 0,
  },
  list: {
    flex: 1,
    overflow: "auto",
    padding: "4px 0",
    minHeight: 0,
    position: "relative",
  },
  item: {
    width: "100%",
    padding: "10px 20px 10px 16px",
    background: "none",
    color: "var(--text-primary)",
    textAlign: "left" as const,
    fontSize: 13,
    position: "relative",
    willChange: "transform",
  },
  itemActive: {
    background: "var(--bg-input)",
    color: "var(--text-primary)",
  },
  itemDragging: {
    zIndex: 4,
    boxShadow: "0 8px 20px var(--shadow)",
    opacity: 0.96,
  },
  itemName: {
    fontWeight: 600,
    display: "inline",
  },
  renameInput: {
    width: "100%",
    background: "var(--bg-elevated)",
    border: "1px solid #007fd4",
    borderRadius: 2,
    color: "var(--text-primary)",
    fontSize: 13,
    fontWeight: 600,
    fontFamily: "inherit",
    padding: "1px 4px",
    margin: 0,
    outline: "none",
    boxSizing: "border-box" as const,
    lineHeight: "inherit",
  },
};
