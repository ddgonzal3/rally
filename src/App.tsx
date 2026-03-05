import React, { useState, useEffect, useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openWindow } from "./lib/windowUtils";
import { FileExplorer } from "./components/FileExplorer";
import { GlobalConfigExplorer } from "./components/SettingsPanel";
import { ScriptEditor } from "./components/ScriptEditor";
import { PaneLayout } from "./components/PaneLayout";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { api } from "./lib/tauri";
import { showContextMenu } from "./lib/contextMenu";
import { AddWorkspaceModal } from "./components/AddWorkspaceModal";
import { DEFAULT_BOTTOM_RATIO, findFirstGroupInSubtree, findNeighborGroup, replaceNode, type LayoutNode, type NavigationDirection, type Pane, type ThemeName } from "./lib/types";
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
import { ShipStatusPill } from "./components/ShipStatusPill";
import { UnifiedGitPanel } from "./components/UnifiedGitPanel";
import { SearchPanel } from "./components/SearchPanel";
import { ProductChatPanel } from "./components/ProductChatPanel";
import { BuildStatusBar } from "./components/BuildStatusBar";
import { BuildStatusDrawer } from "./components/BuildStatusDrawer";
import QuickOpen from "./components/QuickOpen";

const WS_DRAG_THRESHOLD = 4;
const WS_DRAG_SCROLL_EDGE = 28;
const WS_DRAG_MAX_SCROLL_STEP = 14;
const WS_REORDER_TRANSITION = "transform 170ms cubic-bezier(0.2, 0, 0, 1)";

function wsClamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

function wsAutoScroll(listEl: HTMLElement | null, pointerY: number) {
  if (!listEl) return;
  const r = listEl.getBoundingClientRect();
  if (pointerY < r.top + WS_DRAG_SCROLL_EDGE) {
    const s = (r.top + WS_DRAG_SCROLL_EDGE - pointerY) / WS_DRAG_SCROLL_EDGE;
    listEl.scrollTop -= Math.ceil(s * WS_DRAG_MAX_SCROLL_STEP);
  } else if (pointerY > r.bottom - WS_DRAG_SCROLL_EDGE) {
    const s = (pointerY - (r.bottom - WS_DRAG_SCROLL_EDGE)) / WS_DRAG_SCROLL_EDGE;
    listEl.scrollTop += Math.ceil(s * WS_DRAG_MAX_SCROLL_STEP);
  }
}

