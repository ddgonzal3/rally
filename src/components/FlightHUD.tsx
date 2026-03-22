import React from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";

interface FlightHUDProps {
  workspaceId: string;
  zoom: number;
  snapMode: boolean;
  onToggleSnap: () => void;
}

export function FlightHUD({ workspaceId, zoom, snapMode, onToggleSnap }: FlightHUDProps) {
  const addFlightPod = useWorkspaceStore((s) => s.addFlightPod);
  const setFlightViewport = useWorkspaceStore((s) => s.setFlightViewport);

  const handleAddClaude = () => addFlightPod(workspaceId, "claude");
  const handleAddTerminal = () => addFlightPod(workspaceId, "terminal");
  const handleResetZoom = () => setFlightViewport(workspaceId, { zoom: 1.0 });

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
        style={{ ...styles.btn, color: snapMode ? "var(--text-primary)" : "#666" }}
        onClick={onToggleSnap}
        title={snapMode ? "Snap mode ON — scroll snaps to pods" : "Snap mode OFF — free scroll"}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={styles.icon}>
          <rect x="1" y="1" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
          <rect x="7" y="1" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
          <rect x="1" y="7" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
          <rect x="7" y="7" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        <span style={styles.btnLabel}>Snap</span>
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
