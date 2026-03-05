import React, { useCallback } from "react";
import { PaneGroupView } from "./PaneGroupView";
import { ResizeHandle } from "./ResizeHandle";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { LayoutNode } from "../lib/types";

const SNAP_COLLAPSE_THRESHOLD = 0.786;

interface SplitContainerProps {
  node: LayoutNode;
  workspaceId: string;
  workspacePath: string;
  isRoot?: boolean;
  isBottomPanel?: boolean;
}

/**
 * Memoized to prevent re-renders when sibling groups change.
 * Each SplitContainer only re-renders when its own `node` prop changes
 * (tree structure change), NOT when group content changes.
 */
export const SplitContainer = React.memo(function SplitContainer({
  node,
  workspaceId,
  workspacePath,
  isRoot,
  isBottomPanel,
}: SplitContainerProps) {
  const updateSplitRatio = useWorkspaceStore((s) => s.updateSplitRatio);
  const toggleBottomPanel = useWorkspaceStore((s) => s.toggleBottomPanel);
  const bottomCollapsed = useWorkspaceStore(
    (s) => !!s.bottomPanelCollapsed[workspaceId],
  );

  if (node.type === "group") {
    return (
      <PaneGroupView
        groupId={node.groupId}
        workspaceId={workspaceId}
        workspacePath={workspacePath}
        isBottomPanel={isBottomPanel}
      />
    );
  }

  // Split node
  const isVertical = node.direction === "vertical";
  const [first, second] = node.children;
  const isRootVertical = isRoot && isVertical;
  const collapsed = isRootVertical && bottomCollapsed;

  // For root vertical splits: snap to collapsed when dragged past threshold
  const handleRootVerticalResize = useCallback(
    (ratio: number) => {
      if (ratio >= SNAP_COLLAPSE_THRESHOLD) {
        // Snap the ratio to the threshold and collapse
        updateSplitRatio(workspaceId, node.type === "split" ? node.id : "", SNAP_COLLAPSE_THRESHOLD);
        toggleBottomPanel(workspaceId);
      } else {
        updateSplitRatio(workspaceId, node.type === "split" ? node.id : "", ratio);
      }
    },
    [workspaceId, node, updateSplitRatio, toggleBottomPanel],
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: isVertical ? "column" : "row",
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          flex: collapsed ? "1 1 0%" : `${node.ratio} 1 0%`,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          overflow: "hidden",
          transition: "var(--split-transition, flex 0.08s ease)",
        }}
      >
        <SplitContainer
          node={first}
          workspaceId={workspaceId}
          workspacePath={workspacePath}
        />
      </div>

      {!collapsed && (
        <ResizeHandle
          direction={node.direction}
          ratio={node.ratio}
          onResize={isRootVertical
            ? handleRootVerticalResize
            : (ratio) => updateSplitRatio(workspaceId, node.id, ratio)
          }
        />
      )}

      <div
        style={{
          flex: collapsed ? "0 0 29px" : `${1 - node.ratio} 1 0%`,
          minWidth: 0,
          minHeight: collapsed ? 29 : 0,
          maxHeight: collapsed ? 29 : undefined,
          display: "flex",
          overflow: "hidden",
          transition: "var(--split-transition, flex 0.08s ease)",
          ...(collapsed ? { borderTop: "1px solid var(--border)" } : {}),
        }}
      >
        <SplitContainer
          node={second}
          workspaceId={workspaceId}
          workspacePath={workspacePath}
          isBottomPanel={isRootVertical || isBottomPanel}
        />
      </div>
    </div>
  );
});
