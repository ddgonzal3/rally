import React, { useRef, useCallback, useMemo } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { Terminal } from "./Terminal";
import { ClaudeTerminalWrapper } from "./ClaudeTerminalWrapper";
import type { FlightPod as FlightPodType } from "../lib/types";
import {
  FLIGHT_MIN_CLAUDE_WIDTH,
  FLIGHT_MIN_CLAUDE_HEIGHT,
  FLIGHT_MIN_TERMINAL_WIDTH,
  FLIGHT_MIN_TERMINAL_HEIGHT,
} from "../lib/types";

interface FlightPodProps {
  podId: string;
  workspaceId: string;
  zoom: number;
}

export const FlightPod = React.memo(function FlightPod({
  podId,
  workspaceId,
  zoom,
}: FlightPodProps) {
  const updateFlightPod = useWorkspaceStore((s) => s.updateFlightPod);
  const removeFlightPod = useWorkspaceStore((s) => s.removeFlightPod);
  const bringPodToFront = useWorkspaceStore((s) => s.bringPodToFront);
  const togglePodShell = useWorkspaceStore((s) => s.togglePodShell);

  // Stable selectors — avoid returning new objects
  const podX = useWorkspaceStore((s) => s.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId)?.x ?? 0);
  const podY = useWorkspaceStore((s) => s.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId)?.y ?? 0);
  const podWidth = useWorkspaceStore((s) => s.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId)?.width ?? 700);
  const podHeight = useWorkspaceStore((s) => s.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId)?.height ?? 500);
  const podZIndex = useWorkspaceStore((s) => s.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId)?.zIndex ?? 1);
  const podType = useWorkspaceStore((s) => s.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId)?.type);
  const podCwd = useWorkspaceStore((s) => s.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId)?.cwd ?? "");
  const podTitle = useWorkspaceStore((s) => s.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId)?.title ?? "");
  const podPtyId = useWorkspaceStore((s) => s.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId)?.ptyId);
  const shellExpanded = useWorkspaceStore((s) => {
    const pod = s.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId);
    return pod?.type === "claude" ? pod.shellExpanded : false;
  });
  const shellHeight = useWorkspaceStore((s) => {
    const pod = s.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId);
    return pod?.type === "claude" ? pod.shellHeight : 200;
  });
  const shellPtyId = useWorkspaceStore((s) => {
    const pod = s.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId);
    return pod?.type === "claude" ? pod.shellPtyId : undefined;
  });

  const podRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeState = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);

  // Derive basename for display
  const cwdBasename = useMemo(() => {
    if (!podCwd) return "Terminal";
    const parts = podCwd.replace(/\/$/, "").split("/");
    return parts[parts.length - 1] || podCwd;
  }, [podCwd]);

  const handlePodMouseDown = useCallback((e: React.MouseEvent) => {
    // Don't steal focus from interactive elements
    if ((e.target as HTMLElement).closest("button")) return;
    bringPodToFront(workspaceId, podId);
  }, [bringPodToFront, workspaceId, podId]);

  const handleHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    bringPodToFront(workspaceId, podId);

    const startX = e.clientX;
    const startY = e.clientY;
    const origX = podX;
    const origY = podY;
    dragState.current = { startX, startY, origX, origY };

    // Disable pointer events on other pods while dragging
    document.querySelectorAll("[data-flight-pod]").forEach((el) => {
      const podEl = el as HTMLElement;
      if (podEl.getAttribute("data-flight-pod") !== podId) {
        podEl.style.pointerEvents = "none";
      }
    });

    const onMouseMove = (me: MouseEvent) => {
      if (!dragState.current) return;
      const dx = (me.clientX - dragState.current.startX) / zoom;
      const dy = (me.clientY - dragState.current.startY) / zoom;
      updateFlightPod(workspaceId, podId, {
        x: dragState.current.origX + dx,
        y: dragState.current.origY + dy,
      } as Partial<FlightPodType>);
    };

    const onMouseUp = () => {
      dragState.current = null;
      document.querySelectorAll("[data-flight-pod]").forEach((el) => {
        (el as HTMLElement).style.pointerEvents = "";
      });
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [bringPodToFront, podId, podX, podY, updateFlightPod, workspaceId, zoom]);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const origW = podWidth;
    const origH = podHeight;
    resizeState.current = { startX, startY, origW, origH };

    const minW = podType === "claude" ? FLIGHT_MIN_CLAUDE_WIDTH : FLIGHT_MIN_TERMINAL_WIDTH;
    const minH = podType === "claude" ? FLIGHT_MIN_CLAUDE_HEIGHT : FLIGHT_MIN_TERMINAL_HEIGHT;

    const onMouseMove = (me: MouseEvent) => {
      if (!resizeState.current) return;
      const dx = (me.clientX - resizeState.current.startX) / zoom;
      const dy = (me.clientY - resizeState.current.startY) / zoom;
      updateFlightPod(workspaceId, podId, {
        width: Math.max(minW, resizeState.current.origW + dx),
        height: Math.max(minH, resizeState.current.origH + dy),
      } as Partial<FlightPodType>);
    };

    const onMouseUp = () => {
      resizeState.current = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [podHeight, podId, podType, podWidth, updateFlightPod, workspaceId, zoom]);

  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    removeFlightPod(workspaceId, podId);
  }, [removeFlightPod, workspaceId, podId]);

  const handleShellToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    togglePodShell(workspaceId, podId);
  }, [togglePodShell, workspaceId, podId]);

  const handlePtySpawned = useCallback((ptyId: string) => {
    updateFlightPod(workspaceId, podId, { ptyId } as Partial<FlightPodType>);
  }, [updateFlightPod, workspaceId, podId]);

  const handleShellPtySpawned = useCallback((ptyId: string) => {
    updateFlightPod(workspaceId, podId, { shellPtyId: ptyId } as Partial<FlightPodType>);
  }, [updateFlightPod, workspaceId, podId]);

  const handleFocusClick = useCallback(() => {
    if (!podRef.current) return;
    const textarea = podRef.current.querySelector("textarea.xterm-helper-textarea") as HTMLTextAreaElement | null;
    if (textarea) textarea.focus();
  }, []);

  if (!podType) return null;

  const isClaudePod = podType === "claude";
  const terminalBodyHeight = isClaudePod && shellExpanded
    ? podHeight - 32 - shellHeight
    : podHeight - 32;

  return (
    <div
      ref={podRef}
      data-flight-pod={podId}
      onMouseDown={handlePodMouseDown}
      onClick={handleFocusClick}
      style={{
        position: "absolute",
        left: podX,
        top: podY,
        width: podWidth,
        height: podHeight,
        zIndex: podZIndex,
        display: "flex",
        flexDirection: "column",
        background: "rgba(20, 20, 20, 0.85)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        borderRadius: 10,
        boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
        overflow: "hidden",
        userSelect: "none",
      }}
    >
      {/* Header */}
      <div
        onMouseDown={handleHeaderMouseDown}
        style={headerStyles.header}
      >
        {/* Left: icon + title */}
        <div style={headerStyles.left}>
          {isClaudePod ? (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={headerStyles.icon}>
              <circle cx="6" cy="6" r="5" stroke="#999" strokeWidth="1.2" />
              <text x="6" y="9" textAnchor="middle" fontSize="7" fill="#999" fontFamily="monospace">C</text>
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={headerStyles.icon}>
              <polyline points="2,4 5,6 2,8" stroke="#999" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              <line x1="6" y1="8" x2="10" y2="8" stroke="#999" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          )}
          <span style={headerStyles.title}>{podTitle || cwdBasename}</span>
        </div>

        {/* Right: shell toggle (claude only) + close */}
        <div style={headerStyles.right}>
          {isClaudePod && (
            <button
              style={headerStyles.btn}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={handleShellToggle}
              title={shellExpanded ? "Hide shell" : "Show shell"}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <polyline
                  points={shellExpanded ? "2,4 5,7 8,4" : "2,8 5,5 8,8"}
                  stroke="#999"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <line x1="2" y1="10" x2="10" y2="10" stroke="#999" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
          )}
          <button
            style={headerStyles.btn}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleClose}
            title="Close pod"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <line x1="2" y1="2" x2="8" y2="8" stroke="#999" strokeWidth="1.2" strokeLinecap="round" />
              <line x1="8" y1="2" x2="2" y2="8" stroke="#999" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* Main terminal body */}
      <div
        style={{
          flex: shellExpanded ? "none" : 1,
          height: shellExpanded ? terminalBodyHeight : undefined,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          background: "var(--terminal-bg)",
          overflow: "hidden",
        }}
      >
        {isClaudePod ? (
          <ClaudeTerminalWrapper
            cwd={podCwd}
            command="claude"
            ptyId={podPtyId}
            workspaceId={workspaceId}
            onPtySpawned={handlePtySpawned}
          />
        ) : (
          <Terminal
            cwd={podCwd}
            ptyId={podPtyId}
            workspaceId={workspaceId}
            onPtySpawned={handlePtySpawned}
          />
        )}
      </div>

      {/* Shell panel (Claude pods only) — always mounted, toggled with display */}
      {isClaudePod && (
        <div
          style={{
            display: shellExpanded ? "flex" : "none",
            flexDirection: "column",
            height: shellHeight,
            minHeight: 0,
            background: "var(--terminal-bg)",
            borderTop: "1px solid rgba(255, 255, 255, 0.06)",
            overflow: "hidden",
          }}
        >
          <Terminal
            cwd={podCwd}
            ptyId={shellPtyId}
            workspaceId={workspaceId}
            onPtySpawned={handleShellPtySpawned}
          />
        </div>
      )}

      {/* Resize grip — bottom-right corner */}
      <div
        onMouseDown={handleResizeMouseDown}
        style={resizeGripStyle}
        title="Resize"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <line x1="3" y1="9" x2="9" y2="3" stroke="rgba(255,255,255,0.2)" strokeWidth="1" strokeLinecap="round" />
          <line x1="6" y1="9" x2="9" y2="6" stroke="rgba(255,255,255,0.2)" strokeWidth="1" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
});

const headerStyles: Record<string, React.CSSProperties> = {
  header: {
    height: 32,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 8px",
    cursor: "grab",
    flexShrink: 0,
    borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
  },
  left: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
    overflow: "hidden",
  },
  icon: {
    flexShrink: 0,
  },
  title: {
    fontSize: 12,
    color: "#999",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    lineHeight: 1,
  },
  right: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    flexShrink: 0,
  },
  btn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 22,
    background: "none",
    border: "none",
    cursor: "pointer",
    borderRadius: 4,
    padding: 0,
    color: "#999",
  },
};

const resizeGripStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 0,
  right: 0,
  width: 16,
  height: 16,
  cursor: "nwse-resize",
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "flex-end",
  padding: 2,
  zIndex: 10,
};
