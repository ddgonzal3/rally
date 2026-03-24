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
      <button style={styles.btn} onClick={handleAddClaude} title="Add Claude pod">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={styles.icon}>
          <line x1="5" y1="1" x2="5" y2="9" stroke="#999" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="1" y1="5" x2="9" y2="5" stroke="#999" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span style={styles.btnLabel}>Claude</span>
      </button>
      <button style={styles.btn} onClick={handleAddTerminal} title="Add Terminal pod">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={styles.icon}>
          <line x1="5" y1="1" x2="5" y2="9" stroke="#999" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="1" y1="5" x2="9" y2="5" stroke="#999" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span style={styles.btnLabel}>Terminal</span>
      </button>
      <div style={styles.divider} />
      <button
        style={styles.btn}
        onClick={handleResetSizes}
        title="Reset all pods to default size"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={styles.icon}>
          <rect x="1" y="1" width="4" height="4" rx="0.5" stroke="#999" strokeWidth="1" />
          <rect x="7" y="1" width="4" height="4" rx="0.5" stroke="#999" strokeWidth="1" />
          <rect x="1" y="7" width="4" height="4" rx="0.5" stroke="#999" strokeWidth="1" />
          <rect x="7" y="7" width="4" height="4" rx="0.5" stroke="#999" strokeWidth="1" />
        </svg>
        <span style={styles.btnLabel}>Reset</span>
      </button>
      <div style={styles.divider} />
      <button
        style={{ ...styles.btn, color: focusMode ? "var(--text-primary)" : "#666" }}
        onClick={onToggleFocus}
        title={focusMode ? "Focus mode ON — swipe to switch pods" : "Focus mode OFF — free canvas"}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={styles.icon}>
          <rect x="2" y="2" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="6" cy="6" r="1.5" fill="currentColor" />
        </svg>
        <span style={styles.btnLabel}>Focus</span>
      </button>
      <button
        style={{ ...styles.btn, color: autoFocus ? "var(--text-primary)" : "#666" }}
        onClick={onToggleAutoFocus}
        title={autoFocus ? "Auto-focus ON — new pods trigger focus mode" : "Auto-focus OFF — new pods stay in free canvas"}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={styles.icon}>
          <path d="M1 4V2a1 1 0 011-1h2M8 1h2a1 1 0 011 1v2M11 8v2a1 1 0 01-1 1H8M4 11H2a1 1 0 01-1-1V8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        <span style={styles.btnLabel}>Auto</span>
      </button>
      <div style={styles.divider} />
      <button
        style={styles.zoomBtn}
        onClick={handleResetZoom}
        title="Reset zoom to 100%"
      >
        {zoomPct}%
      </button>
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
    gap: 4,
    background: "rgba(36, 36, 36, 0.78)",
    backdropFilter: "blur(20px) saturate(180%)",
    border: "1px solid rgba(255, 255, 255, 0.12)",
    borderRadius: 8,
    padding: "5px 8px",
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
