import React from "react";
import { PaneGroupView } from "./PaneGroupView";
import { ResizeHandle } from "./ResizeHandle";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { LayoutNode } from "../lib/types";

interface SplitContainerProps {
  node: LayoutNode;
  workspaceId: string;
  workspacePath: string;
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
}: SplitContainerProps) {
  const updateSplitRatio = useWorkspaceStore((s) => s.updateSplitRatio);

  if (node.type === "group") {
    return (
      <PaneGroupView
        groupId={node.groupId}
        workspaceId={workspaceId}
        workspacePath={workspacePath}
      />
    );
  }

  // Split node
  const isVertical = node.direction === "vertical";
  const [first, second] = node.children;

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
          flex: `${node.ratio} 1 0%`,
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

      <ResizeHandle
        direction={node.direction}
        ratio={node.ratio}
        onResize={(ratio) => updateSplitRatio(workspaceId, node.id, ratio)}
      />

      <div
        style={{
          flex: `${1 - node.ratio} 1 0%`,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          overflow: "hidden",
          transition: "var(--split-transition, flex 0.08s ease)",
        }}
      >
        <SplitContainer
          node={second}
          workspaceId={workspaceId}
          workspacePath={workspacePath}
        />
      </div>
    </div>
  );
});
