import React from "react";
import { PaneGroupView } from "./PaneGroupView";
import { ResizeHandle } from "./ResizeHandle";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { LayoutNode, WorkspaceLayout } from "../lib/types";

interface SplitContainerProps {
  node: LayoutNode;
  layout: WorkspaceLayout;
  workspaceId: string;
  workspacePath: string;
}

export function SplitContainer({
  node,
  layout,
  workspaceId,
  workspacePath,
}: SplitContainerProps) {
  const updateSplitRatio = useWorkspaceStore((s) => s.updateSplitRatio);

  if (node.type === "group") {
    const group = layout.groups[node.groupId];
    if (!group) return null;
    return (
      <PaneGroupView
        group={group}
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
        }}
      >
        <SplitContainer
          node={first}
          layout={layout}
          workspaceId={workspaceId}
          workspacePath={workspacePath}
        />
      </div>

      <ResizeHandle
        direction={node.direction}
        onResize={(ratio) => updateSplitRatio(workspaceId, node.id, ratio)}
      />

      <div
        style={{
          flex: `${1 - node.ratio} 1 0%`,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          overflow: "hidden",
        }}
      >
        <SplitContainer
          node={second}
          layout={layout}
          workspaceId={workspaceId}
          workspacePath={workspacePath}
        />
      </div>
    </div>
  );
}
