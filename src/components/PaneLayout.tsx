import React from "react";
import { SplitContainer } from "./SplitContainer";
import { useWorkspaceStore } from "../stores/workspaceStore";

export function PaneLayout() {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const layouts = useWorkspaceStore((s) => s.layouts);
  const getOrCreateLayout = useWorkspaceStore((s) => s.getOrCreateLayout);
  const getActivePath = useWorkspaceStore((s) => s.getActivePath);
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
  const workspacePath = getActivePath(ws.id) ?? ws.paths[0] ?? "";

  return (
    <div style={styles.container}>
      <SplitContainer
        node={layout.root}
        layout={layout}
        workspaceId={ws.id}
        workspacePath={workspacePath}
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
