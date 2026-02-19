import React, { useState, useEffect, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "./components/Sidebar";
import { FileExplorer } from "./components/FileExplorer";
import { PaneLayout } from "./components/PaneLayout";
import { GitActions } from "./components/GitActions";
import { useWorkspaceStore } from "./stores/workspaceStore";

export function App() {
  const { loadWorkspaces, refreshAllGitStatuses } =
    useWorkspaceStore();
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [fileExplorerCollapsed, setFileExplorerCollapsed] = useState(false);

  useEffect(() => {
    loadWorkspaces().then(() => refreshAllGitStatuses());
    const interval = setInterval(refreshAllGitStatuses, 10000);
    return () => clearInterval(interval);
  }, []);

  const appWindow = getCurrentWindow();

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
          {!panelCollapsed && (
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
          )}
        </div>
        <span style={styles.titleText}>Workbench</span>
      </div>
      <div style={styles.body}>
        {panelCollapsed ? (
          <div style={styles.collapsedStrip}>
            <button
              style={styles.expandBtn}
              onClick={() => setPanelCollapsed(false)}
              title="Expand sidebar"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M6 3l5 5-5 5V3z" />
              </svg>
            </button>
          </div>
        ) : (
          <>
            <Sidebar />
            {!fileExplorerCollapsed && (
              <FileExplorer onCollapse={() => setFileExplorerCollapsed(true)} />
            )}
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
  collapsedStrip: {
    width: 32,
    minWidth: 32,
    background: "#252525",
    borderRight: "1px solid #333",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    paddingTop: 8,
  },
  expandBtn: {
    background: "none",
    border: "none",
    color: "#888",
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
};
