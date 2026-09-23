import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openWindow } from "./lib/windowUtils";
import { FileExplorer } from "./components/FileExplorer";
import { PaneLayout } from "./components/PaneLayout";
import { FlightCanvas } from "./components/FlightCanvas";
import { lastFocusedFlightPodId } from "./components/FlightPod";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { api, openUrl } from "./lib/tauri";
import { showContextMenu } from "./lib/contextMenu";
import { singleFlight } from "./lib/singleFlight";
import { collectReferencedPtyIds, AUTO_RELEASE_MIN_AGE_S } from "./lib/orphanPtys";
import { AddWorkspaceModal } from "./components/AddWorkspaceModal";
import {
  DEFAULT_BOTTOM_RATIO,
  FLIGHT_DEFAULT_SHELL_HEIGHT,
  findFirstGroupInSubtree,
  findNeighborGroup,
  replaceNode,
  type LayoutNode,
  type NavigationDirection,
  type Pane,
  type PaneGroup,
  type PrStatus,
  type ThemeName,
} from "./lib/types";
import {
  startExternalFileDrag,
  updateDragPosition,
  endDrag,
} from "./lib/dragContext";
import { FILE_DROP_COMMIT_EVENT } from "./components/DropZoneOverlay";
import {
  REQUEST_NEW_TERMINAL_CWD_EVENT,
  type RequestNewTerminalCwdDetail,
} from "./lib/events";
import { ToastContainer, addToast } from "./components/ToastContainer";
import { UnifiedGitPanel } from "./components/UnifiedGitPanel";
import { SearchPanel } from "./components/SearchPanel";
import { ProductChatPanel } from "./components/ProductChatPanel";
import { TaskManagerPanel } from "./components/TaskManagerPanel";
import { RallySettingsPanel } from "./components/RallySettingsPanel";
import { ParkedThreadsPanel } from "./components/ParkedThreadsPanel";
import { AgentSidebar, AgentSidebarToggle } from "./components/AgentSidebar";
import { TaskLauncher } from "./components/TaskLauncher";
import { useAgentStore } from "./stores/agentStore";
import { BuildStatusBar } from "./components/BuildStatusBar";
import { BuildStatusDrawer } from "./components/BuildStatusDrawer";
import QuickOpen from "./components/QuickOpen";
import { syncWindowBackdrop } from "./lib/windowBackdrop";

const WS_DRAG_THRESHOLD = 4;
const WS_DRAG_SCROLL_EDGE = 28;
const WS_DRAG_MAX_SCROLL_STEP = 14;
const WS_REORDER_TRANSITION = "transform 170ms cubic-bezier(0.2, 0, 0, 1)";

function wsClamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function wsAutoScroll(listEl: HTMLElement | null, pointerY: number) {
  if (!listEl) return;
  const r = listEl.getBoundingClientRect();
  if (pointerY < r.top + WS_DRAG_SCROLL_EDGE) {
    const s = (r.top + WS_DRAG_SCROLL_EDGE - pointerY) / WS_DRAG_SCROLL_EDGE;
    listEl.scrollTop -= Math.ceil(s * WS_DRAG_MAX_SCROLL_STEP);
  } else if (pointerY > r.bottom - WS_DRAG_SCROLL_EDGE) {
    const s =
      (pointerY - (r.bottom - WS_DRAG_SCROLL_EDGE)) / WS_DRAG_SCROLL_EDGE;
    listEl.scrollTop += Math.ceil(s * WS_DRAG_MAX_SCROLL_STEP);
  }
}

function wsInsertIndex(
  ids: string[],
  dragId: string,
  refs: Map<string, HTMLDivElement>,
  pointerY: number,
) {
  if (ids.length <= 1) return 0;
  let idx = 0;
  for (const id of ids) {
    if (id === dragId) continue;
    const el = refs.get(id);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (pointerY > r.top + r.height / 2) idx++;
  }
  return wsClamp(idx, 0, ids.length - 1);
}

/** Walk a layout tree and collect all PTY IDs from its pane groups. */
function collectPtyIdsFromLayout(
  layoutKey: string,
  state: ReturnType<typeof useWorkspaceStore.getState>,
  ids: string[],
) {
  const layout = state.layouts[layoutKey];
  if (!layout?.root) return;
  const walk = (node: LayoutNode) => {
    if (node.type === "group") {
      const group = layout.groups[(node as { groupId: string }).groupId];
      if (group) {
        for (const pane of group.panes) {
          if (pane.ptyId) ids.push(pane.ptyId);
        }
      }
    } else if (node.type === "split" && node.children) {
      for (const child of node.children) walk(child);
    }
  };
  walk(layout.root);
}

/** Collect all PTY IDs from a workspace's dev-mode layout and flight pods. */
function collectWorkspacePtyIds(
  workspaceId: string,
  state: ReturnType<typeof useWorkspaceStore.getState>,
): string[] {
  const ids: string[] = [];

  // Dev mode layout
  collectPtyIdsFromLayout(workspaceId, state, ids);

  // Flight pods
  const flightLayout = state.flightLayouts[workspaceId];
  if (flightLayout?.pods) {
    for (const pod of flightLayout.pods) {
      // Pod layout (uses shared layout system with "flight:{podId}" key)
      collectPtyIdsFromLayout(`flight:${pod.id}`, state, ids);
      // Shell tabs
      if ("shellTabs" in pod && pod.shellTabs) {
        for (const tab of pod.shellTabs) {
          if (tab.ptyId) ids.push(tab.ptyId);
        }
      }
      if ("shellPtyId" in pod && pod.shellPtyId) {
        ids.push(pod.shellPtyId);
      }
    }
  }

  return ids;
}

