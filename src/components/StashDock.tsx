// src/components/StashDock.tsx
import React, { useMemo } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { StashChip } from "./StashChip";

interface StashDockProps {
  workspaceId: string;
}

export function StashDock({ workspaceId }: StashDockProps) {
  const stashedIds = useWorkspaceStore((s) => {
    const pods = s.flightLayouts[workspaceId]?.pods;
    if (!pods) return "";
    return pods
      .filter((p) => p.stashed)
      .map((p) => p.id)
      .join("\n");
  });

  const stashedPodIds = useMemo(
    () => (stashedIds ? stashedIds.split("\n") : []),
    [stashedIds],
  );

  if (stashedPodIds.length === 0) return null;

  return (
    <div
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        height: 40,
        zIndex: 9000,
        display: "flex",
        alignItems: "center",
        paddingLeft: 12,
        paddingRight: 12,
        gap: 6,
        background: "rgba(36, 36, 36, 0.78)",
        backdropFilter: "blur(20px) saturate(180%)",
        WebkitBackdropFilter: "blur(20px) saturate(180%)",
        borderTop: "1px solid rgba(255, 255, 255, 0.10)",
        overflowX: "auto",
        overflowY: "hidden",
      }}
    >
      <span
        style={{
          fontSize: 10,
          color: "var(--text-dim)",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          flexShrink: 0,
          marginRight: 4,
        }}
      >
        Stashed
      </span>
      {stashedPodIds.map((podId) => (
        <StashChip key={podId} podId={podId} workspaceId={workspaceId} />
      ))}
    </div>
  );
}
