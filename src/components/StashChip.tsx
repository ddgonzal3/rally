// src/components/StashChip.tsx
import React, { useState, useEffect, useCallback } from "react";
import { useWorkspaceStore, ptyLastOutputAt } from "../stores/workspaceStore";
import type { LayoutNode } from "../lib/types";

const ACTIVE_THRESHOLD_MS = 3000;

type ChipState = "idle" | "active" | "ready";

function getPodPtyIds(podId: string): string[] {
  const state = useWorkspaceStore.getState();
  const ids: string[] = [];

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

const DOT_COLOR: Record<ChipState, string> = {
  idle: "#444",
  active: "#c8952a",
  ready: "#4a9e6b",
};

interface StashChipProps {
  podId: string;
  workspaceId: string;
}

export function StashChip({ podId, workspaceId }: StashChipProps) {
  const unstashPod = useWorkspaceStore((s) => s.unstashPod);
  const title = useWorkspaceStore((s) => {
    const pod = s.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId);
    if (!pod) return podId;
    return pod.cwd ? pod.cwd.split("/").pop() || pod.cwd : pod.title || podId;
  });

  const [chipState, setChipState] = useState<ChipState>("idle");

  useEffect(() => {
    const tick = () => {
      const pod = useWorkspaceStore.getState().flightLayouts[workspaceId]?.pods.find((p) => p.id === podId);
      const stashedAt = pod?.stashedAt;

      const ids = getPodPtyIds(podId);
      const lastOutput = ids.reduce<number | undefined>((max, id) => {
        const t = ptyLastOutputAt.get(id);
        return t !== undefined ? (max === undefined ? t : Math.max(max, t)) : max;
      }, undefined);

      if (lastOutput === undefined || (stashedAt !== undefined && lastOutput < stashedAt)) {
        setChipState("idle");
        return;
      }

      const now = Date.now();
      if (now - lastOutput < ACTIVE_THRESHOLD_MS) {
        setChipState("active");
      } else {
        setChipState("ready");
      }
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [podId, workspaceId]);

  const handleRestore = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      unstashPod(workspaceId, podId);
    },
    [unstashPod, workspaceId, podId],
  );

  return (
    <div
      onClick={handleRestore}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0 10px",
        height: 22,
        borderRadius: 6,
        cursor: "pointer",
        background: "none",
        border: "1px solid rgba(255, 255, 255, 0.25)",
        flexShrink: 0,
        userSelect: "none",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: DOT_COLOR[chipState],
          flexShrink: 0,
          transition: "background 0.4s",
        }}
      />
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "var(--text-primary)",
          maxWidth: 120,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          lineHeight: 1,
        }}
      >
        {title}
      </span>
    </div>
  );
}
