import { useWorkspaceStore } from "../stores/workspaceStore";
import type { DetectedPort } from "./types";

const EMPTY_PORTS: DetectedPort[] = [];

export function useDetectedPorts(workspaceId: string | null): DetectedPort[] {
  return useWorkspaceStore((s) => {
    if (!workspaceId) return EMPTY_PORTS;
    return s.detectedPorts[workspaceId] ?? EMPTY_PORTS;
  });
}
