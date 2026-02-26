import React, { useMemo } from "react";
import { SplitContainer } from "./SplitContainer";
import { useWorkspaceStore } from "../stores/workspaceStore";

/**
 * Renders a single workspace's layout tree.
 * Hidden (display: none) when not active — keeps xterm.js instances alive
 * so scroll position and terminal state survive workspace switches.
 */
const WorkspaceLayoutView = React.memo(function WorkspaceLayoutView({
  workspaceId,
  isActive,
}: {
  workspaceId: string;
  isActive: boolean;
}) {
  const getOrCreateLayout = useWorkspaceStore((s) => s.getOrCreateLayout);
  const layoutRoot = useWorkspaceStore(
    (s) => s.layouts[workspaceId]?.root
  );
  const workspacePath = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId);
    if (!ws || ws.paths.length === 0) return "";
    const idx = s.activePathIndex[workspaceId] ?? 0;
    return ws.paths[idx] ?? ws.paths[0] ?? "";
  });

  // Ensure layout exists (creates default if needed)
  const layout = getOrCreateLayout(workspaceId);
  const root = layoutRoot ?? layout.root;

  return (
    <div
      style={{
        flex: 1,
        display: isActive ? "flex" : "none",
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <SplitContainer
        node={root}
        workspaceId={workspaceId}
        workspacePath={workspacePath}
      />
    </div>
  );
});

export function PaneLayout() {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const hasActiveWorkspace = useWorkspaceStore(
    (s) => !!s.activeWorkspaceId && s.workspaces.some((w) => w.id === s.activeWorkspaceId)
  );

  // Return a stable string (joined IDs) so Zustand's Object.is check prevents
  // re-renders when the set of mounted workspaces hasn't actually changed.
  // See PITFALLS.md — returning a new array from a selector causes render loops.
  const mountedIdsString = useWorkspaceStore((s) => {
    const wsIds = new Set(s.workspaces.map((w) => w.id));
    const ids = new Set<string>();
    for (const id of Object.keys(s.layouts)) {
      if (wsIds.has(id)) ids.add(id);
    }
    if (s.activeWorkspaceId && wsIds.has(s.activeWorkspaceId)) {
      ids.add(s.activeWorkspaceId);
    }
    return Array.from(ids).join("\n");
  });
  const mountedWorkspaceIds = useMemo(
    () => (mountedIdsString ? mountedIdsString.split("\n") : []),
    [mountedIdsString]
  );

  if (!hasActiveWorkspace) {
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

  return (
    <div style={styles.container} data-pane-area="">
      {mountedWorkspaceIds.map((wsId) => (
        <WorkspaceLayoutView
          key={wsId}
          workspaceId={wsId}
          isActive={wsId === activeWorkspaceId}
        />
      ))}
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
    position: "relative" as const,
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
