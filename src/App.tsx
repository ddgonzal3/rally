import React, { useState, useEffect, useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "./components/Sidebar";
import { FileExplorer } from "./components/FileExplorer";
import { PaneLayout } from "./components/PaneLayout";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { startExternalFileDrag, updateDragPosition, endDrag } from "./lib/dragContext";
import { FILE_DROP_COMMIT_EVENT } from "./components/DropZoneOverlay";
import { ToastContainer } from "./components/ToastContainer";
import { ShipStatusPill } from "./components/ShipStatusPill";

export function App() {
  // Individual selectors for action functions — prevents App from re-rendering
  // on every store data change (git/PR/ship polls, task output, etc.)
  const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces);
  const refreshAllGitStatuses = useWorkspaceStore((s) => s.refreshAllGitStatuses);
  const refreshAllPrStatuses = useWorkspaceStore((s) => s.refreshAllPrStatuses);
  const pollShipSignals = useWorkspaceStore((s) => s.pollShipSignals);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [fileExplorerCollapsed, setFileExplorerCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem("rally:sidebarWidth");
    return saved ? Number(saved) : 220;
  });
  const [fileExplorerWidth, setFileExplorerWidth] = useState(() => {
    const saved = localStorage.getItem("rally:fileExplorerWidth");
    return saved ? Number(saved) : 220;
  });
  const resizingRef = useRef(false);
  const gitRefreshInFlightRef = useRef(false);
  const prRefreshInFlightRef = useRef(false);
  const shipPollInFlightRef = useRef(false);
  const lastInteractionAtRef = useRef(Date.now());
  const sidebarRef = useRef<HTMLDivElement>(null);
  const explorerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const markInteraction = () => {
      lastInteractionAtRef.current = Date.now();
    };
    document.addEventListener("pointerdown", markInteraction, { passive: true });
    document.addEventListener("keydown", markInteraction, { passive: true });
    document.addEventListener("wheel", markInteraction, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", markInteraction);
      document.removeEventListener("keydown", markInteraction);
      document.removeEventListener("wheel", markInteraction);
    };
  }, []);

  const shouldDeferBackgroundWork = useCallback(() => {
    if (document.hidden) return true;
    return Date.now() - lastInteractionAtRef.current < 800;
  }, []);

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

    loadWorkspaces().then(async () => {
      if (cancelled) return;
      await Promise.all([runGitRefresh(true), runPrRefresh(true)]);
    });

    const gitInterval = setInterval(() => {
      void runGitRefresh();
    }, 10000);
    const prInterval = setInterval(() => {
      void runPrRefresh();
    }, 20000);
    const shipInterval = setInterval(() => {
      void runShipPoll();
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(gitInterval);
      clearInterval(prInterval);
      clearInterval(shipInterval);
    };
  }, [loadWorkspaces, runGitRefresh, runPrRefresh, runShipPoll]);

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
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "w") {
        e.preventDefault();
        const { activeWorkspaceId, closeActiveTab } = useWorkspaceStore.getState();
        if (activeWorkspaceId) {
          closeActiveTab(activeWorkspaceId);
        }
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
      localStorage.setItem("rally:sidebarWidth", String(finalWidth));
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [sidebarWidth]);

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
      localStorage.setItem("rally:fileExplorerWidth", String(finalWidth));
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [fileExplorerWidth]);

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
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
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
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M2 3h4l2 2h6v8H2V3z"
                stroke="#888" strokeWidth="1.2"
                fill={fileExplorerCollapsed ? "none" : "#888"}
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        <span style={styles.titleText}>Rally</span>
      </div>
      <div style={styles.body}>
        {!panelCollapsed && (
          <>
            <div ref={sidebarRef} style={{ width: sidebarWidth, minWidth: sidebarWidth, flexShrink: 0, overflow: "hidden" }}>
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
            <div ref={explorerRef} style={{ width: fileExplorerWidth, minWidth: fileExplorerWidth, flexShrink: 0 }}>
              <FileExplorer onCollapse={() => setFileExplorerCollapsed(true)} />
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
        </div>
      </div>
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
