import { useMemo } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { DetectedPort } from "./types";

/**
 * Zustand selector hook for detected ports that avoids infinite re-renders.
 * Uses JSON.stringify for selector stability (new array refs break Object.is).
 */
export function useDetectedPorts(workspaceId: string | null): DetectedPort[] {
  const json = useWorkspaceStore((s) => {
    if (!workspaceId) return "[]";
    return JSON.stringify(s.detectedPorts[workspaceId] ?? []);
  });
  return useMemo(() => JSON.parse(json), [json]);
}