function WorkspacePicker({ onSelect }: { onSelect: (id: string) => void }) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);
  const reorderWorkspace = useWorkspaceStore((s) => s.reorderWorkspace);
  const [showAddModal, setShowAddModal] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Drag reorder state
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragToIndex, setDragToIndex] = useState<number | null>(null);
  const [dragOffsetY, setDragOffsetY] = useState(0);
  const [dragItemHeight, setDragItemHeight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const suppressClickRef = useRef(false);

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const commitRename = useCallback(() => {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    if (
      trimmed &&
      trimmed !== workspaces.find((w) => w.id === renamingId)?.name
    ) {
      renameWorkspace(renamingId, trimmed);
    }
    setRenamingId(null);
  }, [renamingId, renameValue, workspaces, renameWorkspace]);

  const startRename = useCallback((id: string, currentName: string) => {
    setRenamingId(id);
    setRenameValue(currentName);
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, wsId: string) => {
      if (e.button !== 0 || renamingId) return;
      if ((e.target as HTMLElement).closest("input,button")) return;

      const fromIndex = workspaces.findIndex((w) => w.id === wsId);
      if (fromIndex < 0) return;
      const row = itemRefs.current.get(wsId);
      if (!row) return;

      const orderedIds = workspaces.map((w) => w.id);
      const startY = e.clientY;
      const rowHeight = row.getBoundingClientRect().height;
      let dragging = false;
      let dropIndex = fromIndex;

      const onMove = (ev: MouseEvent) => {
        const dy = ev.clientY - startY;
        if (!dragging && Math.abs(dy) > WS_DRAG_THRESHOLD) {
          dragging = true;
          setDraggingId(wsId);
          setDragToIndex(fromIndex);
          setDragItemHeight(rowHeight);
        }
        if (!dragging) return;
        ev.preventDefault();
        wsAutoScroll(listRef.current, ev.clientY);
        dropIndex = wsInsertIndex(
          orderedIds,
          wsId,
          itemRefs.current,
          ev.clientY,
        );
        setDragOffsetY(dy);
        setDragToIndex(dropIndex);
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        if (!dragging) return;
        suppressClickRef.current = true;
        setDraggingId(null);
        setDragToIndex(null);
        setDragOffsetY(0);
        setDragItemHeight(0);
        if (dropIndex !== fromIndex) {
          reorderWorkspace(wsId, dropIndex).catch((err) =>
            console.error("Failed to reorder workspaces:", err),
          );
        }
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp, { once: true });
    },
    [workspaces, renamingId, reorderWorkspace],
  );

  const draggingFromIndex = draggingId
    ? workspaces.findIndex((w) => w.id === draggingId)
    : -1;

  return (
    <>
      <div
        className="no-select"
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          background: "var(--bg-surface)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "8px 8px 8px 12px",
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "var(--text-primary)",
              textTransform: "uppercase" as const,
              letterSpacing: "0.06em",
            }}
          >
            Workspaces
          </span>
          <button
            className="sidebar-btn"
            onClick={() => setShowAddModal(true)}
            title="Add workspace"
            style={{
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
            }}
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
        <div
          ref={listRef}
          style={{ flex: 1, overflow: "auto", position: "relative" }}
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest(".ws-item")) return;
            e.preventDefault();
            showContextMenu([
              {
                label: "New Workspace...",
                action: () => setShowAddModal(true),
              },
            ]);
          }}
        >
          {workspaces.map((ws, index) => {
            const isActive = ws.id === activeWorkspaceId;
            const isRenaming = renamingId === ws.id;
            const isDragging = ws.id === draggingId;

            let transform: string | undefined;
            if (draggingId && dragToIndex !== null && draggingFromIndex >= 0) {
              if (isDragging) {
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
                className={`ws-item sidebar-btn`}
                onMouseDown={(e) => handleMouseDown(e, ws.id)}
                onClick={() => {
                  if (suppressClickRef.current || isRenaming) return;
                  onSelect(ws.id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  showContextMenu([
                    {
                      label: "Open in New Window",
                      action: () => openWindow({ workspaceId: ws.id }),
                    },
                    "separator",
                    {
                      label: "Rename",
                      action: () => startRename(ws.id, ws.name),
                    },
                    "separator",
                    {
                      label: "Remove Workspace",
                      action: () => removeWorkspace(ws.id),
                    },
                  ]);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  padding: "8px 12px",
                  border: "none",
                  background: isActive ? "var(--bg-hover)" : "transparent",
                  color: isActive
                    ? "var(--text-primary)"
                    : "var(--text-secondary)",
                  fontSize: 13,
                  fontWeight: isActive ? 600 : 500,
                  cursor: isRenaming
                    ? "text"
                    : isDragging
                      ? "grabbing"
                      : "pointer",
                  textAlign: "left" as const,
                  position: "relative" as const,
                  willChange: "transform",
                  transform,
                  transition: isDragging
                    ? "box-shadow 120ms, background-color 120ms"
                    : `${WS_REORDER_TRANSITION}, background-color 120ms`,
                  ...(isDragging
                    ? {
                        zIndex: 4,
                        boxShadow: "0 8px 20px var(--shadow)",
                        opacity: 0.96,
                      }
                    : {}),
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  style={{ flexShrink: 0 }}
                >
                  <rect
                    x="1.5"
                    y="3"
                    width="13"
                    height="10"
                    rx="1.5"
                    stroke={
                      isActive ? "var(--text-primary)" : "var(--text-dim)"
                    }
                    strokeWidth="1.0"
                  />
                  <path
                    d="M1.5 5.5h13"
                    stroke={
                      isActive ? "var(--text-primary)" : "var(--text-dim)"
                    }
                    strokeWidth="1.0"
                  />
                </svg>
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    className="rename-input"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename();
                      } else if (e.key === "Escape") setRenamingId(null);
                    }}
                    style={{
                      flex: 1,
                      minWidth: 0,
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
                    }}
                  />
                ) : (
                  ws.name
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

export function App() {
  const windowLabel = getCurrentWindow().label;
  const initialWorkspaceId = new URLSearchParams(window.location.search).get(
    "workspaceId",
  );
  const forceNoWorkspaceSelection =
    new URLSearchParams(window.location.search).get("blankWorkspace") === "1";
  const BACKGROUND_WORK_DEFER_MS = 5000;
  const fileExplorerCollapsedKey = `rally:fileExplorerCollapsed:${windowLabel}`;
  const fileExplorerWidthKey = `rally:fileExplorerWidth:${windowLabel}`;

  // Individual selectors for action functions — prevents App from re-rendering
  // on every store data change (git/PR polls, task output, etc.)
  const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActive);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const addPaneToGroup = useWorkspaceStore((s) => s.addPaneToGroup);
  const refreshAllGitStatuses = useWorkspaceStore(
    (s) => s.refreshAllGitStatuses,
  );
  const refreshGitStatusForPath = useWorkspaceStore(
    (s) => s.refreshGitStatusForPath,
  );
  const refreshAllPrStatuses = useWorkspaceStore((s) => s.refreshAllPrStatuses);
  const autoReleaseIdleShells = useWorkspaceStore((s) => s.autoReleaseIdleShells);
  const refreshPrStatusForPath = useWorkspaceStore(
    (s) => s.refreshPrStatusForPath,
  );
  const fetchAllRepos = useWorkspaceStore((s) => s.fetchAllRepos);
  const activeWorkspaceName = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    return ws?.name ?? "Rally";
  });
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspaceMode = useWorkspaceStore((s) => {
    if (!s.activeWorkspaceId) return "flight";
    return s.workspaceModes[s.activeWorkspaceId] ?? "flight";
  });
  const setWorkspaceMode = useWorkspaceStore((s) => s.setWorkspaceMode);
  const loadRallyConfig = useWorkspaceStore((s) => s.loadRallyConfig);
  const isProductMode = workspaceMode === "product";
  const isFlightMode = workspaceMode === "flight";
  const isDevMode = workspaceMode === "dev";
  const activeRootPath = useWorkspaceStore((s) => {
    return s.activeWorkspaceId
      ? (s.getActivePath(s.activeWorkspaceId) ?? "")
      : "";
  });
  const gitPanelOpen = useWorkspaceStore((s) => s.unifiedGitPanelOpen);
  const openUnifiedGitPanel = useWorkspaceStore((s) => s.openUnifiedGitPanel);

  const [fileExplorerCollapsed, setFileExplorerCollapsed] = useState(
    () => localStorage.getItem(fileExplorerCollapsedKey) === "true",
  );
  // The icon rail (workspaces / files / threads / search / …) is hidden by
  // default — the agents sidebar is the primary navigation. ⌘⇧B shows it.
  const [activityBarVisible, setActivityBarVisible] = useState(
    () => localStorage.getItem("rally:activityBarVisible") === "true",
  );
  useEffect(() => {
    localStorage.setItem("rally:activityBarVisible", String(activityBarVisible));
  }, [activityBarVisible]);
  // Re-check the native frost on launch and on every refocus: Reduce
  // transparency is toggled in System Settings, outside Rally.
  useEffect(() => {
    const sync = () => void syncWindowBackdrop(useWorkspaceStore.getState().theme);
    sync();
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, []);
  // The explorer panel belongs to the rail: hiding the rail hides the open
  // panel too, and showing it brings that panel back.
  const explorerOpenBeforeRailHideRef = useRef(false);
  const toggleToolRail = useCallback(() => {
    if (activityBarVisible) {
      explorerOpenBeforeRailHideRef.current = !fileExplorerCollapsed;
      // A hand-hidden panel must not come back on the next half-screen snap.
      autoCollapsedRef.current = false;
      setFileExplorerCollapsed(true);
      setActivityBarVisible(false);
    } else {
      setActivityBarVisible(true);
      if (explorerOpenBeforeRailHideRef.current) setFileExplorerCollapsed(false);
    }
  }, [activityBarVisible, fileExplorerCollapsed]);
  // Anything that opens the panel (⌘E, ⌘⇧F, menus) shows its rail with it.
  useEffect(() => {
    if (!fileExplorerCollapsed) setActivityBarVisible(true);
  }, [fileExplorerCollapsed]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleToolRail();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [toggleToolRail]);
  const [zoomLevel, setZoomLevel] = useState(() => {
    const saved = localStorage.getItem("rally:zoomLevel");
    return saved ? Number(saved) : 1.0;
  });
  type ExplorerView = "files" | "search" | "rally" | "workspaces" | "tasks" | "threads";
  const explorerViewPerWorkspaceRef = useRef<Map<string, ExplorerView>>(
    new Map(),
  );
  const prevExplorerWsRef = useRef<string | null>(null);
  const [explorerView, setExplorerView] = useState<ExplorerView>("files");

  // Persist explorerView per workspace
  useEffect(() => {
    const wsId = activeWorkspaceId ?? "";
    const prevId = prevExplorerWsRef.current;
    if (prevId && prevId !== wsId) {
      explorerViewPerWorkspaceRef.current.set(prevId, explorerView);
    }
    if (prevId !== wsId) {
      const saved = explorerViewPerWorkspaceRef.current.get(wsId) ?? "files";
      setExplorerView(saved);
      prevExplorerWsRef.current = wsId;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId]);
  // Batch pause/resume PTY monitors on workspace switch — only active workspace
  // terminals need foreground monitoring (pgrep/ps every second).
  useEffect(() => {
    if (!activeWorkspaceId) return;
    const state = useWorkspaceStore.getState();

    // Resume monitors for active workspace
    const activePtyIds = collectWorkspacePtyIds(activeWorkspaceId, state);
    for (const id of activePtyIds) {
      api.resumePtyMonitor(id).catch(() => {});
    }

    // Pause monitors for inactive workspaces
    for (const ws of state.workspaces) {
      if (ws.id === activeWorkspaceId) continue;
      const inactivePtyIds = collectWorkspacePtyIds(ws.id, state);
      for (const id of inactivePtyIds) {
        api.pausePtyMonitor(id).catch(() => {});
      }
    }
  }, [activeWorkspaceId]);

  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const [newTerminalCwdRequest, setNewTerminalCwdRequest] =
    useState<RequestNewTerminalCwdDetail | null>(null);
  const [fileExplorerWidth, setFileExplorerWidth] = useState(() => {
    const saved = localStorage.getItem(fileExplorerWidthKey);
    return saved ? Number(saved) : 220;
  });
  useEffect(() => {
    localStorage.setItem(
      fileExplorerCollapsedKey,
      String(fileExplorerCollapsed),
    );
  }, [fileExplorerCollapsed, fileExplorerCollapsedKey]);

  const resizingRef = useRef(false);
  const lastInteractionAtRef = useRef(Date.now());
  const explorerRef = useRef<HTMLDivElement>(null);
  // The user's preferred explorer width (set by drag resize or initial load).
  // When the window is too narrow we shrink below this, and restore when space returns.
  const preferredExplorerWidthRef = useRef(fileExplorerWidth);

  const [showAddWorkspaceModal, setShowAddWorkspaceModal] = useState(false);

  // Auto-shrink explorer (and collapse sidebar as last resort) to keep main area usable
  const MIN_MAIN_WIDTH = 600;
  const MIN_EXPLORER_WIDTH = 180;
  const ACTIVITY_BAR_WIDTH = 46;
  const RESIZE_HANDLE_WIDTH = 6;
  // Track whether the explorer was auto-collapsed by a snap (so we can auto-restore)
  const autoCollapsedRef = useRef(false);
  // Track previous window width to detect snaps vs manual drags
  const prevWindowWidthRef = useRef(window.innerWidth);
  const SNAP_THRESHOLD = 150; // px — jumps larger than this are snaps, not manual drags
  useEffect(() => {
    const checkWidth = () => {
      if (resizingRef.current) return;
      const w = window.innerWidth;
      const halfScreen = window.screen.width / 2;
      const delta = Math.abs(w - prevWindowWidthRef.current);
      const isSnap = delta >= SNAP_THRESHOLD;
      prevWindowWidthRef.current = w;

      const explorerSpace = fileExplorerCollapsed
        ? 0
        : fileExplorerWidth + RESIZE_HANDLE_WIDTH;
      const mainWidth = w - ACTIVITY_BAR_WIDTH - explorerSpace;

      // Auto-collapse on snap to half screen or narrower (not during manual drag)
      if (isSnap && w <= halfScreen && !fileExplorerCollapsed) {
        autoCollapsedRef.current = true;
        setFileExplorerCollapsed(true);
        return;
      }

      // Auto-restore on snap past half screen (if we auto-collapsed earlier)
      if (
        isSnap &&
        w > halfScreen &&
        fileExplorerCollapsed &&
        autoCollapsedRef.current
      ) {
        autoCollapsedRef.current = false;
        setFileExplorerCollapsed(false);
        return;
      }

      if (mainWidth < MIN_MAIN_WIDTH && !fileExplorerCollapsed) {
        // Shrink explorer to fit
        const available =
          w - ACTIVITY_BAR_WIDTH - RESIZE_HANDLE_WIDTH - MIN_MAIN_WIDTH;
        if (available >= MIN_EXPLORER_WIDTH) {
          setFileExplorerWidth(available);
        } else {
          setFileExplorerWidth(MIN_EXPLORER_WIDTH);
        }
      } else if (
        mainWidth >= MIN_MAIN_WIDTH &&
        fileExplorerWidth < preferredExplorerWidthRef.current &&
        !fileExplorerCollapsed
      ) {
        // Window grew — restore explorer toward preferred width
        const headroom = mainWidth - MIN_MAIN_WIDTH;
        const restored = Math.min(
          preferredExplorerWidthRef.current,
          fileExplorerWidth + headroom,
        );
        setFileExplorerWidth(restored);
      }
    };
    window.addEventListener("resize", checkWidth);
    checkWidth();
    return () => window.removeEventListener("resize", checkWidth);
  }, [fileExplorerCollapsed, fileExplorerWidth]);

  // If this window was launched targeting a workspace, apply it before
  // loadWorkspaces() resolves so the store keeps that selection.
  useEffect(() => {
    if (forceNoWorkspaceSelection) {
      setActiveWorkspace(null);
      return;
    }
    if (initialWorkspaceId) setActiveWorkspace(initialWorkspaceId);
  }, [forceNoWorkspaceSelection, initialWorkspaceId, setActiveWorkspace]);

  useEffect(() => {
    const markInteraction = () => {
      lastInteractionAtRef.current = Date.now();
    };
    document.addEventListener("pointerdown", markInteraction, {
      passive: true,
    });
    document.addEventListener("keydown", markInteraction, {
      passive: true,
      capture: true,
    });
    document.addEventListener("wheel", markInteraction, { passive: true });
    document.addEventListener("scroll", markInteraction, {
      passive: true,
      capture: true,
    });
    return () => {
      document.removeEventListener("pointerdown", markInteraction);
      document.removeEventListener("keydown", markInteraction, true);
      document.removeEventListener("wheel", markInteraction);
      document.removeEventListener("scroll", markInteraction, true);
    };
  }, []);

  const shouldDeferBackgroundWork = useCallback(() => {
    if (document.hidden) return true;
    return Date.now() - lastInteractionAtRef.current < BACKGROUND_WORK_DEFER_MS;
  }, [BACKGROUND_WORK_DEFER_MS]);

  // Poll cycles run behind singleFlight so a hung Tauri invoke can never
  // permanently latch the in-flight guard and kill polling until app restart
  // (this happened: one startup git_pr_status invoke that never settled
  // silently disabled all PR badge refreshes). The deadline must exceed the
  // worst honest cycle: gh calls are capped at 60s in Rust, run per-repo.
  const POLL_STALE_MS = 120000;

  const runGitRefresh = useMemo(
    () =>
      singleFlight("git status refresh", POLL_STALE_MS, async (force = false) => {
        if (!force && shouldDeferBackgroundWork()) return;
        await refreshAllGitStatuses();
      }),
    [refreshAllGitStatuses, shouldDeferBackgroundWork, POLL_STALE_MS],
  );

  const runPrRefresh = useMemo(
    () =>
      // PR refresh is lightweight (one `gh pr view` per repo). Don't defer
      // on user interaction — stale PR state is exactly the bug we're
      // preventing. Only skip if tab is hidden unless forced.
      singleFlight("PR status refresh", POLL_STALE_MS, async (force = false) => {
        if (!force && document.hidden) return;
        await refreshAllPrStatuses();
      }),
    [refreshAllPrStatuses, POLL_STALE_MS],
  );

  const runFetchAll = useMemo(
    () =>
      singleFlight("repo fetch", POLL_STALE_MS, async () => {
        if (shouldDeferBackgroundWork()) return;
        await fetchAllRepos();
      }),
    [fetchAllRepos, shouldDeferBackgroundWork, POLL_STALE_MS],
  );

  useEffect(() => {
    let cancelled = false;

    // Kill all orphaned PTYs from a previous session. On reload/restart the
    // frontend loses all xterm state and event listeners, so existing PTYs
    // can never be reconnected — they'd leak as zombie processes.
    // ONLY do this for the main window — secondary windows (opened via "Open
    // in New Window" with workspaceId or blankWorkspace params) must NOT kill
    // PTYs that belong to the primary window or other windows.
    const isSecondaryWindow = !!initialWorkspaceId || forceNoWorkspaceSelection;
    if (!isSecondaryWindow) {
      api
        .killAllPtys()
        .catch((e: unknown) => console.error("Failed to kill orphaned PTYs:", e));
    }

    // Read minimal-mode flag via ref so interval handlers always see the
    // latest value without tearing down the effect on toggle.
    const isMinimal = () => useWorkspaceStore.getState().gitMinimalMode;

    loadWorkspaces({ keepNullActive: forceNoWorkspaceSelection }).then(
      async () => {
        if (cancelled) return;
        if (isMinimal()) {
          await Promise.all([
            useWorkspaceStore.getState().refreshAllBranches(),
            runPrRefresh(true),
          ]);
        } else {
          await Promise.all([runGitRefresh(true), runPrRefresh(true)]);
        }
      },
    );

    // Scale polling intervals with workspace count to avoid IPC flood
    const pathCount = useWorkspaceStore
      .getState()
      .workspaces.reduce((n, ws) => n + ws.paths.length, 0);
    const gitMs = pathCount > 6 ? 20000 : 10000;
    const fetchMs = pathCount > 6 ? 120000 : 60000;
    const branchMs = 30000;

    // Full git status + fetch only run when minimal mode is OFF.
    const gitInterval = setInterval(() => {
      if (isMinimal()) return;
      void runGitRefresh();
    }, gitMs);
    const prInterval = setInterval(() => {
      void runPrRefresh();
    }, 30000);
    const fetchInterval = setInterval(() => {
      if (isMinimal()) return;
      void runFetchAll();
    }, fetchMs);
    // Branch-only poll always runs but only performs work when minimal
    // mode is ON (full git status already supplies branch otherwise).
    const branchInterval = setInterval(() => {
      if (!isMinimal()) return;
      void useWorkspaceStore.getState().refreshAllBranches();
    }, branchMs);

    return () => {
      cancelled = true;
      clearInterval(gitInterval);
      clearInterval(prInterval);
      clearInterval(fetchInterval);
      clearInterval(branchInterval);
    };
  }, [
    loadWorkspaces,
    runGitRefresh,
    runPrRefresh,
    runFetchAll,
    forceNoWorkspaceSelection,
  ]);

  // Refresh PR status when switching workspaces so PR badges appear immediately
  useEffect(() => {
    if (!activeWorkspaceId) return;
    const ws = workspaces.find((w) => w.id === activeWorkspaceId);
    if (!ws) return;
    for (const path of ws.paths) {
      refreshPrStatusForPath(path).catch(() => {});
    }
  }, [activeWorkspaceId, workspaces, refreshPrStatusForPath]);

  // Auto-release idle shells every 10 minutes when enabled.
  // Same logic the Process Manager panel uses, but runs in the background
  // so the panel doesn't have to be open. Skips PTYs younger than
  // AUTO_RELEASE_MIN_AGE_S so we don't kill shells mid-spawn.
  //
  // Window-scoped: only sweeps PTYs spawned by THIS window. The Zustand
  // store is per-window, so we can't see references from other Rally
  // windows — without the scope check we'd treat their PTYs as orphans
  // and kill live Claude sessions in those windows.
  useEffect(() => {
    if (!autoReleaseIdleShells) return;
    let cancelled = false;
    const myWindowLabel = (() => {
      try { return getCurrentWindow().label; } catch { return null; }
    })();

    const sweep = async () => {
      try {
        const inv = await api.getProcessInventory();
        if (cancelled) return;
        const s = useWorkspaceStore.getState();
        const referenced = collectReferencedPtyIds({
          workspaces: s.workspaces,
          layouts: s.layouts,
          flightLayouts: s.flightLayouts,
          scriptRuns: s.scriptRuns,
          shellPanels: s.shellPanels,
        });
        const ids = inv.ptys
          .filter((p) =>
            // Only sweep PTYs owned by this window. PTYs with an unknown
            // owner (pre-fix backend, or future spawn without label) are
            // skipped to avoid stomping on another window's session.
            p.window_label != null &&
            p.window_label === myWindowLabel &&
            !referenced.has(p.id) &&
            p.uptime_s >= AUTO_RELEASE_MIN_AGE_S
          )
          .map((p) => p.id);
        if (ids.length === 0) return;
        await api.killPtys(ids);
      } catch (err) {
        console.warn("[rally] auto-release sweep failed:", err);
      }
    };

    const id = setInterval(() => { void sweep(); }, 10 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [autoReleaseIdleShells]);

  // Force a PR refresh when the window regains focus or the tab becomes
  // visible again. Covers "came back from browser after creating a PR".
  useEffect(() => {
    const onFocus = () => { void runPrRefresh(true); };
    const onVisible = () => {
      if (!document.hidden) void runPrRefresh(true);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [runPrRefresh]);

  // Load RALLY.json config when active workspace changes — sets mode from config
  useEffect(() => {
    if (!activeWorkspaceId) return;
    const ws = workspaces.find((w) => w.id === activeWorkspaceId);
    if (!ws || ws.paths.length === 0) return;
    const rootPath = ws.paths[0];
    loadRallyConfig(rootPath).then(() => {
      const s = useWorkspaceStore.getState();
      const config = s.rallyConfigs[rootPath];
      // Only auto-set mode from config if the user hasn't explicitly chosen one
      if (config?.mode && !s.workspaceModes[activeWorkspaceId]) {
        const mode =
          config.mode === "product" ? ("product" as const) : config.mode === "dev" ? ("dev" as const) : ("flight" as const);
        s.setWorkspaceMode(activeWorkspaceId, mode);
      }
    });
  }, [activeWorkspaceId, workspaces, loadRallyConfig]);

  // Agent status polling: Claude session files every 2s while the window
  // is visible (cheap: one `ps` + a few small JSON reads), checkout health
  // for the active workspace's repos every 20s and after git changes.
  useEffect(() => {
    const agent = useAgentStore.getState();
    const tickSessions = () => {
      if (document.visibilityState !== "visible") return;
      void agent.refreshSessions();
    };
    tickSessions();
    const sessionsTimer = setInterval(tickSessions, 2000);
    return () => clearInterval(sessionsTimer);
  }, []);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    const ws = workspaces.find((w) => w.id === activeWorkspaceId);
    if (!ws) return;
    const mainBranch = ws.main_branch || "main";
    const paths = ws.paths;
    const refreshAll = singleFlight("checkout-health", 30000, async () => {
      if (document.visibilityState !== "visible") return;
      const agent = useAgentStore.getState();
      await Promise.all(paths.map((p) => agent.refreshHealth(p, mainBranch)));
    });
    void refreshAll();
    const timer = setInterval(() => void refreshAll(), 20000);
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    listen<{ rootPath: string }>("git-changes-updated", (event) => {
      if (cancelled) return;
      if (!paths.includes(event.payload.rootPath)) return;
      void useAgentStore.getState().refreshHealth(event.payload.rootPath, mainBranch);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      clearInterval(timer);
      unlisten?.();
    };
  }, [activeWorkspaceId, workspaces]);

  // Auto-switch explorer view when mode changes

  // Event-driven git status refresh — file watcher emits "git-changes-updated"
  // with ~700ms debounce. Immediately refresh git status for the affected repo
  // instead of waiting for the 10s poll.
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

    listen<{ rootPath: string }>("git-changes-updated", (event) => {
      if (cancelled) return;
      // Skip status refresh when minimal mode is on — the full git_status
      // scan is precisely what we're trying to avoid.
      if (useWorkspaceStore.getState().gitMinimalMode) return;
      const rootPath = event.payload?.rootPath;
      if (!rootPath) return;
      const existing = refreshTimers.get(rootPath);
      if (existing) clearTimeout(existing);
      const delay = shouldDeferBackgroundWork() ? 500 : 120;
      const timer = setTimeout(() => {
        refreshTimers.delete(rootPath);
        if (cancelled) return;
        const ws = useWorkspaceStore
          .getState()
          .workspaces.find((w) => w.paths.includes(rootPath));
        if (ws) {
          void refreshGitStatusForPath(rootPath, ws.main_branch);
          loadRallyConfig(rootPath);
        }
      }, delay);
      refreshTimers.set(rootPath, timer);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e) =>
        console.error("Failed to listen for git-changes-updated:", e),
      );

    return () => {
      cancelled = true;
      for (const timer of refreshTimers.values()) clearTimeout(timer);
      refreshTimers.clear();
      unlisten?.();
    };
  }, [refreshGitStatusForPath, shouldDeferBackgroundWork, loadRallyConfig]);

  // Keep git file watcher roots in sync with workspace paths.
  // Must live here (not in FileExplorer) because the explorer can be unmounted
  // when collapsed, which would leave the watcher unregistered.
  // In minimal git mode the watcher is unregistered entirely — the main cost
  // of status polling is the per-file-change refresh it triggers.
  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId);
  const activeWsPaths = activeWs?.paths;
  const gitMinimalMode = useWorkspaceStore((s) => s.gitMinimalMode);
  useEffect(() => {
    const roots = gitMinimalMode ? [] : (activeWsPaths ?? []);
    api.updateGitWatchRoots(roots).catch((e) => {
      console.error("Failed to update git watch roots:", e);
    });
  }, [activeWsPaths, gitMinimalMode]);

  // When minimal mode toggles on, refresh branches immediately so Claude
  // panels show the right branch without waiting 30s. When it toggles off,
  // pull a full status snapshot immediately.
  useEffect(() => {
    const s = useWorkspaceStore.getState();
    if (gitMinimalMode) {
      void s.refreshAllBranches();
    } else {
      void s.refreshAllGitStatuses();
    }
  }, [gitMinimalMode]);

  // Native File menu actions (always handled here so they work even when
  // sidebar/explorer panels are collapsed).
  useEffect(() => {
    let cancelled = false;
    let unlistenNewFile: UnlistenFn | null = null;
    let unlistenNewWorkspace: UnlistenFn | null = null;
    let unlistenAddFolder: UnlistenFn | null = null;
    let unlistenNewClaude: UnlistenFn | null = null;
    let unlistenNewWindow: UnlistenFn | null = null;
    let unlistenOpenCurrentInNewWindow: UnlistenFn | null = null;
    let unlistenWorkspacesUpdated: UnlistenFn | null = null;

    listen("rally-menu-new-file", () => {
      // Ensure file explorer is visible
      setFileExplorerCollapsed(false);
      setExplorerView("files");
      // Dispatch a DOM event that FileExplorer listens for
      document.dispatchEvent(new Event("rally-new-file"));
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenNewFile = fn;
      })
      .catch((e) =>
        console.error("Failed to listen for new-file menu event:", e),
      );

    listen("rally-menu-new-workspace", () => {
      requestAnimationFrame(() => {
        setShowAddWorkspaceModal(true);
      });
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenNewWorkspace = fn;
      })
      .catch((e) =>
        console.error("Failed to listen for new-workspace menu event:", e),
      );

    listen("rally-menu-add-folder", async () => {
      const s = useWorkspaceStore.getState();
      const wsId = s.activeWorkspaceId;
      const ws = s.workspaces.find((w) => w.id === wsId);
      if (!ws) {
        addToast({
          type: "warning",
          title: "No workspace selected",
          message: "Create or select a workspace first.",
        });
        return;
      }

      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        await s.addPathToWorkspace(ws.id, selected);
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenAddFolder = fn;
      })
      .catch((e) =>
        console.error("Failed to listen for add-folder menu event:", e),
      );

    listen("rally-menu-new-claude", () => {
      const s = useWorkspaceStore.getState();
      const wsId = s.activeWorkspaceId;
      if (!wsId) return;
      const layout = s.getOrCreateLayout(wsId);
      let groupId: string | undefined = s.activeGroupIds[wsId];
      if (!groupId || !layout.groups[groupId]) {
        groupId = findFirstGroupInSubtree(layout.root) ?? undefined;
      }
      if (!groupId) return;
      const group = layout.groups[groupId];
      const activePane = group?.panes.find((p) => p.id === group.activePaneId);
      const cwd = activePane?.cwd || s.getActivePath(wsId) || undefined;
      const pane: Pane = {
        id: crypto.randomUUID(),
        type: "claude",
        title: "Claude Code",
        command: "claude --dangerously-skip-permissions",
        cwd,
      };
      s.addPaneToGroup(wsId, groupId, pane);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenNewClaude = fn;
      })
      .catch((e) =>
        console.error("Failed to listen for new-claude menu event:", e),
      );

    listen("rally-menu-new-window", () => {
      openWindow({ blankWorkspace: true });
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenNewWindow = fn;
      })
      .catch((e) =>
        console.error("Failed to listen for new-window menu event:", e),
      );

    listen("rally-menu-open-current-workspace-new-window", () => {
      const s = useWorkspaceStore.getState();
      if (!s.activeWorkspaceId) {
        addToast({
          type: "warning",
          title: "No workspace selected",
          message: "Select a workspace first.",
        });
        return;
      }
      openWindow({ workspaceId: s.activeWorkspaceId });
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenOpenCurrentInNewWindow = fn;
      })
      .catch((e) =>
        console.error(
          "Failed to listen for open-current-workspace-new-window menu event:",
          e,
        ),
      );

    let unlistenFlightMode: UnlistenFn | undefined;
    let unlistenDevMode: UnlistenFn | undefined;
    let unlistenRefreshPrs: UnlistenFn | undefined;
    listen("rally-menu-flight-mode", () => {
      const s = useWorkspaceStore.getState();
      const wsId = s.activeWorkspaceId;
      if (wsId) s.setWorkspaceMode(wsId, "flight");
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenFlightMode = fn;
      })
      .catch(() => {});
    listen("rally-menu-dev-mode", () => {
      const s = useWorkspaceStore.getState();
      const wsId = s.activeWorkspaceId;
      if (wsId) s.setWorkspaceMode(wsId, "dev");
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenDevMode = fn;
      })
      .catch(() => {});

    listen("rally-menu-refresh-prs", () => {
      void runPrRefresh(true);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenRefreshPrs = fn;
      })
      .catch(() => {});

    listen("rally-workspaces-updated", () => {
      void loadWorkspaces({ keepNullActive: forceNoWorkspaceSelection });
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenWorkspacesUpdated = fn;
      })
      .catch((e) =>
        console.error("Failed to listen for workspaces-updated event:", e),
      );

    return () => {
      cancelled = true;
      unlistenNewFile?.();
      unlistenNewWorkspace?.();
      unlistenAddFolder?.();
      unlistenNewClaude?.();
      unlistenNewWindow?.();
      unlistenOpenCurrentInNewWindow?.();
      unlistenFlightMode?.();
      unlistenDevMode?.();
      unlistenRefreshPrs?.();
      unlistenWorkspacesUpdated?.();
    };
  }, [loadWorkspaces, forceNoWorkspaceSelection, runPrRefresh]);

  // CLI: open files sent from `rally <file>` command
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    listen<string>("rally-cli-open-file", (event) => {
      const s = useWorkspaceStore.getState();
      const wsId = s.activeWorkspaceId;
      if (!wsId) return;
      s.openFile(wsId, event.payload, { skipReveal: true });
      // Blur the terminal so the new editor pane becomes the focused group.
      // Without this, xterm keeps DOM focus and Cmd+W closes the terminal instead.
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e) =>
        console.error("Failed to listen for cli-open-file event:", e),
      );

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);


  // Finder drag-and-drop: bridge Tauri file drop events into the drag context
  // so each PaneGroup's DropZoneTarget shows the same overlay as tab drags.
  useEffect(() => {
    const appWin = getCurrentWindow();
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    const dpr = window.devicePixelRatio || 1;

    // Tauri's DragDropEvent position may be in physical or logical pixels
    // depending on platform/version. We auto-detect on the first "enter"
    // event by checking if raw coords exceed viewport logical dimensions.
    let coordScale = dpr; // default: assume physical, will auto-detect

    function toLogical(rawX: number, rawY: number): { x: number; y: number } {
      return { x: rawX / coordScale, y: rawY / coordScale };
    }

    appWin
      .onDragDropEvent((event) => {
        if (cancelled) return;
        const { activeWorkspaceId } = useWorkspaceStore.getState();
        if (!activeWorkspaceId) return;

        const { type } = event.payload;
        if (type === "enter") {
          // Auto-detect coordinate system: if raw position exceeds
          // viewport logical dimensions, it's physical and needs DPR scaling.
          const rawX = event.payload.position.x;
          const rawY = event.payload.position.y;
          const exceedsLogical =
            rawX > window.innerWidth * 1.15 || rawY > window.innerHeight * 1.15;
          coordScale = exceedsLogical ? dpr : 1;
          const { x, y } = toLogical(rawX, rawY);
          startExternalFileDrag(event.payload.paths, x, y);
        } else if (type === "over") {
          const { x, y } = toLogical(
            event.payload.position.x,
            event.payload.position.y,
          );
          updateDragPosition(x, y);
        } else if (type === "drop") {
          const { x, y } = toLogical(
            event.payload.position.x,
            event.payload.position.y,
          );
          updateDragPosition(x, y);

          // Check if we're dropping onto a terminal — if so, write paths
          // directly into the PTY and skip the DropZone system entirely.
          // Use raw physical coords and compare against group rects in physical
          // space to avoid DPR rounding issues with elementFromPoint.
          const filePaths = event.payload.paths;
          if (filePaths.length > 0) {
            const groupEls =
              document.querySelectorAll<HTMLElement>("[data-group-id]");
            let bestGroup: HTMLElement | null = null;
            let bestArea = Infinity;
            for (const el of groupEls) {
              const rect = el.getBoundingClientRect();
              if (
                x >= rect.left &&
                x <= rect.right &&
                y >= rect.top &&
                y <= rect.bottom
              ) {
                // Pick the smallest matching group (most specific)
                const area = rect.width * rect.height;
                if (area < bestArea) {
                  bestArea = area;
                  bestGroup = el;
                }
              }
            }
            if (bestGroup) {
              const gid = bestGroup.getAttribute("data-group-id")!;
              const s = useWorkspaceStore.getState();
              const wsId = s.activeWorkspaceId;
              if (wsId) {
                const grp = s.layouts[wsId]?.groups[gid];
                const activePane = grp?.panes.find(
                  (p) => p.id === grp.activePaneId,
                );
                if (
                  activePane?.ptyId &&
                  (activePane.type === "terminal" ||
                    activePane.type === "claude")
                ) {
                  const escaped = filePaths
                    .map((p: string) => (p.includes(" ") ? `'${p}'` : p))
                    .join(" ");
                  api.writePty(
                    activePane.ptyId,
                    Array.from(new TextEncoder().encode(escaped)),
                  );
                  endDrag();
                  return;
                }
              }
            }
          }

          // Dispatch custom event so DropZoneTargets can commit the file drop
          document.dispatchEvent(new Event(FILE_DROP_COMMIT_EVENT));
          setTimeout(() => endDrag(), 0);
        } else if (type === "leave") {
          endDrag();
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Zoom management — Cmd+=/Cmd+-/Cmd+0 via native View menu.
  // Uses CSS zoom on the body container (not webview.setZoom) so the
  // titlebar stays at native size.
  useEffect(() => {
    const ZOOM_KEY = "rally:zoomLevel";
    const ZOOM_MIN = 0.5;
    const ZOOM_MAX = 2.0;
    const ZOOM_STEP = 0.1;

    const getZoom = (): number => {
      const saved = localStorage.getItem(ZOOM_KEY);
      return saved ? Number(saved) : 1.0;
    };

    const doZoom = (level: number) => {
      const clamped =
        Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level)) * 10) / 10;
      localStorage.setItem(ZOOM_KEY, String(clamped));
      setZoomLevel(clamped);
    };

    let cancelled = false;
    let unlistenIn: UnlistenFn | null = null;
    let unlistenOut: UnlistenFn | null = null;
    let unlistenReset: UnlistenFn | null = null;

    listen("rally-zoom-in", () => {
      if (cancelled) return;
      doZoom(getZoom() + ZOOM_STEP);
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenIn = fn;
    });

    listen("rally-zoom-out", () => {
      if (cancelled) return;
      doZoom(getZoom() - ZOOM_STEP);
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenOut = fn;
    });

    listen("rally-zoom-reset", () => {
      if (cancelled) return;
      doZoom(1.0);
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenReset = fn;
    });

    // Sync zoom across windows via storage events
    const onStorage = (e: StorageEvent) => {
      if (e.key === ZOOM_KEY && e.newValue) {
        setZoomLevel(Number(e.newValue));
      }
    };
    window.addEventListener("storage", onStorage);

    return () => {
      cancelled = true;
      unlistenIn?.();
      unlistenOut?.();
      unlistenReset?.();
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // Cmd+W closes the active tab instead of the window
  // Cmd+/ splits the active panel to the right with a new terminal
  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "w") {
        e.preventDefault();
        const s = useWorkspaceStore.getState();
        const wsId = s.activeWorkspaceId;
        if (!wsId) return;
        const layout = s.layouts[wsId];
        const activeGroupId = s.activeGroupIds[wsId];
        if (!layout || !activeGroupId) return;
        const group = layout.groups[activeGroupId];
        if (!group) return;
        const pane = group.panes.find((p) => p.id === group.activePaneId);
        if (
          pane?.ptyId &&
          (pane.type === "claude" || pane.type === "terminal")
        ) {
          const { ask } = await import("@tauri-apps/plugin-dialog");
          const confirmed = await ask("Close this terminal session?", {
            title: "Close Terminal",
            kind: "warning",
            okLabel: "Close",
            cancelLabel: "Cancel",
          });
          if (!confirmed) return;
        }
        useWorkspaceStore.getState().closeActiveTab(wsId);
      }
      // Ctrl+` toggles the bottom panel
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        const s = useWorkspaceStore.getState();
        const wsId = s.activeWorkspaceId;
        if (!wsId) return;

        const mode = s.workspaceModes[wsId] ?? "flight";

        // In Flight Mode: toggle shell on the focused pod
        if (mode === "flight") {
          const flightLayout = s.flightLayouts[wsId];
          if (!flightLayout) return;
          const claudePods = flightLayout.pods.filter((p) => p.type === "claude");
          if (claudePods.length === 0) return;

          // Find the pod the user last interacted with
          let focusedPod = claudePods[0];
          // 1st: check lastFocusedFlightPodId (set on mousedown inside any pod)
          if (lastFocusedFlightPodId) {
            const match = claudePods.find((p) => p.id === lastFocusedFlightPodId);
            if (match) focusedPod = match;
          }
          // 2nd: check activeElement (covers keyboard focus in xterm)
          if (!lastFocusedFlightPodId || !claudePods.find((p) => p.id === lastFocusedFlightPodId)) {
            const activeEl = document.activeElement;
            if (activeEl) {
              const podEl = activeEl.closest("[data-flight-pod]");
              if (podEl) {
                const podId = podEl.getAttribute("data-flight-pod");
                const match = claudePods.find((p) => p.id === podId);
                if (match) focusedPod = match;
              }
            }
          }

          if (!focusedPod.shellExpanded) {
            // Collapsed → expand to default height
            s.togglePodShell(wsId, focusedPod.id);
            // Focus the shell terminal after it becomes visible
            setTimeout(() => {
              const podEl = document.querySelector(`[data-flight-pod="${focusedPod.id}"]`);
              if (podEl) {
                const shellArea = podEl.querySelector("[data-shell-area] textarea, [data-shell-area] .xterm-helper-textarea");
                if (shellArea) (shellArea as HTMLElement).focus();
              }
            }, 50);
          } else if (focusedPod.shellHeight > FLIGHT_DEFAULT_SHELL_HEIGHT + 10) {
            // Bigger than default → snap to default
            s.updateFlightPod(wsId, focusedPod.id, { shellHeight: FLIGHT_DEFAULT_SHELL_HEIGHT } as any);
          } else {
            // At default → collapse
            s.togglePodShell(wsId, focusedPod.id);
          }
          return;
        }

        // In product mode, toggle the shell panel
        if (mode === "product") {
          const rootPath = s.getActivePath(wsId);
          if (rootPath) {
            s.toggleShellPanel(wsId, rootPath);
          }
          return;
        }

        let layout = s.getOrCreateLayout(wsId);
        const root = layout.root;

        // When root is a single group, create a vertical split with a bottom terminal
        if (root.type === "group") {
          const groupId = root.groupId;
          const group = layout.groups[groupId];
          const activePane = group?.panes.find(
            (p) => p.id === group.activePaneId,
          );
          const cwd = activePane?.cwd || s.getActivePath(wsId) || undefined;

          const newPane: Pane = {
            id: crypto.randomUUID(),
            type: "terminal",
            title: "Terminal",
            ...(cwd ? { cwd } : {}),
          };
          const newGroupId = crypto.randomUUID();
          const newGroup = {
            id: newGroupId,
            panes: [newPane],
            activePaneId: newPane.id,
          };
          const splitNode: LayoutNode = {
            type: "split",
            id: crypto.randomUUID(),
            direction: "vertical",
            children: [
              { type: "group", groupId },
              { type: "group", groupId: newGroupId },
            ],
            ratio: DEFAULT_BOTTOM_RATIO,
          };

          useWorkspaceStore.setState({
            activeGroupIds: {
              ...s.activeGroupIds,
              [wsId]: newGroupId,
            },
            layouts: {
              ...s.layouts,
              [wsId]: {
                root: splitNode,
                groups: {
                  ...layout.groups,
                  [newGroupId]: newGroup,
                },
              },
            },
          });

          // Focus the new bottom terminal after it mounts
          setTimeout(() => {
            window.dispatchEvent(
              new CustomEvent("rally-focus-group", { detail: newGroupId }),
            );
          }, 50);
          return;
        }

        const isCollapsed = !!s.bottomPanelCollapsed[wsId];
        const rootVSplit =
          root.type === "split" && root.direction === "vertical"
            ? (root as Extract<LayoutNode, { type: "split" }>)
            : null;

        if (isCollapsed) {
          // Collapsed → expand to golden ratio
          if (rootVSplit) {
            // Repopulate empty bottom groups with a terminal
            const bottomGroupId = findFirstGroupInSubtree(
              rootVSplit.children[1],
            );
            const bottomGroup = bottomGroupId
              ? layout.groups[bottomGroupId]
              : null;
            if (
              bottomGroupId &&
              bottomGroup &&
              bottomGroup.panes.length === 0
            ) {
              const activeGroupId = s.activeGroupIds[wsId];
              const activeGroup = activeGroupId
                ? layout.groups[activeGroupId]
                : null;
              const activePane = activeGroup?.panes.find(
                (p) => p.id === activeGroup.activePaneId,
              );
              const cwd = activePane?.cwd || s.getActivePath(wsId) || undefined;
              const newPane: Pane = {
                id: crypto.randomUUID(),
                type: "terminal",
                title: "Terminal",
                ...(cwd ? { cwd } : {}),
              };
              layout = {
                ...layout,
                groups: {
                  ...layout.groups,
                  [bottomGroupId]: {
                    ...bottomGroup,
                    panes: [newPane],
                    activePaneId: newPane.id,
                  },
                },
              };
            }

            // Set ratio to golden and uncollapse
            const newRoot = replaceNode(layout.root, rootVSplit.id, {
              ...rootVSplit,
              ratio: DEFAULT_BOTTOM_RATIO,
            });
            useWorkspaceStore.setState({
              bottomPanelCollapsed: {
                ...s.bottomPanelCollapsed,
                [wsId]: false,
              },
              layouts: { ...s.layouts, [wsId]: { ...layout, root: newRoot } },
            });

            // Focus the bottom terminal
            const focusGroupId = findFirstGroupInSubtree(
              rootVSplit.children[1],
            );
            if (focusGroupId) {
              setTimeout(() => {
                window.dispatchEvent(
                  new CustomEvent("rally-focus-group", {
                    detail: focusGroupId,
                  }),
                );
              }, 50);
            }
          }
        } else if (rootVSplit) {
          const bottomIsBiggerThanGolden =
            rootVSplit.ratio < DEFAULT_BOTTOM_RATIO - 0.02;
          if (bottomIsBiggerThanGolden) {
            // Bottom panel larger than golden → snap to golden first
            const newRoot = replaceNode(layout.root, rootVSplit.id, {
              ...rootVSplit,
              ratio: DEFAULT_BOTTOM_RATIO,
            });
            useWorkspaceStore.setState({
              layouts: { ...s.layouts, [wsId]: { ...layout, root: newRoot } },
            });
          } else {
            // Bottom panel at or smaller than golden → collapse
            s.toggleBottomPanel(wsId);
          }
        }
      }
      // Cmd+Shift+F: toggle search panel
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "f"
      ) {
        e.preventDefault();
        if (!fileExplorerCollapsed && explorerView === "search") {
          setExplorerView("files");
        } else {
          setExplorerView("search");
          if (fileExplorerCollapsed) {
            setFileExplorerCollapsed(false);
          }
        }
      }
      // Cmd+Shift+C: add Claude tab to focused pod (flight mode)
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "c"
      ) {
        const s = useWorkspaceStore.getState();
        const wsId = s.activeWorkspaceId;
        if (!wsId) return;
        const mode = s.workspaceModes[wsId] ?? "flight";
        if (mode === "flight") {
          e.preventDefault();
          const layout = s.flightLayouts[wsId];
          if (!layout) return;
          const pods = layout.pods;
          if (pods.length === 0) return;
          // Find focused pod via last interaction tracking
          let focusedPod = pods[0];
          if (lastFocusedFlightPodId) {
            const match = pods.find((p) => p.id === lastFocusedFlightPodId);
            if (match) focusedPod = match;
          }
          // Add a claude pane to the focused pod's layout
          const podLayoutId = `flight:${focusedPod.id}`;
          const podLayout = s.getOrCreatePodLayout(podLayoutId, focusedPod.cwd, "claude");
          const firstGroupId = Object.keys(podLayout.groups)[0];
          if (firstGroupId) {
            s.addPaneToGroup(podLayoutId, firstGroupId, {
              id: crypto.randomUUID(),
              type: "claude",
              title: "Claude Code",
              cwd: focusedPod.cwd,
            });
          }
        }
      }
      // Cmd+E: toggle file explorer
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        e.key.toLowerCase() === "e"
      ) {
        e.preventDefault();
        if (fileExplorerCollapsed) {
          setExplorerView("files");
          setFileExplorerCollapsed(false);
        } else {
          setFileExplorerCollapsed(true);
        }
      }
      // Cmd+P: toggle quick open
      // Cmd+S: save the active editor pane (works from any focused element)
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "s") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("rally:save-active-editor"));
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "p") {
        e.preventDefault();
        setNewTerminalCwdRequest(null);
        setQuickOpenVisible((prev) => !prev);
      }
      if (e.metaKey && e.key === "/") {
        e.preventDefault();
        const s = useWorkspaceStore.getState();
        const wsId = s.activeWorkspaceId;
        if (!wsId) return;
        const layout = s.getOrCreateLayout(wsId);
        // Use active group, or fall back to first group in layout tree
        let groupId: string | undefined = s.activeGroupIds[wsId];
        if (!groupId || !layout.groups[groupId]) {
          groupId = findFirstGroupInSubtree(layout.root) ?? undefined;
        }
        if (!groupId) return;
        const activePath = s.getActivePath(wsId);
        s.splitGroup(wsId, groupId, "horizontal", activePath ?? undefined);
      }
      // Cmd+Shift+[ / Cmd+Shift+]: cycle tabs left/right in active group
      if (
        e.metaKey &&
        e.shiftKey &&
        (e.code === "BracketLeft" || e.code === "BracketRight")
      ) {
        e.preventDefault();
        const s = useWorkspaceStore.getState();
        const wsId = s.activeWorkspaceId;
        if (!wsId) return;
        // In flight mode, use the focused pod's layout
        const mode = s.workspaceModes[wsId] ?? "flight";
        let layoutKey = wsId;
        if (mode === "flight" && lastFocusedFlightPodId) {
          layoutKey = `flight:${lastFocusedFlightPodId}`;
        }
        const layout = s.getOrCreateLayout(layoutKey);
        const groupId = s.activeGroupIds[layoutKey];
        if (!groupId) return;
        const group = layout.groups[groupId];
        if (!group || group.panes.length < 2) return;
        const idx = group.panes.findIndex((p) => p.id === group.activePaneId);
        const delta = e.code === "BracketLeft" ? -1 : 1;
        const next = (idx + delta + group.panes.length) % group.panes.length;
        s.setActivePane(layoutKey, groupId, group.panes[next].id);
      }
      // Shift+Arrow: navigate between pane groups
      if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const dirMap: Record<string, NavigationDirection> = {
          ArrowLeft: "left",
          ArrowRight: "right",
          ArrowUp: "up",
          ArrowDown: "down",
        };
        const direction = dirMap[e.key];
        if (direction) {
          e.preventDefault();
          const s = useWorkspaceStore.getState();
          const wsId = s.activeWorkspaceId;
          if (!wsId) return;
          const layout = s.getOrCreateLayout(wsId);
          const activeGroupId = s.activeGroupIds[wsId];
          if (!activeGroupId) return;
          const targetGroupId = findNeighborGroup(
            layout.root,
            activeGroupId,
            direction,
          );
          if (!targetGroupId || targetGroupId === activeGroupId) return;
          // Update active group and dispatch focus event
          useWorkspaceStore.setState({
            activeGroupIds: { ...s.activeGroupIds, [wsId]: targetGroupId },
          });
          window.dispatchEvent(
            new CustomEvent("rally-focus-group", { detail: targetGroupId }),
          );
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    const handleRequest = (event: Event) => {
      const detail = (event as CustomEvent<RequestNewTerminalCwdDetail>).detail;
      if (!detail?.workspaceId || !detail?.groupId) return;
      // If workspace has only one repo, skip the picker and open terminal directly
      const ws = useWorkspaceStore
        .getState()
        .workspaces.find((w) => w.id === detail.workspaceId);
      if (ws && ws.paths.length === 1) {
        const pane: Pane = {
          id: crypto.randomUUID(),
          type: "terminal",
          title: "Terminal",
          cwd: ws.paths[0],
        };
        addPaneToGroup(detail.workspaceId, detail.groupId, pane);
        return;
      }
      setQuickOpenVisible(false);
      setNewTerminalCwdRequest(detail);
    };

    window.addEventListener(REQUEST_NEW_TERMINAL_CWD_EVENT, handleRequest);
    return () => {
      window.removeEventListener(REQUEST_NEW_TERMINAL_CWD_EVENT, handleRequest);
    };
  }, [addPaneToGroup]);

  const terminalPickerPaths = newTerminalCwdRequest
    ? (workspaces.find((w) => w.id === newTerminalCwdRequest.workspaceId)
        ?.paths ?? [])
    : [];

  const handleSelectTerminalCwd = useCallback(
    (cwd: string) => {
      if (!newTerminalCwdRequest) return;
      const pane: Pane = {
        id: crypto.randomUUID(),
        type: "terminal",
        title: "Terminal",
        cwd,
      };
      addPaneToGroup(
        newTerminalCwdRequest.workspaceId,
        newTerminalCwdRequest.groupId,
        pane,
      );
      setNewTerminalCwdRequest(null);
    },
    [newTerminalCwdRequest, addPaneToGroup],
  );

  const appWindow = getCurrentWindow();

  const handleExplorerResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizingRef.current = true;
      const startX = e.clientX;
      const startWidth = fileExplorerWidth;
      let finalWidth = startWidth;
      let raf = 0;

      const onMouseMove = (ev: MouseEvent) => {
        if (!resizingRef.current) return;
        finalWidth = Math.max(
          180,
          Math.min(500, startWidth + (ev.clientX - startX)),
        );
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          if (explorerRef.current) {
            explorerRef.current.style.width = finalWidth + "px";
            explorerRef.current.style.minWidth = finalWidth + "px";
          }
        });
      };
      const onMouseUp = () => {
        cancelAnimationFrame(raf);
        preferredExplorerWidthRef.current = finalWidth;
        setFileExplorerWidth(finalWidth);
        localStorage.setItem(fileExplorerWidthKey, String(finalWidth));
        // Keep resizingRef true briefly so the auto-shrink effect
        // (which re-runs when fileExplorerWidth changes) doesn't
        // immediately override the user's chosen width.
        setTimeout(() => {
          resizingRef.current = false;
        }, 100);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [fileExplorerWidth, fileExplorerWidthKey],
  );

  const handleDrag = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("button")) return;
      // Dismiss any open dropdowns/popovers before starting drag
      // (startDragging swallows the event at native level, so document mousedown listeners won't fire)
      document.dispatchEvent(new CustomEvent("rally:dismiss-popups"));
      appWindow.startDragging();
    },
    [appWindow],
  );

  return (
    <div style={styles.app}>
      <div
        data-tauri-drag-region
        style={styles.titlebar}
        onMouseDown={handleDrag}
      >
        <div style={styles.titlebarLeft}>
          <AgentSidebarToggle />
          <button
            className="activity-btn"
            onClick={(e) => {
              e.stopPropagation();
              toggleToolRail();
            }}
            title={activityBarVisible ? "Hide tool rail (⌘⇧B)" : "Show tool rail (⌘⇧B)"}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              width: 26,
              height: 22,
              padding: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 4,
              color: activityBarVisible ? "var(--text-primary)" : "var(--text-secondary)",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ display: "block" }}>
              <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.1" />
              <path d="M4.5 2.5v11" stroke="currentColor" strokeWidth="1.1" />
              <circle cx="3" cy="5" r="0.6" fill="currentColor" />
              <circle cx="3" cy="7.5" r="0.6" fill="currentColor" />
              <circle cx="3" cy="10" r="0.6" fill="currentColor" />
            </svg>
          </button>
        </div>
        <div style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "center" }}>
          <span style={styles.titleText}>{activeWorkspaceName}</span>
        </div>
        <div style={styles.titlebarRight}>
        </div>
      </div>
      <div style={{ ...styles.body, zoom: zoomLevel }}>
        <AgentSidebar />
        <div style={{ ...styles.activityBar, display: activityBarVisible ? "flex" : "none" }}>
          {(
            [
              {
                view: "workspaces" as const,
                title: "Workspaces",
                icon: (active: boolean) => (
                  <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                    <rect
                      x="1.5"
                      y="1.5"
                      width="5.5"
                      height="5.5"
                      rx="1.2"
                      stroke={
                        active ? "var(--text-primary)" : "var(--text-secondary)"
                      }
                      strokeWidth="1.0"
                    />
                    <rect
                      x="9"
                      y="1.5"
                      width="5.5"
                      height="5.5"
                      rx="1.2"
                      stroke={
                        active ? "var(--text-primary)" : "var(--text-secondary)"
                      }
                      strokeWidth="1.0"
                    />
                    <rect
                      x="1.5"
                      y="9"
                      width="5.5"
                      height="5.5"
                      rx="1.2"
                      stroke={
                        active ? "var(--text-primary)" : "var(--text-secondary)"
                      }
                      strokeWidth="1.0"
                    />
                    <rect
                      x="9"
                      y="9"
                      width="5.5"
                      height="5.5"
                      rx="1.2"
                      stroke={
                        active ? "var(--text-primary)" : "var(--text-secondary)"
                      }
                      strokeWidth="1.0"
                    />
                  </svg>
                ),
              },
              {
                view: "files" as const,
                title: "Files",
                icon: (active: boolean) => (
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill={
                      active ? "var(--text-primary)" : "var(--text-secondary)"
                    }
                  >
                    <path d="M17.5 0H8.5L7 1.5V6H2.5L1 7.5V22.5699L2.5 24H14.5699L16 22.5699V18H20.7L22 16.5699V4.5L17.5 0ZM17.5 2.12L19.88 4.5H17.5V2.12ZM14.5 22.5H2.5V7.5H7V16.5699L8.5 18H14.5V22.5ZM20.5 16.5H8.5V1.5H16V6H20.5V16.5Z" />
                  </svg>
                ),
              },
              {
                view: "threads" as const,
                title: "Parked threads",
                icon: (active: boolean) => (
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                  >
                    <rect
                      x="2"
                      y="3"
                      width="12"
                      height="2"
                      rx="0.6"
                      stroke={
                        active ? "var(--text-primary)" : "var(--text-secondary)"
                      }
                      strokeWidth="1.0"
                    />
                    <rect
                      x="2"
                      y="7"
                      width="12"
                      height="2"
                      rx="0.6"
                      stroke={
                        active ? "var(--text-primary)" : "var(--text-secondary)"
                      }
                      strokeWidth="1.0"
                    />
                    <rect
                      x="2"
                      y="11"
                      width="12"
                      height="2"
                      rx="0.6"
                      stroke={
                        active ? "var(--text-primary)" : "var(--text-secondary)"
                      }
                      strokeWidth="1.0"
                    />
                  </svg>
                ),
              },
              {
                view: "search" as const,
                title: "Search",
                icon: (active: boolean) => (
                  <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                    <circle
                      cx="7"
                      cy="7"
                      r="4.5"
                      stroke={
                        active ? "var(--text-primary)" : "var(--text-secondary)"
                      }
                      strokeWidth="1.0"
                    />
                    <line
                      x1="10.5"
                      y1="10.5"
                      x2="14"
                      y2="14"
                      stroke={
                        active ? "var(--text-primary)" : "var(--text-secondary)"
                      }
                      strokeWidth="1.0"
                      strokeLinecap="round"
                    />
                  </svg>
                ),
              },
              {
                view: "rally" as const,
                title: "Rally settings",
                icon: (active: boolean) => (
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M2 3L6.5 8L2 13"
                      stroke={
                        active ? "var(--text-primary)" : "var(--text-secondary)"
                      }
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity="0.3"
                    />
                    <path
                      d="M4.5 3L9 8L4.5 13"
                      stroke={
                        active ? "var(--text-primary)" : "var(--text-secondary)"
                      }
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity="0.6"
                    />
                    <path
                      d="M7 3L11.5 8L7 13"
                      stroke={
                        active ? "var(--text-primary)" : "var(--text-secondary)"
                      }
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ),
              },
              {
                view: "tasks" as const,
                title: "Processes",
                icon: (active: boolean) => (
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                  >
                    <rect
                      x="3.5"
                      y="3.5"
                      width="9"
                      height="9"
                      rx="1.2"
                      stroke={
                        active ? "var(--text-primary)" : "var(--text-secondary)"
                      }
                      strokeWidth="1.0"
                    />
                    <rect
                      x="6"
                      y="6"
                      width="4"
                      height="4"
                      rx="0.5"
                      stroke={
                        active ? "var(--text-primary)" : "var(--text-secondary)"
                      }
                      strokeWidth="1.0"
                    />
                    <path
                      d="M6 1.5V3.5M10 1.5V3.5M6 12.5V14.5M10 12.5V14.5M1.5 6H3.5M1.5 10H3.5M12.5 6H14.5M12.5 10H14.5"
                      stroke={
                        active ? "var(--text-primary)" : "var(--text-secondary)"
                      }
                      strokeWidth="1.0"
                      strokeLinecap="round"
                    />
                  </svg>
                ),
              },
            ] as {
              view: typeof explorerView;
              title: string;
              icon: (active: boolean) => React.ReactNode;
            }[]
          ).map(({ view, title, icon }) => {
            const isActive = !fileExplorerCollapsed && explorerView === view;
            return (
              <button
                key={view}
                className={`activity-btn${isActive ? " activity-btn-active" : ""}`}
                style={styles.activityBtn}
                onClick={() => {
                  autoCollapsedRef.current = false;
                  if (isActive) {
                    setFileExplorerCollapsed(true);
                  } else {
                    setExplorerView(view);
                    if (fileExplorerCollapsed) {
                      setFileExplorerCollapsed(false);
                    }
                  }
                }}
                title={
                  isActive
                    ? `Hide ${title.toLowerCase()}`
                    : `Show ${title.toLowerCase()}`
                }
              >
                {icon(isActive)}
              </button>
            );
          })}
          <div style={{ flex: 1 }} />
          <ThemeCycleButton />
        </div>
        <div
          style={{
            display: fileExplorerCollapsed ? "none" : "flex",
            flexShrink: 0,
          }}
        >
          <div
            ref={explorerRef}
            style={{
              width: fileExplorerWidth,
              minWidth: fileExplorerWidth,
              flexShrink: 0,
              background: "var(--bg-app)",
            }}
          >
            {explorerView === "workspaces" && (
              <WorkspacePicker
                onSelect={(id) => {
                  setActiveWorkspace(id);
                  setFileExplorerCollapsed(true);
                }}
              />
            )}
            <div
              style={{
                display: explorerView === "search" ? undefined : "none",
                height: "100%",
              }}
            >
              <SearchPanel
                onCollapse={() => setFileExplorerCollapsed(true)}
                flushLeft
              />
            </div>
            {explorerView === "rally" && <RallySettingsPanel />}
            {explorerView === "tasks" && <TaskManagerPanel />}
            {explorerView === "threads" && <ParkedThreadsPanel />}
            <div
              style={{
                display: explorerView === "files" ? undefined : "none",
                height: "100%",
              }}
            >
              <FileExplorer
                onCollapse={() => setFileExplorerCollapsed(true)}
                flushLeft
              />
            </div>
          </div>
          <div
            onMouseDown={handleExplorerResize}
            style={styles.explorerResizeHandle}
          >
            <div style={styles.resizeLine} />
            <div style={styles.explorerResizeHeaderBorder} />
          </div>
        </div>
        <div style={styles.main}>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              position: "relative",
            }}
          >
            {/* Flight Mode */}
            <div
              style={{
                display: isFlightMode ? "flex" : "none",
                flex: 1,
                flexDirection: "column" as const,
                minWidth: 0,
                minHeight: 0,
                position: "relative" as const,
                overflow: "hidden",
              }}
            >
              <FlightCanvas />
              <BuildStatusDrawer />
            </div>
            {/* Classic Dev Mode */}
            <div
              style={{
                display: isDevMode ? "flex" : "none",
                flex: 1,
                flexDirection: "column" as const,
                minWidth: 0,
                minHeight: 0,
                position: "relative" as const,
                overflow: "hidden",
              }}
            >
              <PaneLayout />
              <BuildStatusDrawer />
            </div>
            {!isFlightMode && <BuildStatusBar />}
          </div>
        </div>
        <UnifiedGitPanel />
      </div>
      <TaskLauncher />
      <style>{`
        .syn-comment { color: #8b949e; font-style: italic; }
        .syn-string { color: #a5d6ff; }
        .syn-keyword { color: #ff7b72; }
        .syn-literal { color: #79c0ff; }
        .syn-number { color: #d2a8ff; }
        .repo-action-btn:hover { background: var(--bg-active) !important; }
        .hunk-action-btn:hover { background: var(--bg-active) !important; color: var(--text-primary) !important; }
        .file-list-item:hover { background: var(--bg-hover) !important; }
        .file-list-item-selected { background: var(--bg-hover) !important; }
        .git-diff-overlay { scrollbar-gutter: stable; }
        .git-diff-overlay ::-webkit-scrollbar { width: 6px; height: 0; }
        .git-diff-overlay ::-webkit-scrollbar-track { background: transparent; }
        .git-diff-overlay ::-webkit-scrollbar-thumb { background: var(--bg-hover); border-radius: 3px; transition: background 0.2s; }
        .git-diff-overlay :hover > ::-webkit-scrollbar-thumb,
        .git-diff-overlay *:hover::-webkit-scrollbar-thumb { background: var(--border-subtle); }
        .git-diff-overlay *:hover::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
        .git-diff-overlay ::-webkit-scrollbar-corner { background: transparent; }
      `}</style>
      <QuickOpen
        visible={quickOpenVisible}
        onClose={() => setQuickOpenVisible(false)}
      />
      <QuickOpen
        mode="cwd"
        visible={!!newTerminalCwdRequest}
        onClose={() => setNewTerminalCwdRequest(null)}
        cwdOptions={terminalPickerPaths}
        onSelectCwd={handleSelectTerminalCwd}
        placeholder="Select current working directory for new terminal"
      />
      <ToastContainer />
      {showAddWorkspaceModal && (
        <AddWorkspaceModal onClose={() => setShowAddWorkspaceModal(false)} />
      )}
    </div>
  );
}

