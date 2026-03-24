import React from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import {
  FLIGHT_DEFAULT_CLAUDE_WIDTH,
  FLIGHT_DEFAULT_CLAUDE_HEIGHT,
  FLIGHT_DEFAULT_TERMINAL_WIDTH,
  FLIGHT_DEFAULT_TERMINAL_HEIGHT,
} from "../lib/types";

interface FlightHUDProps {
  workspaceId: string;
  zoom: number;
  focusMode: boolean;
  onToggleFocus: () => void;
  autoFocus: boolean;
  onToggleAutoFocus: () => void;
}

export function FlightHUD({ workspaceId, zoom, focusMode, onToggleFocus, autoFocus, onToggleAutoFocus }: FlightHUDProps) {
  const addFlightPod = useWorkspaceStore((s) => s.addFlightPod);
  const setFlightViewport = useWorkspaceStore((s) => s.setFlightViewport);

  const updateFlightPod = useWorkspaceStore((s) => s.updateFlightPod);
  const pods = useWorkspaceStore((s) => s.flightLayouts[workspaceId]?.pods);

  const handleAddClaude = () => addFlightPod(workspaceId, "claude");
  const handleAddTerminal = () => addFlightPod(workspaceId, "terminal");
  const handleResetZoom = () => setFlightViewport(workspaceId, { zoom: 1.0 });
  const handleResetSizes = () => {
    if (!pods) return;
    // In focus mode, cap width so ≥2 pods fit (same logic as navigateTo)
    const container = document.querySelector("[data-flight-canvas]") as HTMLElement | null;
    let maxW = Infinity;
    if (focusMode && container) {
      const rect = container.getBoundingClientRect();
      const parentZoom = rect.width / container.offsetWidth;
      const containerW = rect.width / parentZoom;
      maxW = Math.floor((containerW - 8 - 24) / 2); // GAP=8, PAD=12*2
    }
    for (const pod of pods) {
      const isClaudeType = pod.type === "claude";
      const defaultW = isClaudeType ? FLIGHT_DEFAULT_CLAUDE_WIDTH : FLIGHT_DEFAULT_TERMINAL_WIDTH;
      const defaultH = isClaudeType ? FLIGHT_DEFAULT_CLAUDE_HEIGHT : FLIGHT_DEFAULT_TERMINAL_HEIGHT;
      updateFlightPod(workspaceId, pod.id, {
        width: Math.min(defaultW, maxW),
        height: defaultH,
      } as any);
    }
  };

  const zoomPct = Math.round(zoom * 100);

  return (
    <div style={styles.hud}>
      <span
        style={styles.zoomBtn}
        onClick={handleResetZoom}
        title="Reset zoom to 100%"
      >
        {zoomPct}%
      </span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  hud: {
    position: "absolute",
    bottom: 16,
    right: 16,
    display: "flex",
    alignItems: "center",
    zIndex: 9999,
    userSelect: "none",
  },
  btn: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: "3px 6px",
    borderRadius: 5,
    color: "#999",
    fontSize: 12,
    fontFamily: "inherit",
    lineHeight: 1,
  },
  icon: {
    flexShrink: 0,
  },
  btnLabel: {
    fontSize: 12,
    color: "inherit",
  },
  divider: {
    width: 1,
    height: 14,
    background: "rgba(255, 255, 255, 0.12)",
    margin: "0 4px",
  },
  zoomBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: "3px 6px",
    borderRadius: 5,
    color: "#999",
    fontSize: 12,
    fontFamily: "inherit",
    lineHeight: 1,
    minWidth: 36,
    textAlign: "center",
  },
};
