import React from "react";
import { SplitContainer } from "./SplitContainer";
import { useWorkspaceStore } from "../stores/workspaceStore";

export function PaneLayout() {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  // Narrow selector: only re-render when the active workspace itself changes
  const ws = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId)
  );
  const getOrCreateLayout = useWorkspaceStore((s) => s.getOrCreateLayout);
  const getActivePath = useWorkspaceStore((s) => s.getActivePath);
  // Only subscribe to the tree structure (root), not group content.
  // This prevents PaneLayout from re-rendering when tab content changes
  // (e.g., switching active pane, adding a tab). Only tree structure changes
  // (adding/removing splits) cause PaneLayout to re-render.
  const layoutRoot = useWorkspaceStore(
    (s) => activeWorkspaceId ? s.layouts[activeWorkspaceId]?.root : undefined
  );

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

  // Ensure layout exists (creates default if needed)
  const layout = getOrCreateLayout(ws.id);
  const root = layoutRoot ?? layout.root;
  const workspacePath = getActivePath(ws.id) ?? ws.paths[0] ?? "";

  return (
    <div style={styles.container}>
      <SplitContainer
        node={root}
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