function ThemeIcon({ t, size = 18 }: { t: ThemeName; size?: number }) {
  if (t === "light")
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  if (t === "dimmed")
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M12 2v3M12 19v3M2 12h3M19 12h3"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ThemeCycleButton() {
  const theme = useWorkspaceStore((s) => s.theme);
  const setTheme = useWorkspaceStore((s) => s.setTheme);

  const toggle = () => {
    setTheme(theme === "dark" ? "dimmed" : "dark");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 4 }}>
      <button
        className="activity-btn"
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          width: 32,
          height: 32,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 4,
          color: "var(--text-secondary)",
          padding: 0,
        }}
        onClick={toggle}
        title={theme === "dark" ? "Switch to Dimmed" : "Switch to Dark"}
      >
        <ThemeIcon t={theme} />
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  app: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    width: "100vw",
    overflow: "hidden",
    background: "transparent",
  },
  titlebar: {
    height: 34,
    minHeight: 34,
    display: "flex",
    alignItems: "center",
    borderBottom: "1px solid var(--border)",
    userSelect: "none",
    position: "relative",
    paddingLeft: 70,
    background: "var(--bg-app)",
  },
  titlebarLeft: {
    position: "absolute",
    left: 70,
    top: "50%",
    transform: "translateY(-50%)",
    display: "flex",
    alignItems: "center",
    gap: 2,
  },
  titlebarBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
  },
  titleText: {
    fontSize: 13,
    fontWeight: 700,
    color: "var(--text-primary)",
    letterSpacing: "0.01em",
    pointerEvents: "none" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  titlebarRight: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    paddingRight: 12,
    flexShrink: 0,
  },
  prPill: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    background: "none",
    border: "1px solid rgba(255, 255, 255, 0.25)",
    cursor: "pointer",
    height: 22,
    padding: "0 8px 0 6px",
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 700,
    color: "var(--text-secondary)",
    lineHeight: 1,
    maxWidth: 200,
    overflow: "hidden",
  },
  body: {
    flex: 1,
    display: "flex",
    minHeight: 0,
    position: "relative",
    overflow: "hidden",
  },
  activityBar: {
    width: 38,
    minWidth: 38,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    background: "var(--bg-app)",
    borderRight: "1px solid var(--border)",
    paddingTop: 2,
    gap: 2,
    flexShrink: 0,
  },
  activityBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    width: 32,
    height: 32,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
  },
  main: {
    background: "var(--bg-app)",
    flex: 1,
    display: "flex",
    flexDirection: "row",
    minWidth: 0,
    position: "relative",
    overflow: "hidden",
  },
  explorerResizeHandle: {
    width: 2,
    minWidth: 2,
    cursor: "col-resize",
    background:
      "linear-gradient(to bottom, var(--bg-surface) 28px, var(--bg-elevated) 28px, var(--bg-elevated) 29px, var(--bg-surface) 29px)",
    flexShrink: 0,
    zIndex: 10,
    display: "flex",
    alignItems: "stretch",
    justifyContent: "flex-end",
    position: "relative" as const,
  },
  resizeLine: {
    width: 1,
    background: "var(--border)",
    pointerEvents: "none" as const,
  },
  explorerResizeHeaderBorder: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    width: "calc(100% - 1px)",
    height: 29,
    borderBottom: "1px solid var(--border)",
    pointerEvents: "none" as const,
  },
};