function wsInsertIndex(ids: string[], dragId: string, refs: Map<string, HTMLDivElement>, pointerY: number) {
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
    if (trimmed && trimmed !== workspaces.find((w) => w.id === renamingId)?.name) {
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
        dropIndex = wsInsertIndex(orderedIds, wsId, itemRefs.current, ev.clientY);
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
        setTimeout(() => { suppressClickRef.current = false; }, 0);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp, { once: true });
    },
    [workspaces, renamingId, reorderWorkspace],
  );

  const draggingFromIndex = draggingId ? workspaces.findIndex((w) => w.id === draggingId) : -1;

  return (
    <>
      <div className="no-select" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg-surface)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 8px 8px 12px" }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-primary)", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>
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
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
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
              { label: "New Workspace...", action: () => setShowAddModal(true) },
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
              } else if (draggingFromIndex < dragToIndex && index > draggingFromIndex && index <= dragToIndex) {
                transform = `translateY(${-dragItemHeight}px)`;
              } else if (draggingFromIndex > dragToIndex && index >= dragToIndex && index < draggingFromIndex) {
                transform = `translateY(${dragItemHeight}px)`;
              }
            }

            return (
              <div
                key={ws.id}
                ref={(node) => { if (node) itemRefs.current.set(ws.id, node); else itemRefs.current.delete(ws.id); }}
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
                    { label: "Open in New Window", action: () => openWindow({ workspaceId: ws.id }) },
                    "separator",
                    { label: "Rename", action: () => startRename(ws.id, ws.name) },
                    "separator",
                    { label: "Remove Workspace", action: () => removeWorkspace(ws.id) },
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
                  color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                  fontSize: 13,
                  fontWeight: isActive ? 600 : 500,
                  cursor: isRenaming ? "text" : isDragging ? "grabbing" : "pointer",
                  textAlign: "left" as const,
                  position: "relative" as const,
                  willChange: "transform",
                  transform,
                  transition: isDragging
                    ? "box-shadow 120ms, background-color 120ms"
                    : `${WS_REORDER_TRANSITION}, background-color 120ms`,
                  ...(isDragging ? { zIndex: 4, boxShadow: "0 8px 20px var(--shadow)", opacity: 0.96 } : {}),
                }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                  <rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke={isActive ? "var(--text-primary)" : "var(--text-dim)"} strokeWidth="1.0" />
                  <path d="M1.5 5.5h13" stroke={isActive ? "var(--text-primary)" : "var(--text-dim)"} strokeWidth="1.0" />
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
                      if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                      else if (e.key === "Escape") setRenamingId(null);
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
  const BACKGROUND_WORK_DEFER_MS = 2500;
  const fileExplorerCollapsedKey = `rally:fileExplorerCollapsed:${windowLabel}`;
  const fileExplorerWidthKey = `rally:fileExplorerWidth:${windowLabel}`;

  // Individual selectors for action functions — prevents App from re-rendering
  // on every store data change (git/PR/ship polls, task output, etc.)
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
  const refreshPrStatusForPath = useWorkspaceStore(
    (s) => s.refreshPrStatusForPath,
  );
  const pollShipSignals = useWorkspaceStore((s) => s.pollShipSignals);
  const fetchAllRepos = useWorkspaceStore((s) => s.fetchAllRepos);
  const activeWorkspaceName = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    return ws?.name ?? "Rally";
  });
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspaceMode = useWorkspaceStore((s) => {
    if (!s.activeWorkspaceId) return "dev";
    return s.workspaceModes[s.activeWorkspaceId] ?? "dev";
  });
  const setWorkspaceMode = useWorkspaceStore((s) => s.setWorkspaceMode);
  const loadRallyConfig = useWorkspaceStore((s) => s.loadRallyConfig);
  const isProductMode = workspaceMode === "product";
  const activeRootPath = useWorkspaceStore((s) => {
    return s.activeWorkspaceId ? (s.getActivePath(s.activeWorkspaceId) ?? "") : "";
  });
  const gitPanelOpen = useWorkspaceStore((s) => s.unifiedGitPanelOpen);

  const [fileExplorerCollapsed, setFileExplorerCollapsed] = useState(
    () => localStorage.getItem(fileExplorerCollapsedKey) === "true",
  );
  const [zoomLevel, setZoomLevel] = useState(() => {
    const saved = localStorage.getItem("rally:zoomLevel");
    return saved ? Number(saved) : 1.0;
  });
  type ExplorerView = "files" | "search" | "claude" | "scripts" | "workspaces";
  const explorerViewPerWorkspaceRef = useRef<Map<string, ExplorerView>>(new Map());
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
  const gitRefreshInFlightRef = useRef(false);
  const prRefreshInFlightRef = useRef(false);
  const shipPollInFlightRef = useRef(false);
  const fetchInFlightRef = useRef(false);
  const lastInteractionAtRef = useRef(Date.now());
  const explorerRef = useRef<HTMLDivElement>(null);
  // The user's preferred explorer width (set by drag resize or initial load).
  // When the window is too narrow we shrink below this, and restore when space returns.
  const preferredExplorerWidthRef = useRef(fileExplorerWidth);

  // Hover-to-open for workspaces panel
  const workspacesHoverRef = useRef(false);
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preHoverRef = useRef<{ collapsed: boolean; view: typeof explorerView } | null>(null);
  const [wsHoverAnim, setWsHoverAnim] = useState<"in" | "out" | null>(null);
  const [showAddWorkspaceModal, setShowAddWorkspaceModal] = useState(false);

  // Auto-shrink explorer (and collapse sidebar as last resort) to keep main area usable
  const MIN_MAIN_WIDTH = 600;
  const MIN_EXPLORER_WIDTH = 120;
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
      if (isSnap && w > halfScreen && fileExplorerCollapsed && autoCollapsedRef.current) {
        autoCollapsedRef.current = false;
        setFileExplorerCollapsed(false);
        return;
      }

      if (mainWidth < MIN_MAIN_WIDTH && !fileExplorerCollapsed) {
        // Shrink explorer to fit
        const available =
          w -
          ACTIVITY_BAR_WIDTH -
          RESIZE_HANDLE_WIDTH -
          MIN_MAIN_WIDTH;
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
    document.addEventListener("keydown", markInteraction, { passive: true });
    document.addEventListener("wheel", markInteraction, { passive: true });
    document.addEventListener("scroll", markInteraction, {
      passive: true,
      capture: true,
    });
    return () => {
      document.removeEventListener("pointerdown", markInteraction);
      document.removeEventListener("keydown", markInteraction);
      document.removeEventListener("wheel", markInteraction);
      document.removeEventListener("scroll", markInteraction, true);
    };
  }, []);

  const shouldDeferBackgroundWork = useCallback(() => {
    if (document.hidden) return true;
    return Date.now() - lastInteractionAtRef.current < BACKGROUND_WORK_DEFER_MS;
  }, [BACKGROUND_WORK_DEFER_MS]);

  const runGitRefresh = useCallback(
    async (force = false) => {
      if (gitRefreshInFlightRef.current) return;
      if (!force && shouldDeferBackgroundWork()) return;
      gitRefreshInFlightRef.current = true;
      try {
        await refreshAllGitStatuses();
      } finally {
        gitRefreshInFlightRef.current = false;
      }
    },
    [refreshAllGitStatuses, shouldDeferBackgroundWork],
  );

  const runPrRefresh = useCallback(
    async (force = false) => {
      if (prRefreshInFlightRef.current) return;
      if (!force && shouldDeferBackgroundWork()) return;
      prRefreshInFlightRef.current = true;
      try {
        await refreshAllPrStatuses();
      } finally {
        prRefreshInFlightRef.current = false;
      }
    },
    [refreshAllPrStatuses, shouldDeferBackgroundWork],
  );

  const runShipPoll = useCallback(async () => {
    if (shipPollInFlightRef.current) return;
    if (shouldDeferBackgroundWork()) return;
    shipPollInFlightRef.current = true;
    try {
      await pollShipSignals();
    } finally {
      shipPollInFlightRef.current = false;
    }
  }, [pollShipSignals, shouldDeferBackgroundWork]);

  const runFetchAll = useCallback(async () => {
    if (fetchInFlightRef.current) return;
    if (shouldDeferBackgroundWork()) return;
    fetchInFlightRef.current = true;
    try {
      await fetchAllRepos();
    } finally {
      fetchInFlightRef.current = false;
    }
  }, [fetchAllRepos, shouldDeferBackgroundWork]);

  useEffect(() => {
    let cancelled = false;

    // Kill all orphaned PTYs from a previous session. On reload/restart the
    // frontend loses all xterm state and event listeners, so existing PTYs
    // can never be reconnected — they'd leak as zombie processes.
    api.killAllPtys().catch((e: unknown) =>
      console.error("Failed to kill orphaned PTYs:", e),
    );

    loadWorkspaces({ keepNullActive: forceNoWorkspaceSelection }).then(
      async () => {
        if (cancelled) return;
        await Promise.all([runGitRefresh(true), runPrRefresh(true)]);
      },
    );

    const gitInterval = setInterval(() => {
      void runGitRefresh();
    }, 10000);
    const prInterval = setInterval(() => {
      void runPrRefresh();
    }, 90000);
    const shipInterval = setInterval(() => {
      void runShipPoll();
    }, 5000);
    const fetchInterval = setInterval(() => {
      void runFetchAll();
    }, 60000);

    return () => {
      cancelled = true;
      clearInterval(gitInterval);
      clearInterval(prInterval);
      clearInterval(shipInterval);
      clearInterval(fetchInterval);
    };
  }, [
    loadWorkspaces,
    runGitRefresh,
    runPrRefresh,
    runShipPoll,
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
        const mode = config.mode === "product" ? "product" as const : "dev" as const;
        s.setWorkspaceMode(activeWorkspaceId, mode);
      }
    });
  }, [activeWorkspaceId, workspaces, loadRallyConfig]);

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
      const rootPath = event.payload?.rootPath;
      if (!rootPath) return;
      const existing = refreshTimers.get(rootPath);
      if (existing) clearTimeout(existing);
      const delay = shouldDeferBackgroundWork() ? 1200 : 120;
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

  // Native File menu actions (always handled here so they work even when
  // sidebar/explorer panels are collapsed).
  useEffect(() => {
    let cancelled = false;
    let unlistenNewFile: UnlistenFn | null = null;
    let unlistenNewWorkspace: UnlistenFn | null = null;
    let unlistenAddFolder: UnlistenFn | null = null;
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
      unlistenNewWindow?.();
      unlistenOpenCurrentInNewWindow?.();
      unlistenWorkspacesUpdated?.();
    };
  }, [loadWorkspaces, forceNoWorkspaceSelection]);

  // Ensure file explorer is visible when a file is opened (e.g. Cmd+click in terminal)
  useEffect(() => {
    const handler = () => {
      setFileExplorerCollapsed(false);
      // Keep search panel open when clicking search results
      setExplorerView((prev) => prev === "search" ? prev : "files");
    };
    document.addEventListener("rally-ensure-explorer-visible", handler);
    return () => document.removeEventListener("rally-ensure-explorer-visible", handler);
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
          const exceedsLogical = rawX > window.innerWidth * 1.15 || rawY > window.innerHeight * 1.15;
          coordScale = exceedsLogical ? dpr : 1;
          const { x, y } = toLogical(rawX, rawY);
          startExternalFileDrag(event.payload.paths, x, y);
        } else if (type === "over") {
          const { x, y } = toLogical(event.payload.position.x, event.payload.position.y);
          updateDragPosition(x, y);
        } else if (type === "drop") {
          const { x, y } = toLogical(event.payload.position.x, event.payload.position.y);
          updateDragPosition(x, y);

          // Check if we're dropping onto a terminal — if so, write paths
          // directly into the PTY and skip the DropZone system entirely.
          // Use raw physical coords and compare against group rects in physical
          // space to avoid DPR rounding issues with elementFromPoint.
          const filePaths = event.payload.paths;
          if (filePaths.length > 0) {
            const groupEls = document.querySelectorAll<HTMLElement>("[data-group-id]");
            let bestGroup: HTMLElement | null = null;
            let bestArea = Infinity;
            for (const el of groupEls) {
              const rect = el.getBoundingClientRect();
              if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
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
                const activePane = grp?.panes.find((p) => p.id === grp.activePaneId);
                if (activePane?.ptyId && (activePane.type === "terminal" || activePane.type === "claude")) {
                  const escaped = filePaths.map((p: string) => p.includes(" ") ? `'${p}'` : p).join(" ");
                  api.writePty(activePane.ptyId, Array.from(new TextEncoder().encode(escaped)));
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
        if (pane?.ptyId && (pane.type === "claude" || pane.type === "terminal")) {
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

        // In product mode, toggle the shell panel
        const mode = s.workspaceModes[wsId];
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
            (p) => p.id === group.activePaneId
          );
          const cwd =
            activePane?.cwd || s.getActivePath(wsId) || undefined;

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
        const rootVSplit = root.type === "split" && root.direction === "vertical"
          ? root as Extract<LayoutNode, { type: "split" }>
          : null;

        if (isCollapsed) {
          // Collapsed → expand to golden ratio
          if (rootVSplit) {
            // Repopulate empty bottom groups with a terminal
            const bottomGroupId = findFirstGroupInSubtree(rootVSplit.children[1]);
            const bottomGroup = bottomGroupId ? layout.groups[bottomGroupId] : null;
            if (bottomGroupId && bottomGroup && bottomGroup.panes.length === 0) {
              const activeGroupId = s.activeGroupIds[wsId];
              const activeGroup = activeGroupId ? layout.groups[activeGroupId] : null;
              const activePane = activeGroup?.panes.find(
                (p) => p.id === activeGroup.activePaneId
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
              bottomPanelCollapsed: { ...s.bottomPanelCollapsed, [wsId]: false },
              layouts: { ...s.layouts, [wsId]: { ...layout, root: newRoot } },
            });

            // Focus the bottom terminal
            const focusGroupId = findFirstGroupInSubtree(rootVSplit.children[1]);
            if (focusGroupId) {
              setTimeout(() => {
                window.dispatchEvent(
                  new CustomEvent("rally-focus-group", { detail: focusGroupId }),
                );
              }, 50);
            }
          }
        } else if (rootVSplit) {
          const isAtGolden = Math.abs(rootVSplit.ratio - DEFAULT_BOTTOM_RATIO) < 0.02;
          if (isAtGolden) {
            // At golden ratio → fully collapse
            s.toggleBottomPanel(wsId);
          } else {
            // Custom size → snap to golden ratio
            const newRoot = replaceNode(layout.root, rootVSplit.id, {
              ...rootVSplit,
              ratio: DEFAULT_BOTTOM_RATIO,
            });
            useWorkspaceStore.setState({
              layouts: { ...s.layouts, [wsId]: { ...layout, root: newRoot } },
            });
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
      // Cmd+E: toggle file explorer
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        if (fileExplorerCollapsed) {
          setExplorerView("files");
          setFileExplorerCollapsed(false);
        } else {
          setFileExplorerCollapsed(true);
        }
      }
      // Cmd+P: toggle quick open
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
          const targetGroupId = findNeighborGroup(layout.root, activeGroupId, direction);
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
      const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === detail.workspaceId);
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
          140,
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
        resizingRef.current = false;
        cancelAnimationFrame(raf);
        preferredExplorerWidthRef.current = finalWidth;
        setFileExplorerWidth(finalWidth);
        localStorage.setItem(fileExplorerWidthKey, String(finalWidth));
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

  const clearHoverTimer = useCallback(() => {
    if (hoverCloseTimerRef.current) {
      clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  }, []);

  const handleWorkspacesHoverEnter = useCallback(() => {
    clearHoverTimer();
    setWsHoverAnim((prev) => prev === "out" ? null : prev); // cancel slide-out, snap visible
    // Already showing workspaces via click (not hover) — don't interfere
    if (!fileExplorerCollapsed && explorerView === "workspaces" && !workspacesHoverRef.current) {
      return;
    }
    if (!workspacesHoverRef.current) {
      preHoverRef.current = { collapsed: fileExplorerCollapsed, view: explorerView };
      workspacesHoverRef.current = true;
      setWsHoverAnim("in");
      setExplorerView("workspaces");
      setFileExplorerCollapsed(false);
    }
  }, [fileExplorerCollapsed, explorerView, clearHoverTimer]);

  const handleWorkspacesHoverLeave = useCallback(() => {
    if (!workspacesHoverRef.current) return;
    hoverCloseTimerRef.current = setTimeout(() => {
      if (!workspacesHoverRef.current) return;
      // Start slide-out animation
      setWsHoverAnim("out");
      hoverCloseTimerRef.current = setTimeout(() => {
        hoverCloseTimerRef.current = null;
        if (!workspacesHoverRef.current) return;
        setWsHoverAnim(null);
        const prev = preHoverRef.current;
        if (prev) {
          setFileExplorerCollapsed(prev.collapsed);
          setExplorerView(prev.view as typeof explorerView);
        } else {
          setFileExplorerCollapsed(true);
        }
        workspacesHoverRef.current = false;
        preHoverRef.current = null;
      }, 90);
    }, 100);
  }, []);

  return (
    <div style={styles.app}>
      <div
        data-tauri-drag-region
        style={styles.titlebar}
        onMouseDown={handleDrag}
      >
        <div style={styles.titlebarLeft}>
          {activeWorkspaceId && (
            <button
              className="activity-btn"
              style={styles.titlebarModeBtn}
              onClick={() => {
                const newMode = isProductMode ? "dev" as const : "product" as const;
                setWorkspaceMode(activeWorkspaceId, newMode);
              }}
              title={isProductMode ? "Switch to dev mode" : "Switch to product mode"}
            >
              {isProductMode ? "PRD" : "DEV"}
            </button>
          )}
        </div>
        <span style={styles.titleText}>{activeWorkspaceName}</span>
      </div>
      <div style={{ ...styles.body, zoom: zoomLevel }}>
        <div style={styles.activityBar}>
          {(
            [
              {
                view: "workspaces" as const,
                title: "Workspaces",
                icon: (active: boolean) => (
                  <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                    <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.2" stroke={active ? "var(--text-primary)" : "var(--text-secondary)"} strokeWidth="1.0" />
                    <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.2" stroke={active ? "var(--text-primary)" : "var(--text-secondary)"} strokeWidth="1.0" />
                    <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.2" stroke={active ? "var(--text-primary)" : "var(--text-secondary)"} strokeWidth="1.0" />
                    <rect x="9" y="9" width="5.5" height="5.5" rx="1.2" stroke={active ? "var(--text-primary)" : "var(--text-secondary)"} strokeWidth="1.0" />
                  </svg>
                ),
              },
              {
                view: "files" as const,
                title: "Files",
                icon: (active: boolean) => (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill={active ? "var(--text-primary)" : "var(--text-secondary)"}>
                    <path d="M17.5 0H8.5L7 1.5V6H2.5L1 7.5V22.5699L2.5 24H14.5699L16 22.5699V18H20.7L22 16.5699V4.5L17.5 0ZM17.5 2.12L19.88 4.5H17.5V2.12ZM14.5 22.5H2.5V7.5H7V16.5699L8.5 18H14.5V22.5ZM20.5 16.5H8.5V1.5H16V6H20.5V16.5Z" />
                  </svg>
                ),
              },
              {
                view: "search" as const,
                title: "Search",
                icon: (active: boolean) => (
                  <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                    <circle cx="7" cy="7" r="4.5" stroke={active ? "var(--text-primary)" : "var(--text-secondary)"} strokeWidth="1.0" />
                    <line x1="10.5" y1="10.5" x2="14" y2="14" stroke={active ? "var(--text-primary)" : "var(--text-secondary)"} strokeWidth="1.0" strokeLinecap="round" />
                  </svg>
                ),
              },
              {
                view: "claude" as const,
                title: "Claude config",
                icon: (active: boolean) => (
                  <svg
                    width="17"
                    height="17"
                    viewBox="0 0 24 24"
                    fill={active ? "var(--text-primary)" : "var(--text-secondary)"}
                    style={{ opacity: active ? 1 : 0.85 }}
                    aria-hidden="true"
                  >
                    <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" />
                  </svg>
                ),
              },
              {
                view: "scripts" as const,
                title: "Rally scripts",
                icon: (active: boolean) => (
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path d="M2 3L6.5 8L2 13" stroke={active ? "var(--text-primary)" : "var(--text-secondary)"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.3" />
                    <path d="M4.5 3L9 8L4.5 13" stroke={active ? "var(--text-primary)" : "var(--text-secondary)"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
                    <path d="M7 3L11.5 8L7 13" stroke={active ? "var(--text-primary)" : "var(--text-secondary)"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ),
              },
            ] as { view: typeof explorerView; title: string; icon: (active: boolean) => React.ReactNode }[]
          ).map(({ view, title, icon }) => {
            const isActive = !fileExplorerCollapsed && explorerView === view;
            return (
              <button
                key={view}
                className={`activity-btn${isActive ? " activity-btn-active" : ""}`}
                style={styles.activityBtn}
                onClick={() => {
                  if (view === "workspaces") return;
                  autoCollapsedRef.current = false; // User-initiated toggle clears auto-collapse
                  if (isActive) {
                    setFileExplorerCollapsed(true);
                  } else {
                    setExplorerView(view);
                    if (fileExplorerCollapsed) {
                      setFileExplorerCollapsed(false);
                    }
                  }
                }}
                onMouseEnter={view === "workspaces" ? handleWorkspacesHoverEnter : undefined}
                onMouseLeave={view === "workspaces" ? handleWorkspacesHoverLeave : undefined}
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
        {!fileExplorerCollapsed && (() => {
          const isHoverOverlay = wsHoverAnim !== null && preHoverRef.current?.collapsed === true;
          return (
          <div
            style={{
              display: "flex",
              flexShrink: 0,
              ...(isHoverOverlay ? {
                position: "absolute" as const,
                top: 0,
                left: 47,
                bottom: 0,
                zIndex: 20,
                background: "var(--bg-surface)",
                boxShadow: "4px 0 12px rgba(0,0,0,0.3)",
              } : {}),
              ...(wsHoverAnim === "in" ? { animation: "wsHoverSlideIn 160ms ease-out" } : {}),
              ...(wsHoverAnim === "out" ? { animation: "wsHoverSlideOut 90ms ease-in forwards" } : {}),
            }}
            onMouseEnter={explorerView === "workspaces" ? handleWorkspacesHoverEnter : undefined}
            onMouseLeave={explorerView === "workspaces" ? handleWorkspacesHoverLeave : undefined}
          >
            <div
              ref={explorerRef}
              style={{
                width: fileExplorerWidth,
                minWidth: fileExplorerWidth,
                flexShrink: 0,
              }}
            >
              {explorerView === "workspaces" && (
                <WorkspacePicker
                  onSelect={(id) => {
                    setActiveWorkspace(id);
                    setExplorerView("files");
                    clearHoverTimer();
                    workspacesHoverRef.current = false;
                    preHoverRef.current = null;
                    setWsHoverAnim(null);
                  }}
                />
              )}
              <div style={{ display: explorerView === "search" ? undefined : "none", height: "100%" }}>
                <SearchPanel
                  onCollapse={() => setFileExplorerCollapsed(true)}
                  flushLeft
                />
              </div>
              {explorerView === "claude" && <GlobalConfigExplorer />}
              {explorerView === "scripts" && <ScriptEditor />}
              <div style={{ display: explorerView === "files" ? undefined : "none", height: "100%" }}>
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
          );
        })()}
        <div style={styles.main}>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", position: "relative" }}>
            {activeWorkspaceId && activeRootPath && (
              <div style={{ display: isProductMode ? "flex" : "none", flex: 1, flexDirection: "column" as const, minWidth: 0, minHeight: 0 }}>
                <ProductChatPanel
                  rootPath={activeRootPath}
                  workspaceId={activeWorkspaceId}
                />
              </div>
            )}
            <div style={{ display: isProductMode ? "none" : "flex", flex: 1, flexDirection: "column" as const, minWidth: 0, minHeight: 0, position: "relative" as const }}>
              <PaneLayout />
              <BuildStatusDrawer />
            </div>
            <BuildStatusBar />
          </div>
        </div>
        <UnifiedGitPanel />
      </div>
      <style>{`
        @keyframes wsHoverSlideIn {
          from { transform: translateX(-14px); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        @keyframes wsHoverSlideOut {
          from { transform: translateX(0); opacity: 1; }
          to { transform: translateX(-14px); opacity: 0; }
        }
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
      <ShipStatusPill />
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
        <path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  if (t === "dimmed")
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.5" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ThemeCycleButton() {
  const theme = useWorkspaceStore((s) => s.theme);
  const setTheme = useWorkspaceStore((s) => s.setTheme);
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  // Fixed order: light (top), dimmed (middle), dark (bottom)
  const ordered: ThemeName[] = ["light", "dimmed", "dark"];

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const btnStyle: React.CSSProperties = {
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
  };

  // Split into: items above the current theme, and items below
  const currentIdx = ordered.indexOf(theme);
  const above = ordered.slice(0, currentIdx);
  const below = ordered.slice(currentIdx + 1);

  return (
    <div ref={ref} style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 4 }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          overflow: "hidden",
          maxHeight: open ? above.length * 32 : 0,
          transition: "max-height 0.2s ease",
        }}
      >
        {above.map((t) => (
          <button
            key={t}
            className="activity-btn"
            style={btnStyle}
            onClick={() => { setTheme(t); setOpen(false); }}
            title={t.charAt(0).toUpperCase() + t.slice(1)}
          >
            <ThemeIcon t={t} />
          </button>
        ))}
      </div>
      <button
        className="activity-btn"
        style={{ ...btnStyle, ...(open ? { color: "var(--text-primary)" } : {}) }}
        onClick={() => setOpen(!open)}
        title="Theme"
      >
        <ThemeIcon t={theme} />
      </button>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          overflow: "hidden",
          maxHeight: open ? below.length * 32 : 0,
          transition: "max-height 0.2s ease",
        }}
      >
        {below.map((t) => (
          <button
            key={t}
            className="activity-btn"
            style={btnStyle}
            onClick={() => { setTheme(t); setOpen(false); }}
            title={t.charAt(0).toUpperCase() + t.slice(1)}
          >
            <ThemeIcon t={t} />
          </button>
        ))}
      </div>
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
    background: "var(--bg-app)",
  },
  titlebar: {
    height: 34,
    minHeight: 34,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderBottom: "1px solid var(--border)",
    userSelect: "none",
    position: "relative",
    paddingLeft: 70,
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
  titlebarModeBtn: {
    background: "none",
    border: "1px solid var(--border-subtle)",
    cursor: "pointer",
    padding: "1px 6px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
    fontSize: 10,
    fontWeight: 600,
    color: "var(--text-secondary)",
    letterSpacing: "0.04em",
    lineHeight: "16px",
  },
  titleText: {
    fontSize: 13,
    fontWeight: 700,
    color: "var(--text-primary)",
    letterSpacing: "0.01em",
    pointerEvents: "none" as const,
  },
  body: {
    flex: 1,
    display: "flex",
    minHeight: 0,
    position: "relative",
    overflow: "hidden",
  },
  activityBar: {
    width: 46,
    minWidth: 46,
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
    background: "linear-gradient(to bottom, var(--bg-surface) 28px, var(--bg-elevated) 28px, var(--bg-elevated) 29px, var(--bg-surface) 29px)",
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
