import React, { useState, useEffect, useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { FileExplorer } from "./components/FileExplorer";
import { GlobalConfigExplorer } from "./components/SettingsPanel";
import { ScriptEditor } from "./components/ScriptEditor";
import { PaneLayout } from "./components/PaneLayout";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { api } from "./lib/tauri";
import { findFirstGroupInSubtree, findNeighborGroup, replaceNode, type LayoutNode, type NavigationDirection, type Pane } from "./lib/types";
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
import QuickOpen from "./components/QuickOpen";

function WorkspacePicker({ onSelect }: { onSelect: (id: string) => void }) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#161616" }}>
      <div style={{ padding: "8px 12px", fontSize: 11, fontWeight: 700, color: "#e0e0e0", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>
        Workspaces
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {workspaces.map((ws) => {
          const isActive = ws.id === activeWorkspaceId;
          return (
            <button
              key={ws.id}
              className="sidebar-btn"
              onClick={() => onSelect(ws.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "8px 12px",
                border: "none",
                background: isActive ? "rgba(255,255,255,0.08)" : "transparent",
                color: isActive ? "#fff" : "#ccc",
                fontSize: 13,
                fontWeight: isActive ? 600 : 500,
                cursor: "pointer",
                textAlign: "left" as const,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                <rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke={isActive ? "#ddd" : "#999"} strokeWidth="1.0" />
                <path d="M1.5 5.5h13" stroke={isActive ? "#ddd" : "#999"} strokeWidth="1.0" />
              </svg>
              {ws.name}
            </button>
          );
        })}
      </div>
    </div>
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
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    return ws?.paths[0] ?? "";
  });
  const gitPanelOpen = useWorkspaceStore((s) => s.unifiedGitPanelOpen);

  const [fileExplorerCollapsed, setFileExplorerCollapsed] = useState(
    () => localStorage.getItem(fileExplorerCollapsedKey) === "true",
  );
  const [zoomLevel, setZoomLevel] = useState(() => {
    const saved = localStorage.getItem("rally:zoomLevel");
    return saved ? Number(saved) : 1.0;
  });
  const [explorerView, setExplorerView] = useState<
    "files" | "search" | "claude" | "scripts" | "workspaces"
  >("files");
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

  // Auto-shrink explorer (and collapse sidebar as last resort) to keep main area usable
  const MIN_MAIN_WIDTH = 600;
  const MIN_EXPLORER_WIDTH = 120;
  const ACTIVITY_BAR_WIDTH = 46;
  const RESIZE_HANDLE_WIDTH = 6;
  useEffect(() => {
    const checkWidth = () => {
      if (resizingRef.current) return;
      const w = window.innerWidth;
      const explorerSpace = fileExplorerCollapsed
        ? 0
        : fileExplorerWidth + RESIZE_HANDLE_WIDTH;
      const mainWidth = w - ACTIVITY_BAR_WIDTH - explorerSpace;

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
  }, [refreshGitStatusForPath, shouldDeferBackgroundWork]);

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

    const openWindow = (opts?: {
      workspaceId?: string;
      blankWorkspace?: boolean;
    }) => {
      const label = `rally-${crypto.randomUUID()}`;
      const params = new URLSearchParams();
      if (opts?.workspaceId) {
        params.set("workspaceId", opts.workspaceId);
      } else if (opts?.blankWorkspace) {
        params.set("blankWorkspace", "1");
      }
      const query = params.toString();
      const url = query ? `/?${query}` : "/";

      const w = new WebviewWindow(label, {
        url,
        title: "Rally",
        width: 1400,
        height: 900,
        resizable: true,
        fullscreen: false,
        decorations: true,
        titleBarStyle: "overlay",
        hiddenTitle: true,
      });

      w.once("tauri://error", (e) => {
        const payload = e?.payload;
        const detail =
          typeof payload === "string"
            ? payload
            : payload && typeof payload === "object" && "message" in payload
              ? String((payload as { message?: unknown }).message ?? "")
              : "";
        console.error("Failed to create window:", e);
        addToast({
          type: "warning",
          title: "Window open failed",
          message: detail
            ? `Could not open a new window. ${detail}`
            : "Could not open a new window.",
        });
      });
    };

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
        document.dispatchEvent(new Event("rally-open-add-workspace"));
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
      // Respect product mode — don't switch away from product explorer
      const s = useWorkspaceStore.getState();
      const wsId = s.activeWorkspaceId;
      const mode = wsId ? s.workspaceModes[wsId] ?? "dev" : "dev";
      setExplorerView("files");
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
      // Ctrl+` toggles the bottom panel (bypasses ratio clamp)
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
          const splitId = crypto.randomUUID();
          const splitNode: LayoutNode = {
            type: "split",
            id: splitId,
            direction: "vertical",
            children: [
              { type: "group", groupId },
              { type: "group", groupId: newGroupId },
            ],
            ratio: 0.8,
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

          // Animate: slide up from collapsed (0.8) to target ratio
          requestAnimationFrame(() => {
            const targetRatio = 0.5;
            const storageKey = `rally:bottomPanelRatio:${wsId}`;
            localStorage.setItem(storageKey, String(targetRatio));
            const cur = useWorkspaceStore.getState();
            const curLayout = cur.layouts[wsId];
            if (!curLayout) return;
            const animRoot = replaceNode(curLayout.root, splitId, {
              ...splitNode,
              ratio: targetRatio,
            });
            useWorkspaceStore.setState({
              layouts: {
                ...cur.layouts,
                [wsId]: { ...curLayout, root: animRoot },
              },
            });
            // Focus the new bottom terminal after it mounts
            setTimeout(() => {
              window.dispatchEvent(
                new CustomEvent("rally-focus-group", { detail: newGroupId }),
              );
            }, 50);
          });
          return;
        }

        // Collect all vertical splits in the tree (handles both root-level
        // vertical splits and vertical splits nested inside horizontal columns)
        function collectVerticalSplits(node: LayoutNode): Array<Extract<LayoutNode, { type: "split" }>> {
          if (node.type === "group") return [];
          if (node.direction === "vertical") return [node];
          return [
            ...collectVerticalSplits(node.children[0]),
            ...collectVerticalSplits(node.children[1]),
          ];
        }
        const vertSplits = root.type === "split" && root.direction === "vertical"
          ? [root as Extract<LayoutNode, { type: "split" }>]
          : collectVerticalSplits(root);
        if (vertSplits.length === 0) return;

        const storageKey = `rally:bottomPanelRatio:${wsId}`;
        const isCollapsed = vertSplits.every((vs) => vs.ratio >= 0.79);

        // When expanding, repopulate any empty bottom groups with a terminal
        if (isCollapsed) {
          for (const vs of vertSplits) {
            const bottomGroupId = findFirstGroupInSubtree(vs.children[1]);
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
          }
        }

        const newRatio = isCollapsed
          ? Number(localStorage.getItem(storageKey)) || 0.5
          : (localStorage.setItem(storageKey, String(vertSplits[0].ratio)), 0.8);
        // Update all vertical splits to the same ratio
        let newRoot = layout.root;
        for (const vs of vertSplits) {
          newRoot = replaceNode(newRoot, vs.id, { ...vs, ratio: newRatio });
        }
        useWorkspaceStore.setState({
          layouts: { ...s.layouts, [wsId]: { ...layout, root: newRoot } },
        });

        // Focus the bottom terminal when expanding
        if (isCollapsed) {
          const focusGroupId = findFirstGroupInSubtree(vertSplits[0].children[1]);
          if (focusGroupId) {
            setTimeout(() => {
              window.dispatchEvent(
                new CustomEvent("rally-focus-group", { detail: focusGroupId }),
              );
            }, 50);
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
                    <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.2" stroke={active ? "#ddd" : "#bbb"} strokeWidth="1.0" />
                    <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.2" stroke={active ? "#ddd" : "#bbb"} strokeWidth="1.0" />
                    <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.2" stroke={active ? "#ddd" : "#bbb"} strokeWidth="1.0" />
                    <rect x="9" y="9" width="5.5" height="5.5" rx="1.2" stroke={active ? "#ddd" : "#bbb"} strokeWidth="1.0" />
                  </svg>
                ),
              },
              {
                view: "files" as const,
                title: "Files",
                icon: (active: boolean) => (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill={active ? "#ddd" : "#bbb"}>
                    <path d="M17.5 0H8.5L7 1.5V6H2.5L1 7.5V22.5699L2.5 24H14.5699L16 22.5699V18H20.7L22 16.5699V4.5L17.5 0ZM17.5 2.12L19.88 4.5H17.5V2.12ZM14.5 22.5H2.5V7.5H7V16.5699L8.5 18H14.5V22.5ZM20.5 16.5H8.5V1.5H16V6H20.5V16.5Z" />
                  </svg>
                ),
              },
              {
                view: "search" as const,
                title: "Search",
                icon: (active: boolean) => (
                  <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                    <circle cx="7" cy="7" r="4.5" stroke={active ? "#ddd" : "#bbb"} strokeWidth="1.0" />
                    <line x1="10.5" y1="10.5" x2="14" y2="14" stroke={active ? "#ddd" : "#bbb"} strokeWidth="1.0" strokeLinecap="round" />
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
                    fill={active ? "#ddd" : "#bbb"}
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
                    <path d="M2 3L6.5 8L2 13" stroke={active ? "#ddd" : "#bbb"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.3" />
                    <path d="M4.5 3L9 8L4.5 13" stroke={active ? "#ddd" : "#bbb"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
                    <path d="M7 3L11.5 8L7 13" stroke={active ? "#ddd" : "#bbb"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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
        </div>
        {!fileExplorerCollapsed && (
          <div
            style={{
              display: "flex",
              flexShrink: 0,
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
              {explorerView === "search" && (
                <SearchPanel
                  onCollapse={() => setFileExplorerCollapsed(true)}
                  flushLeft
                />
              )}
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
            </div>
          </div>
        )}
        <div style={styles.main}>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", position: "relative" }}>
            {isProductMode && activeWorkspaceId && activeRootPath ? (
              <ProductChatPanel
                rootPath={activeRootPath}
                workspaceId={activeWorkspaceId}
              />
            ) : (
              <PaneLayout />
            )}
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
        .repo-action-btn:hover { background: rgba(255,255,255,0.1) !important; }
        .repo-header-row:hover .repo-refresh-btn { opacity: 1 !important; }
        .hunk-action-btn:hover { background: rgba(255,255,255,0.1) !important; color: #eee !important; }
        .file-list-item:hover { background: rgba(255,255,255,0.05) !important; }
        .file-list-item-selected { background: rgba(255,255,255,0.08) !important; }
        .git-diff-overlay { scrollbar-gutter: stable; }
        .git-diff-overlay ::-webkit-scrollbar { width: 6px; height: 0; }
        .git-diff-overlay ::-webkit-scrollbar-track { background: transparent; }
        .git-diff-overlay ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 3px; transition: background 0.2s; }
        .git-diff-overlay :hover > ::-webkit-scrollbar-thumb,
        .git-diff-overlay *:hover::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); }
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
    background: "#1a1a1a",
  },
  titlebar: {
    height: 34,
    minHeight: 34,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderBottom: "1px solid #2a2a2a",
    userSelect: "none",
    position: "relative",
    zIndex: 100,
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
    border: "1px solid rgba(255,255,255,0.15)",
    cursor: "pointer",
    padding: "1px 6px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
    fontSize: 10,
    fontWeight: 600,
    color: "#aaa",
    letterSpacing: "0.04em",
    lineHeight: "16px",
  },
  titleText: {
    fontSize: 13,
    fontWeight: 700,
    color: "#d0d0d0",
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
    background: "#1a1a1a",
    borderRight: "1px solid #2a2a2a",
    paddingTop: 0,
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
    width: 8,
    minWidth: 8,
    cursor: "col-resize",
    background: "transparent",
    flexShrink: 0,
    zIndex: 10,
    display: "flex",
    alignItems: "stretch",
    justifyContent: "center",
  },
  resizeLine: {
    width: 1,
    background: "#2a2a2a",
    pointerEvents: "none" as const,
  },
};
