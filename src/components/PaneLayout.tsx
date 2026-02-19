import React from "react";
import { SplitContainer } from "./SplitContainer";
import { useWorkspaceStore } from "../stores/workspaceStore";

export function PaneLayout() {
  const { activeWorkspaceId, workspaces, getOrCreateLayout } =
    useWorkspaceStore();
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);

  if (!ws) {
    return (
      <div style={styles.empty}>
        <div style={styles.emptyText}>
          No workspace selected.
          <br />
          Add a workspace from the sidebar to get started.
        </div>
      </div>
    );
  }

  const layout = getOrCreateLayout(ws.id);

  return (
    <div style={styles.container}>
      <SplitContainer
        node={layout.root}
        layout={layout}
        workspaceId={ws.id}
        workspacePath={ws.path}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    display: "flex",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
  },
  empty: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    textAlign: "center" as const,
    color: "#666",
    fontSize: 14,
    lineHeight: 1.6,
  },
};
