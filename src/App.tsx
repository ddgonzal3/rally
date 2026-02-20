import React, { useState, useEffect, useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "./components/Sidebar";
import { FileExplorer } from "./components/FileExplorer";
import { PaneLayout } from "./components/PaneLayout";
import { GitActions } from "./components/GitActions";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { startExternalFileDrag, updateDragPosition, endDrag } from "./lib/dragContext";
import { FILE_DROP_COMMIT_EVENT } from "./components/DropZoneOverlay";

export function App() {
  const { loadWorkspaces, refreshAllGitStatuses, refreshAllPrStatuses, pollShipSignals } =
    useWorkspaceStore();
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [fileExplorerCollapsed, setFileExplorerCollapsed] = useState(false);
  const [fileExplorerWidth, setFileExplorerWidth] = useState(220);
  const resizingRef = useRef(false);

  useEffect(() => {
    loadWorkspaces().then(() => {
      refreshAllGitStatuses();
      refreshAllPrStatuses();
    });
    const gitInterval = setInterval(refreshAllGitStatuses, 10000);
    const prInterval = setInterval(refreshAllPrStatuses, 20000);
    const shipInterval = setInterval(pollShipSignals, 5000);
    return () => {
      clearInterval(gitInterval);
      clearInterval(prInterval);
      clearInterval(shipInterval);
    };
  }, []);

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

  const handleExplorerResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    const startX = e.clientX;
    const startWidth = fileExplorerWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const newWidth = Math.max(140, Math.min(500, startWidth + (ev.clientX - startX)));
      setFileExplorerWidth(newWidth);
    };
    const onMouseUp = () => {
      resizingRef.current = false;
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
        <span style={styles.titleText}>Playbench</span>
      </div>
      <div style={styles.body}>
        {!panelCollapsed && <Sidebar />}
        {!fileExplorerCollapsed && (
          <>
            <FileExplorer width={fileExplorerWidth} onCollapse={() => setFileExplorerCollapsed(true)} />
            <div
              onMouseDown={handleExplorerResize}
              style={styles.explorerResizeHandle}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "#555"; }}
              onMouseLeave={(e) => { if (!resizingRef.current) (e.currentTarget as HTMLDivElement).style.background = "#333"; }}
            />
          </>
        )}
        <div style={styles.main}>
          <PaneLayout />
          <GitActions />
        </div>
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
  explorerResizeHandle: {
    width: 1,
    minWidth: 1,
    cursor: "col-resize",
    background: "#333",
    transition: "background 0.15s",
    flexShrink: 0,
    zIndex: 10,
  },
};
