import React, { useState, useEffect, useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Sidebar } from "./components/Sidebar";
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
import QuickOpen from "./components/QuickOpen";

export function App() {
  const windowLabel = getCurrentWindow().label;
  const initialWorkspaceId = new URLSearchParams(window.location.search).get(
    "workspaceId",
  );
  const forceNoWorkspaceSelection =
    new URLSearchParams(window.location.search).get("blankWorkspace") === "1";
  const BACKGROUND_WORK_DEFER_MS = 2500;
  const panelCollapsedKey = `rally:panelCollapsed:${windowLabel}`;
  const fileExplorerCollapsedKey = `rally:fileExplorerCollapsed:${windowLabel}`;
  const sidebarWidthKey = `rally:sidebarWidth:${windowLabel}`;
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
  const pollShipSignals = useWorkspaceStore((s) => s.pollShipSignals);
  const fetchAllRepos = useWorkspaceStore((s) => s.fetchAllRepos);
  const activeWorkspaceName = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    return ws?.name ?? "Rally";
  });

  const [panelCollapsed, setPanelCollapsed] = useState(
    () => localStorage.getItem(panelCollapsedKey) === "true",
  );
  const [fileExplorerCollapsed, setFileExplorerCollapsed] = useState(
    () => localStorage.getItem(fileExplorerCollapsedKey) === "true",
  );
  const [zoomLevel, setZoomLevel] = useState(() => {
    const saved = localStorage.getItem("rally:zoomLevel");
    return saved ? Number(saved) : 1.0;
  });
  const [explorerView, setExplorerView] = useState<
    "files" | "search" | "claude" | "scripts"
  >("files");
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const [newTerminalCwdRequest, setNewTerminalCwdRequest] =
    useState<RequestNewTerminalCwdDetail | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(sidebarWidthKey);
    return saved ? Number(saved) : 220;
  });
  const [fileExplorerWidth, setFileExplorerWidth] = useState(() => {
    const saved = localStorage.getItem(fileExplorerWidthKey);
    return saved ? Number(saved) : 220;
  });
  useEffect(() => {
    localStorage.setItem(panelCollapsedKey, String(panelCollapsed));
  }, [panelCollapsed, panelCollapsedKey]);
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
  const sidebarRef = useRef<HTMLDivElement>(null);
  const explorerRef = useRef<HTMLDivElement>(null);
  const autoCollapsedSidebarRef = useRef(false);
  // The user's preferred explorer width (set by drag resize or initial load).
  // When the window is too narrow we shrink below this, and restore when space returns.
  const preferredExplorerWidthRef = useRef(fileExplorerWidth);

  // Auto-shrink explorer (and collapse sidebar as last resort) to keep main area usable
  const MIN_MAIN_WIDTH = 600;
  const MIN_EXPLORER_WIDTH = 120;
  const ACTIVITY_BAR_WIDTH = 46;
  const RESIZE_HANDLE_WIDTH = 6;
  useEffect(() => {
    const checkWidth = () => {
      if (resizingRef.current) return;
      const w = window.innerWidth;
      const sidebarSpace = panelCollapsed
        ? 0
        : sidebarWidth + RESIZE_HANDLE_WIDTH;
      const explorerSpace = fileExplorerCollapsed
        ? 0
        : fileExplorerWidth + RESIZE_HANDLE_WIDTH;
      const mainWidth = w - ACTIVITY_BAR_WIDTH - sidebarSpace - explorerSpace;

      if (mainWidth < MIN_MAIN_WIDTH && !fileExplorerCollapsed) {
        // Shrink explorer to fit
        const available =
          w -
          ACTIVITY_BAR_WIDTH -
          sidebarSpace -
          RESIZE_HANDLE_WIDTH -
          MIN_MAIN_WIDTH;
        if (available >= MIN_EXPLORER_WIDTH) {
          setFileExplorerWidth(available);
        } else {
          // Explorer can't shrink enough — collapse sidebar instead
          if (!panelCollapsed) {
            autoCollapsedSidebarRef.current = true;
            setPanelCollapsed(true);
          } else {
            // Both squeezed — just clamp explorer to minimum
            setFileExplorerWidth(MIN_EXPLORER_WIDTH);
          }
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

      // Restore auto-collapsed sidebar when there's enough space
      if (autoCollapsedSidebarRef.current && panelCollapsed) {
        const withSidebar =
          w -
          ACTIVITY_BAR_WIDTH -
          (sidebarWidth + RESIZE_HANDLE_WIDTH) -
          explorerSpace;
        if (withSidebar >= MIN_MAIN_WIDTH) {
          autoCollapsedSidebarRef.current = false;
          setPanelCollapsed(false);
        }
      }
    };
    window.addEventListener("resize", checkWidth);
    checkWidth();
    return () => window.removeEventListener("resize", checkWidth);
  }, [panelCollapsed, fileExplorerCollapsed, sidebarWidth, fileExplorerWidth]);

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
    }, 20000);
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

    listen("rally-menu-new-workspace", () => {
      autoCollapsedSidebarRef.current = false;
      setPanelCollapsed(false);
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
      unlistenNewWorkspace?.();
      unlistenAddFolder?.();
      unlistenNewWindow?.();
      unlistenOpenCurrentInNewWindow?.();
      unlistenWorkspacesUpdated?.();
    };
  }, [loadWorkspaces, forceNoWorkspaceSelection]);

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

        if (root.type !== "split" || root.direction !== "vertical") return;
        const storageKey = `rally:bottomPanelRatio:${wsId}`;
        const isCollapsed = root.ratio >= 0.79;

        // When expanding, check if the bottom group is empty (was closed) — repopulate it
        if (isCollapsed) {
          const bottomGroupId = findFirstGroupInSubtree(root.children[1]);
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

        const newRatio = isCollapsed
          ? Number(localStorage.getItem(storageKey)) || 0.5
          : (localStorage.setItem(storageKey, String(root.ratio)), 0.8);
        // Set ratio directly, bypassing updateSplitRatio's [0.15, 0.85] clamp
        const newRoot = replaceNode(root, root.id, {
          ...root,
          ratio: newRatio,
        });
        useWorkspaceStore.setState({
          layouts: { ...s.layouts, [wsId]: { ...layout, root: newRoot } },
        });

        // Focus the bottom terminal when expanding
        if (isCollapsed) {
          const focusGroupId = findFirstGroupInSubtree(root.children[1]);
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
      setQuickOpenVisible(false);
      setNewTerminalCwdRequest(detail);
    };

    window.addEventListener(REQUEST_NEW_TERMINAL_CWD_EVENT, handleRequest);
    return () => {
      window.removeEventListener(REQUEST_NEW_TERMINAL_CWD_EVENT, handleRequest);
    };
  }, []);

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

  const handleSidebarResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizingRef.current = true;
      const startX = e.clientX;
      const startWidth = sidebarWidth;
      let finalWidth = startWidth;
      let raf = 0;

      const onMouseMove = (ev: MouseEvent) => {
        if (!resizingRef.current) return;
        finalWidth = Math.max(
          120,
          Math.min(400, startWidth + (ev.clientX - startX)),
        );
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          if (sidebarRef.current) {
            sidebarRef.current.style.width = finalWidth + "px";
            sidebarRef.current.style.minWidth = finalWidth + "px";
          }
        });
      };
      const onMouseUp = () => {
        resizingRef.current = false;
        cancelAnimationFrame(raf);
        setSidebarWidth(finalWidth);
        localStorage.setItem(sidebarWidthKey, String(finalWidth));
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
    [sidebarWidth, sidebarWidthKey],
  );

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
        <button
          className="activity-btn"
          style={styles.titlebarToggle}
          onClick={() => {
            const allHidden = panelCollapsed && fileExplorerCollapsed;
            autoCollapsedSidebarRef.current = false;
            if (allHidden) {
              setPanelCollapsed(false);
              setFileExplorerCollapsed(false);
            } else {
              setPanelCollapsed(true);
              setFileExplorerCollapsed(true);
            }
          }}
          title={
            panelCollapsed && fileExplorerCollapsed
              ? "Show panels"
              : "Hide all panels"
          }
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <rect
              x="1.5"
              y="1.5"
              width="13"
              height="13"
              rx="2"
              stroke="#aaa"
              strokeWidth="1.3"
            />
            <line x1="7" y1="1" x2="7" y2="15" stroke="#aaa" strokeWidth="1.3" />
            {(!panelCollapsed || !fileExplorerCollapsed) && (
              <path
                d="M3.5 2C2.672 2 2 2.672 2 3.5V12.5C2 13.328 2.672 14 3.5 14H7V2H3.5Z"
                fill="#aaa"
              />
            )}
          </svg>
        </button>
        <button
          className="activity-btn"
          style={styles.titlebarWorkspacesBtn}
          onClick={() => {
            autoCollapsedSidebarRef.current = false;
            if (panelCollapsed) {
              const sidebarSpace = sidebarWidth + RESIZE_HANDLE_WIDTH;
              const explorerSpace = fileExplorerCollapsed
                ? 0
                : fileExplorerWidth + RESIZE_HANDLE_WIDTH;
              const mainAfterOpen =
                window.innerWidth -
                ACTIVITY_BAR_WIDTH -
                sidebarSpace -
                explorerSpace;
              if (mainAfterOpen < MIN_MAIN_WIDTH && !fileExplorerCollapsed) {
                setFileExplorerCollapsed(true);
              }
              setPanelCollapsed(false);
            } else {
              setPanelCollapsed(true);
            }
          }}
          title={panelCollapsed ? "Show workspaces" : "Hide workspaces"}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="2" y="4" width="12" height="10" rx="1.5" stroke={panelCollapsed ? "#aaa" : "#ddd"} strokeWidth="1.0" />
            <path d="M4 4V3a1.5 1.5 0 011.5-1.5h5A1.5 1.5 0 0112 3v1" stroke={panelCollapsed ? "#aaa" : "#ddd"} strokeWidth="1.0" />
          </svg>
        </button>
        <span style={styles.titleText}>{activeWorkspaceName}</span>
      </div>
      <div style={{ ...styles.body, zoom: zoomLevel }}>
        <div style={styles.activityBar}>
          {(
            [
              {
                view: "files" as const,
                title: "Files",
                icon: (active: boolean) => (
                  <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                    <rect x="5" y="1.5" width="9" height="10" rx="1.2" stroke={active ? "#ddd" : "#bbb"} strokeWidth="1.0" />
                    <rect x="2" y="4.5" width="9" height="10" rx="1.2" stroke={active ? "#ddd" : "#bbb"} strokeWidth="1.0" fill="#1a1a1a" />
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
            ] as const
          ).map(({ view, title, icon }) => {
            const isActive = !fileExplorerCollapsed && explorerView === view;
            return (
              <button
                key={view}
                className={`activity-btn${isActive ? " activity-btn-active" : ""}`}
                style={styles.activityBtn}
                onClick={() => {
                  if (isActive) {
                    setFileExplorerCollapsed(true);
                  } else {
                    setExplorerView(view);
                    if (fileExplorerCollapsed) {
                      const sidebarSpace = panelCollapsed
                        ? 0
                        : sidebarWidth + RESIZE_HANDLE_WIDTH;
                      const explorerSpace =
                        fileExplorerWidth + RESIZE_HANDLE_WIDTH;
                      const mainAfterOpen =
                        window.innerWidth -
                        ACTIVITY_BAR_WIDTH -
                        sidebarSpace -
                        explorerSpace;
                      if (mainAfterOpen < MIN_MAIN_WIDTH && !panelCollapsed) {
                        setPanelCollapsed(true);
                        autoCollapsedSidebarRef.current = false;
                      }
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
        </div>
        {!panelCollapsed && (
          <>
            <div
              ref={sidebarRef}
              style={{
                width: sidebarWidth,
                minWidth: sidebarWidth,
                flexShrink: 0,
                overflow: "hidden",
              }}
            >
              <Sidebar />
            </div>
            <div
              onMouseDown={handleSidebarResize}
              style={styles.sidebarResizeHandle}
            >
              <div style={styles.resizeLine} />
            </div>
          </>
        )}
        {!fileExplorerCollapsed && (
          <>
            <div
              ref={explorerRef}
              style={{
                width: fileExplorerWidth,
                minWidth: fileExplorerWidth,
                flexShrink: 0,
              }}
            >
              {explorerView === "search" ? (
                <SearchPanel
                  onCollapse={() => setFileExplorerCollapsed(true)}
                  flushLeft={panelCollapsed}
                />
              ) : explorerView === "claude" ? (
                <GlobalConfigExplorer />
              ) : explorerView === "scripts" ? (
                <ScriptEditor />
              ) : (
                <FileExplorer
                  onCollapse={() => setFileExplorerCollapsed(true)}
                  flushLeft={panelCollapsed}
                />
              )}
            </div>
            <div
              onMouseDown={handleExplorerResize}
              style={styles.explorerResizeHandle}
            >
              <div style={styles.resizeLine} />
            </div>
          </>
        )}
        <div style={styles.main}>
          <PaneLayout />
          <UnifiedGitPanel />
        </div>
      </div>
      <style>{`
        .syn-comment { color: #8b949e; font-style: italic; }
        .syn-string { color: #a5d6ff; }
        .syn-keyword { color: #ff7b72; }
        .syn-literal { color: #79c0ff; }
        .syn-number { color: #d2a8ff; }
        .hunk-action-btn:hover { background: rgba(255,255,255,0.1) !important; color: #eee !important; }
        .git-diff-overlay { scrollbar-gutter: stable; }
        .git-diff-overlay ::-webkit-scrollbar { width: 6px; height: 0; }
        .git-diff-overlay ::-webkit-scrollbar-track { background: transparent; }
        .git-diff-overlay ::-webkit-scrollbar-thumb { background: transparent; border-radius: 3px; transition: background 0.2s; }
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
  titlebarToggle: {
    position: "absolute",
    left: 70,
    top: "50%",
    transform: "translateY(-50%)",
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
  },
  titlebarWorkspacesBtn: {
    position: "absolute",
    left: 98,
    top: "50%",
    transform: "translateY(-50%)",
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
    color: "#d0d0d0",
    letterSpacing: "0.01em",
    pointerEvents: "none" as const,
  },
  body: {
    flex: 1,
    display: "flex",
    minHeight: 0,
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
    flexDirection: "column",
    minWidth: 0,
    position: "relative",
  },
  sidebarResizeHandle: {
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
