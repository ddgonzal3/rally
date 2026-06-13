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

  return (
    <div
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        height: 35,
        zIndex: 9000,
        display: "flex",
        alignItems: "center",
        paddingLeft: 12,
        paddingRight: 12,
        gap: 6,
        background: "rgba(28, 28, 28, 0.82)",
        backdropFilter: "blur(20px) saturate(180%)",
        WebkitBackdropFilter: "blur(20px) saturate(180%)",
        borderTop: "1px solid rgba(255, 255, 255, 0.08)",
        overflowX: "auto",
        overflowY: "hidden",
      }}
    >
      {stashedPodIds.map((podId) => (
        <StashChip key={podId} podId={podId} workspaceId={workspaceId} />
      ))}
    </div>
  );
}
