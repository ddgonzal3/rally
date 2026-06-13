// src/components/StashChip.tsx
import React, { useState, useEffect, useCallback } from "react";
import { useWorkspaceStore, ptyLastOutputAt } from "../stores/workspaceStore";
import type { LayoutNode } from "../lib/types";

const ACTIVE_THRESHOLD_MS = 3000;

function getPodPtyIds(podId: string): string[] {
  const state = useWorkspaceStore.getState();
  const ids: string[] = [];

  // Inner layout panes (where Claude Code actually lives)
  const podLayout = state.layouts[`flight:${podId}`];
  if (podLayout?.root) {
    const walk = (node: LayoutNode) => {
      if (node.type === "group") {
        const group = podLayout.groups[node.groupId];
        group?.panes.forEach((p) => {
          if (p.ptyId) ids.push(p.ptyId);
        });
      } else if (node.type === "split") {
        node.children.forEach(walk);
      }
    };
    walk(podLayout.root);
  }

  // Shell PTYs — find the pod across all flight layouts
  for (const layout of Object.values(state.flightLayouts)) {
    const pod = layout?.pods?.find((p) => p.id === podId);
    if (!pod) continue;
    if (pod.ptyId) ids.push(pod.ptyId);
    if ("shellPtyId" in pod && pod.shellPtyId) ids.push(pod.shellPtyId);
    pod.shellTabs?.forEach((t) => {
      if (t.ptyId) ids.push(t.ptyId);
    });
    break;
  }

  return ids;
}

interface StashChipProps {
  podId: string;
  workspaceId: string;
}

export function StashChip({ podId, workspaceId }: StashChipProps) {
  const unstashPod = useWorkspaceStore((s) => s.unstashPod);
  const removeFlightPod = useWorkspaceStore((s) => s.removeFlightPod);
  const title = useWorkspaceStore((s) => {
    const pod = s.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId);
    if (!pod) return podId;
    return pod.cwd ? pod.cwd.split("/").pop() || pod.cwd : pod.title || podId;
  });

  const [isActive, setIsActive] = useState(false);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    const tick = () => {
      const ids = getPodPtyIds(podId);
      const now = Date.now();
      const active = ids.some((id) => {
        const last = ptyLastOutputAt.get(id);
        return last !== undefined && now - last < ACTIVE_THRESHOLD_MS;
      });
      setIsActive(active);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [podId]);

  const handleRestore = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      unstashPod(workspaceId, podId);
    },
    [unstashPod, workspaceId, podId],
  );

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      removeFlightPod(workspaceId, podId);
    },
    [removeFlightPod, workspaceId, podId],
  );

  return (
    <div
      className="sidebar-btn"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={handleRestore}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        padding: "0 8px",
        height: 24,
        borderRadius: 5,
        cursor: "pointer",
        background: hovered ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.1)",
        flexShrink: 0,
        userSelect: "none",
      }}
    >
      {/* Activity dot */}
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: isActive ? "#ddd" : "#444",
          flexShrink: 0,
          transition: "background 0.4s",
        }}
      />
      {/* Name */}
      <span
        style={{
          fontSize: 11,
          color: "var(--text-primary)",
          fontWeight: 500,
          maxWidth: 80,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {title}
      </span>
      {/* Close button — visible on hover */}
      {hovered && (
        <button
          onClick={handleClose}
          style={{
            marginLeft: 2,
            width: 14,
            height: 14,
            padding: 0,
            background: "none",
            border: "none",
            color: "var(--text-dim)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 3,
            flexShrink: 0,
          }}
          title="Close"
        >
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
            <line x1="1" y1="1" x2="7" y2="7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            <line x1="7" y1="1" x2="1" y2="7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}
