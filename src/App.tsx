import React, { useEffect, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "./components/Sidebar";
import { PaneLayout } from "./components/PaneLayout";
import { GitActions } from "./components/GitActions";
import { useWorkspaceStore } from "./stores/workspaceStore";

export function App() {
  const { loadWorkspaces, refreshAllGitStatuses } =
    useWorkspaceStore();

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
        <span style={styles.titleText}>Workbench</span>
      </div>
      <div style={styles.body}>
        <Sidebar />
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
};
