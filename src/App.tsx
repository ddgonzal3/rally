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
import { findFirstGroupInSubtree, replaceNode } from "./lib/types";
import { startExternalFileDrag, updateDragPosition, endDrag } from "./lib/dragContext";
import { FILE_DROP_COMMIT_EVENT } from "./components/DropZoneOverlay";
import { ToastContainer, addToast } from "./components/ToastContainer";
import { ShipStatusPill } from "./components/ShipStatusPill";
import { GitDiffOverlay } from "./components/GitDiffOverlay";

export function App() {
  const windowLabel = getCurrentWindow().label;
  const initialWorkspaceId =
    new URLSearchParams(window.location.search).get("workspaceId");
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
  const refreshAllGitStatuses = useWorkspaceStore((s) => s.refreshAllGitStatuses);
  const refreshGitStatusForPath = useWorkspaceStore((s) => s.refreshGitStatusForPath);
  const refreshAllPrStatuses = useWorkspaceStore((s) => s.refreshAllPrStatuses);
  const pollShipSignals = useWorkspaceStore((s) => s.pollShipSignals);
  const [panelCollapsed, setPanelCollapsed] = useState(() =>
    localStorage.getItem(panelCollapsedKey) === "true",
  );
  const [fileExplorerCollapsed, setFileExplorerCollapsed] = useState(() =>
    localStorage.getItem(fileExplorerCollapsedKey) === "true",
  );
  const [sidebarView, setSidebarView] = useState<"workspaces" | "claude" | "scripts">("workspaces");
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
    localStorage.setItem(fileExplorerCollapsedKey, String(fileExplorerCollapsed));
  }, [fileExplorerCollapsed, fileExplorerCollapsedKey]);

  const resizingRef = useRef(false);
  const gitRefreshInFlightRef = useRef(false);
  const prRefreshInFlightRef = useRef(false);
  const shipPollInFlightRef = useRef(false);
  const lastInteractionAtRef = useRef(Date.now());
  const sidebarRef = useRef<HTMLDivElement>(null);
  const explorerRef = useRef<HTMLDivElement>(null);

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
    document.addEventListener("pointerdown", markInteraction, { passive: true });
    document.addEventListener("keydown", markInteraction, { passive: true });
    document.addEventListener("wheel", markInteraction, { passive: true });
    document.addEventListener("scroll", markInteraction, { passive: true, capture: true });
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

  const runGitRefresh = useCallback(async (force = false) => {
    if (gitRefreshInFlightRef.current) return;
    if (!force && shouldDeferBackgroundWork()) return;
    gitRefreshInFlightRef.current = true;
    try {
      await refreshAllGitStatuses();
    } finally {
      gitRefreshInFlightRef.current = false;
    }
  }, [refreshAllGitStatuses, shouldDeferBackgroundWork]);

  const runPrRefresh = useCallback(async (force = false) => {
    if (prRefreshInFlightRef.current) return;
    if (!force && shouldDeferBackgroundWork()) return;
    prRefreshInFlightRef.current = true;
    try {
      await refreshAllPrStatuses();
    } finally {
      prRefreshInFlightRef.current = false;
    }
  }, [refreshAllPrStatuses, shouldDeferBackgroundWork]);

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

  useEffect(() => {
    let cancelled = false;

    loadWorkspaces({ keepNullActive: forceNoWorkspaceSelection }).then(async () => {
      if (cancelled) return;
      await Promise.all([runGitRefresh(true), runPrRefresh(true)]);
    });

    const gitInterval = setInterval(() => {
      void runGitRefresh();
    }, 10000);
    const prInterval = setInterval(() => {
      void runPrRefresh();
    }, 5000);
    const shipInterval = setInterval(() => {
      void runShipPoll();
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(gitInterval);
      clearInterval(prInterval);
      clearInterval(shipInterval);
    };
  }, [
    loadWorkspaces,
    runGitRefresh,
    runPrRefresh,
    runShipPoll,
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
      .catch((e) => console.error("Failed to listen for git-changes-updated:", e));

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

    const openWindow = (opts?: { workspaceId?: string; blankWorkspace?: boolean }) => {
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

    appWin.onDragDropEvent((event) => {
      if (cancelled) return;
      const { activeWorkspaceId } = useWorkspaceStore.getState();
      if (!activeWorkspaceId) return;

      const { type } = event.payload;
      if (type === "enter") {
        // Tauri gives PhysicalPosition — convert to CSS pixels for getBoundingClientRect
        const x = event.payload.position.x / dpr;
        const y = event.payload.position.y / dpr;
        startExternalFileDrag(event.payload.paths, x, y);
      } else if (type === "over") {
        const x = event.payload.position.x / dpr;
        const y = event.payload.position.y / dpr;
        updateDragPosition(x, y);
      } else if (type === "drop") {
        const x = event.payload.position.x / dpr;
        const y = event.payload.position.y / dpr;
        updateDragPosition(x, y);
        // Dispatch custom event so DropZoneTargets can commit the file drop
        document.dispatchEvent(new Event(FILE_DROP_COMMIT_EVENT));
        setTimeout(() => endDrag(), 0);
      } else if (type === "leave") {
        endDrag();
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Cmd+W closes the active tab instead of the window
  // Cmd+/ splits the active panel to the right with a new terminal
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "w") {
        e.preventDefault();
        const { activeWorkspaceId, closeActiveTab } = useWorkspaceStore.getState();
        if (activeWorkspaceId) {
          closeActiveTab(activeWorkspaceId);
        }
      }
      // Ctrl+` toggles the bottom panel (bypasses ratio clamp)
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        const s = useWorkspaceStore.getState();
        const wsId = s.activeWorkspaceId;
        if (!wsId) return;
        const layout = s.getOrCreateLayout(wsId);
        const root = layout.root;
        if (root.type !== "split" || root.direction !== "vertical") return;
        const storageKey = `rally:bottomPanelRatio:${wsId}`;
        const isCollapsed = root.ratio >= 0.79;
        const newRatio = isCollapsed
          ? Number(localStorage.getItem(storageKey)) || 0.5
          : (localStorage.setItem(storageKey, String(root.ratio)), 0.8);
        // Set ratio directly, bypassing updateSplitRatio's [0.15, 0.85] clamp
        const newRoot = replaceNode(root, root.id, { ...root, ratio: newRatio });
        useWorkspaceStore.setState({
          layouts: { ...s.layouts, [wsId]: { ...layout, root: newRoot } },
        });
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
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const appWindow = getCurrentWindow();

  const handleSidebarResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    let finalWidth = startWidth;
    let raf = 0;

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      finalWidth = Math.max(120, Math.min(400, startWidth + (ev.clientX - startX)));
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
  }, [sidebarWidth, sidebarWidthKey]);

  const handleExplorerResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    const startX = e.clientX;
    const startWidth = fileExplorerWidth;
    let finalWidth = startWidth;
    let raf = 0;

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      finalWidth = Math.max(140, Math.min(500, startWidth + (ev.clientX - startX)));
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
  }, [fileExplorerWidth, fileExplorerWidthKey]);

  const handleDrag = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("button")) return;
      appWindow.startDragging();
    },
    [appWindow]
  );

  return (
    <div style={styles.app}>
      <div
        data-tauri-drag-region
        style={styles.titlebar}
        onMouseDown={handleDrag}
      >
        {/* Titlebar buttons — positioned right of traffic lights */}
        <div style={styles.titlebarBtns}>
          <button
            style={styles.panelToggle}
            onClick={() => setPanelCollapsed(!panelCollapsed)}
            title={panelCollapsed ? "Show sidebar" : "Hide sidebar"}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <rect
                x="1" y="2" width="14" height="12" rx="2"
                stroke="#888" strokeWidth="1.2" fill="none"
              />
              <rect
                x="1" y="2" width="5" height="12" rx="2"
                fill={panelCollapsed ? "none" : "#888"}
                stroke="#888" strokeWidth="1.2"
              />
            </svg>
          </button>
          <button
            style={styles.panelToggle}
            onClick={() => setFileExplorerCollapsed(!fileExplorerCollapsed)}
            title={fileExplorerCollapsed ? "Show files" : "Hide files"}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <rect x="5" y="1.5" width="9" height="10" rx="1.2" stroke="#888" strokeWidth="1.2" />
              <rect x="2" y="4.5" width="9" height="10" rx="1.2" stroke="#888" strokeWidth="1.2" fill="#1c1c1c" />
            </svg>
          </button>
          <button
            style={styles.panelToggle}
            onClick={() => {
              if (sidebarView === "claude") {
                setSidebarView("workspaces");
              } else {
                setSidebarView("claude");
                if (panelCollapsed) setPanelCollapsed(false);
              }
            }}
            title={sidebarView === "claude" ? "Show workspaces" : "Show Claude config"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill={sidebarView === "claude" ? "#aaa" : "#888"} aria-hidden="true">
              <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" />
            </svg>
          </button>
          <button
            style={styles.panelToggle}
            onClick={() => {
              if (sidebarView === "scripts") {
                setSidebarView("workspaces");
              } else {
                setSidebarView("scripts");
                if (panelCollapsed) setPanelCollapsed(false);
              }
            }}
            title={sidebarView === "scripts" ? "Show workspaces" : "Show Rally scripts"}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 2.5h10M3 5.5h7M3 8.5h9M3 11.5h6" stroke={sidebarView === "scripts" ? "#aaa" : "#888"} strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <span style={styles.titleText}>Rally</span>
      </div>
      <div style={styles.body}>
        {!panelCollapsed && (
          <>
            <div ref={sidebarRef} style={{ width: sidebarWidth, minWidth: sidebarWidth, flexShrink: 0, overflow: "hidden" }}>
              {sidebarView === "claude" ? <GlobalConfigExplorer /> : sidebarView === "scripts" ? <ScriptEditor /> : <Sidebar />}
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
            <div ref={explorerRef} style={{ width: fileExplorerWidth, minWidth: fileExplorerWidth, flexShrink: 0 }}>
              <FileExplorer onCollapse={() => setFileExplorerCollapsed(true)} flushLeft={panelCollapsed} />
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
          <GitDiffOverlay />
        </div>
      </div>
      <style>{`
        .syn-comment { color: #6a737d; font-style: italic; }
        .syn-string { color: #a5d6ff; }
        .syn-keyword { color: #ff7b72; }
        .syn-literal { color: #79c0ff; }
        .syn-number { color: #d2a8ff; }
        .git-diff-overlay { scrollbar-gutter: stable; }
        .git-diff-overlay ::-webkit-scrollbar { width: 6px; height: 0; }
        .git-diff-overlay ::-webkit-scrollbar-track { background: transparent; }
        .git-diff-overlay ::-webkit-scrollbar-thumb { background: transparent; border-radius: 3px; transition: background 0.2s; }
        .git-diff-overlay :hover > ::-webkit-scrollbar-thumb,
        .git-diff-overlay *:hover::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); }
        .git-diff-overlay *:hover::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
        .git-diff-overlay ::-webkit-scrollbar-corner { background: transparent; }
      `}</style>
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
    paddingLeft: 80,
  },
  titlebarBtns: {
    position: "absolute",
    left: 80,
    top: "50%",
    transform: "translateY(-50%)",
    display: "flex",
    alignItems: "center",
    gap: 2,
  },
  panelToggle: {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
    opacity: 0.7,
  },
  titleText: {
    fontSize: 13,
    fontWeight: 500,
    color: "#555",
    letterSpacing: "0.01em",
    pointerEvents: "none" as const,
  },
  body: {
    flex: 1,
    display: "flex",
    minHeight: 0,
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
