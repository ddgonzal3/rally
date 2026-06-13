// src/components/StashChip.tsx
import React, { useState, useEffect, useCallback, useRef } from "react";
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
  const updateFlightPod = useWorkspaceStore((s) => s.updateFlightPod);

  // label > branch basename > cwd basename
  const displayName = useWorkspaceStore((s) => {
    const pod = s.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId);
    if (!pod) return podId;
    if (pod.label) return pod.label;
    const branch = s.gitStatuses[pod.cwd]?.branch;
    if (branch) return branch;
    return pod.cwd ? pod.cwd.split("/").pop() || pod.cwd : pod.title || podId;
  });

  const [chipState, setChipState] = useState<ChipState>("idle");
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

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
      setChipState(Date.now() - lastOutput < ACTIVE_THRESHOLD_MS ? "active" : "ready");
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [podId, workspaceId]);

  useEffect(() => {
    if (isEditing) inputRef.current?.focus();
  }, [isEditing]);

  const handleChipClick = useCallback(
    (e: React.MouseEvent) => {
      if (isEditing) return;
      e.stopPropagation();
      unstashPod(workspaceId, podId);
    },
    [isEditing, unstashPod, workspaceId, podId],
  );

  const handleLabelDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setEditValue(displayName);
      setIsEditing(true);
    },
    [displayName],
  );

  const commitEdit = useCallback(() => {
    const trimmed = editValue.trim();
    updateFlightPod(workspaceId, podId, { label: trimmed || undefined } as any);
    setIsEditing(false);
  }, [editValue, updateFlightPod, workspaceId, podId]);

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") commitEdit();
      if (e.key === "Escape") setIsEditing(false);
      e.stopPropagation();
    },
    [commitEdit],
  );

  return (
    <div
      onClick={handleChipClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0 10px",
        height: 22,
        borderRadius: 4,
        cursor: isEditing ? "default" : "pointer",
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
      {isEditing ? (
        <input
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleInputKeyDown}
          onBlur={commitEdit}
          style={{
            background: "none",
            border: "none",
            outline: "none",
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text-primary)",
            fontFamily: "inherit",
            lineHeight: 1,
            width: 100,
            padding: 0,
          }}
        />
      ) : (
        <span
          onDoubleClick={handleLabelDoubleClick}
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
          {displayName}
        </span>
      )}
    </div>
  );
}
