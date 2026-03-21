import React, { useRef, useCallback, useMemo, useState } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { Terminal } from "./Terminal";
import { ClaudeTerminalWrapper } from "./ClaudeTerminalWrapper";
import { CLAUDE_PATH } from "./FileIcons";
import type { FlightPod as FlightPodType } from "../lib/types";
import {
  FLIGHT_MIN_CLAUDE_WIDTH,
  FLIGHT_MIN_CLAUDE_HEIGHT,
  FLIGHT_MIN_TERMINAL_WIDTH,
  FLIGHT_MIN_TERMINAL_HEIGHT,
  FLIGHT_DEFAULT_CLAUDE_WIDTH,
  FLIGHT_DEFAULT_CLAUDE_HEIGHT,
  FLIGHT_DEFAULT_TERMINAL_WIDTH,
  FLIGHT_DEFAULT_TERMINAL_HEIGHT,
} from "../lib/types";

const SNAP_THRESHOLD = 12; // pixels in canvas space

interface SnapEdges {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Snap a pod's edges to nearby pod edges. Returns adjusted x/y (and optionally w/h for resize). */
function snapToNeighbors(
  moving: SnapEdges,
  others: SnapEdges[],
  mode: "drag" | "resize",
): SnapEdges {
  let { x, y, width, height } = moving;
  const left = x;
  const right = x + width;
  const top = y;
  const bottom = y + height;

  let snappedX = false;
  let snappedY = false;

  for (const o of others) {
    const oLeft = o.x;
    const oRight = o.x + o.width;
    const oTop = o.y;
    const oBottom = o.y + o.height;

    if (!snappedX) {
      if (mode === "drag") {
        // Left edge → other left or right edge
        if (Math.abs(left - oLeft) < SNAP_THRESHOLD) { x = oLeft; snappedX = true; }
        else if (Math.abs(left - oRight) < SNAP_THRESHOLD) { x = oRight; snappedX = true; }
        // Right edge → other left or right edge
        else if (Math.abs(right - oLeft) < SNAP_THRESHOLD) { x = oLeft - width; snappedX = true; }
        else if (Math.abs(right - oRight) < SNAP_THRESHOLD) { x = oRight - width; snappedX = true; }
      } else {
        // Resize: right edge snaps
        if (Math.abs(right - oLeft) < SNAP_THRESHOLD) { width = oLeft - x; snappedX = true; }
        else if (Math.abs(right - oRight) < SNAP_THRESHOLD) { width = oRight - x; snappedX = true; }
      }
    }

    if (!snappedY) {
      if (mode === "drag") {
        // Top edge → other top or bottom edge
        if (Math.abs(top - oTop) < SNAP_THRESHOLD) { y = oTop; snappedY = true; }
        else if (Math.abs(top - oBottom) < SNAP_THRESHOLD) { y = oBottom; snappedY = true; }
        // Bottom edge → other top or bottom edge
        else if (Math.abs(bottom - oTop) < SNAP_THRESHOLD) { y = oTop - height; snappedY = true; }
        else if (Math.abs(bottom - oBottom) < SNAP_THRESHOLD) { y = oBottom - height; snappedY = true; }
      } else {
        // Resize: bottom edge snaps
        if (Math.abs(bottom - oTop) < SNAP_THRESHOLD) { height = oTop - y; snappedY = true; }
        else if (Math.abs(bottom - oBottom) < SNAP_THRESHOLD) { height = oBottom - y; snappedY = true; }
      }
    }

    if (snappedX && snappedY) break;
  }

  return { x, y, width, height };
}

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

  // Track whether user has clicked "Start" for Claude pods (when no ptyId on restore)
  const [claudeLaunched, setClaudeLaunched] = useState(!!podPtyId);

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
      const rawX = dragState.current.origX + dx;
      const rawY = dragState.current.origY + dy;

      // Get other pods for snapping
      const store = useWorkspaceStore.getState();
      const pods = store.flightLayouts[workspaceId]?.pods ?? [];
      const others = pods.filter((p) => p.id !== podId).map((p) => ({ x: p.x, y: p.y, width: p.width, height: p.height }));
      const snapped = snapToNeighbors({ x: rawX, y: rawY, width: podWidth, height: podHeight }, others, "drag");

      updateFlightPod(workspaceId, podId, {
        x: snapped.x,
        y: snapped.y,
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
  }, [bringPodToFront, podId, podX, podY, podWidth, podHeight, updateFlightPod, workspaceId, zoom]);

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
      const rawW = Math.max(minW, resizeState.current.origW + dx);
      const rawH = Math.max(minH, resizeState.current.origH + dy);

      // Get other pods for snapping
      const store = useWorkspaceStore.getState();
      const pods = store.flightLayouts[workspaceId]?.pods ?? [];
      const others = pods.filter((p) => p.id !== podId).map((p) => ({ x: p.x, y: p.y, width: p.width, height: p.height }));
      const snapped = snapToNeighbors({ x: podX, y: podY, width: rawW, height: rawH }, others, "resize");

      updateFlightPod(workspaceId, podId, {
        width: Math.max(minW, snapped.width),
        height: Math.max(minH, snapped.height),
      } as Partial<FlightPodType>);
    };

    const onMouseUp = () => {
      resizeState.current = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [podHeight, podId, podType, podWidth, podX, podY, updateFlightPod, workspaceId, zoom]);

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

  const setFlightViewport = useWorkspaceStore((s) => s.setFlightViewport);

  const handleFocusClick = useCallback(() => {
    // When zoomed out past threshold, click zooms to fit this pod in the viewport
    if (zoom < ZOOM_TO_FIT_THRESHOLD) {
      // Calculate zoom to fit pod with some padding (80% of viewport)
      const container = podRef.current?.closest("[style*='overflow: hidden']") as HTMLElement | null;
      if (container) {
        const rect = container.getBoundingClientRect();
        const viewW = rect.width * 0.8;
        const viewH = rect.height * 0.8;
        const fitZoom = Math.min(viewW / podWidth, viewH / podHeight, 1.0);
        // Center the pod in the viewport
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        const panX = centerX - (podX + podWidth / 2) * fitZoom;
        const panY = centerY - (podY + podHeight / 2) * fitZoom;
        setFlightViewport(workspaceId, { panX, panY, zoom: fitZoom });
      }
      return;
    }
    if (!podRef.current) return;
    const textarea = podRef.current.querySelector("textarea.xterm-helper-textarea") as HTMLTextAreaElement | null;
    if (textarea) textarea.focus();
  }, [zoom, podX, podY, podWidth, podHeight, workspaceId, setFlightViewport]);

  if (!podType) return null;

  const isClaudePod = podType === "claude";
  const terminalBodyHeight = isClaudePod && shellExpanded
    ? podHeight - 32 - shellHeight
    : podHeight - 32;

  return (
    <>
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
            <svg width="14" height="14" viewBox="-2 -1 28 26" style={{ ...headerStyles.icon, flexShrink: 0 }}>
              <path d={CLAUDE_PATH} fill="#D97757" fillRule="nonzero" />
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
        {isClaudePod && !claudeLaunched && !podPtyId ? (
          /* Claude launcher — shown when pod is restored without a ptyId */
          <div style={launcherStyles.container}>
            <div
              className="launch-btn"
              style={launcherStyles.main}
              onClick={() => setClaudeLaunched(true)}
            >
              <svg width="40" height="40" viewBox="-2 -1 28 26" style={{ flexShrink: 0 }}>
                <path d={CLAUDE_PATH} fill="#D97757" fillRule="nonzero" />
              </svg>
              <span style={launcherStyles.name}>Claude Code</span>
              <span style={launcherStyles.path}>{cwdBasename}</span>
            </div>
          </div>
        ) : isClaudePod ? (
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

    <EdgeSpawnButtons
      podX={podX}
      podY={podY}
      podWidth={podWidth}
      podHeight={podHeight}
      podZIndex={podZIndex}
      podCwd={podCwd}
      workspaceId={workspaceId}
      podId={podId}
    />
    </>
  );
});

const EDGE_ZONE_SIZE = 40;
const SPAWN_GAP = 8;
const ZOOM_TO_FIT_THRESHOLD = 0.65; // Below this zoom level, clicking a pod zooms to fit it

const edgeBtnStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "none",
  border: "none",
  cursor: "pointer",
  borderRadius: 4,
  padding: 0,
  color: "#666",
};

const EdgeSpawnButtons = React.memo(function EdgeSpawnButtons({
  podX,
  podY,
  podWidth,
  podHeight,
  podZIndex,
  podCwd,
  workspaceId,
  podId,
}: {
  podX: number;
  podY: number;
  podWidth: number;
  podHeight: number;
  podZIndex: number;
  podCwd: string;
  workspaceId: string;
  podId: string;
}) {
  const addFlightPodAt = useWorkspaceStore((s) => s.addFlightPodAt);

  const blockedEdges = useWorkspaceStore((s) => {
    const pods = s.flightLayouts[workspaceId]?.pods;
    if (!pods) return "";
    const blocked: string[] = [];
    const ADJACENT_THRESHOLD = 20;
    for (const p of pods) {
      if (p.id === podId) continue;
      // Check if p overlaps vertically with our pod (for left/right adjacency)
      const vOverlap = p.y < podY + podHeight && p.y + p.height > podY;
      // Check if p overlaps horizontally with our pod (for top/bottom adjacency)
      const hOverlap = p.x < podX + podWidth && p.x + p.width > podX;

      if (vOverlap) {
        // Right edge blocked if another pod's left edge is close to our right edge
        if (Math.abs(p.x - (podX + podWidth)) < ADJACENT_THRESHOLD) blocked.push("right");
        // Left edge blocked if another pod's right edge is close to our left edge
        if (Math.abs((p.x + p.width) - podX) < ADJACENT_THRESHOLD) blocked.push("left");
      }
      if (hOverlap) {
        // Bottom edge blocked if another pod's top edge is close to our bottom edge
        if (Math.abs(p.y - (podY + podHeight)) < ADJACENT_THRESHOLD) blocked.push("bottom");
        // Top edge blocked if another pod's bottom edge is close to our top edge
        if (Math.abs((p.y + p.height) - podY) < ADJACENT_THRESHOLD) blocked.push("top");
      }
    }
    return blocked.join(",");
  });

  const spawn = useCallback(
    (type: "claude" | "terminal", edge: "top" | "right" | "bottom" | "left") => {
      const defaultW = type === "claude" ? FLIGHT_DEFAULT_CLAUDE_WIDTH : FLIGHT_DEFAULT_TERMINAL_WIDTH;
      const defaultH = type === "claude" ? FLIGHT_DEFAULT_CLAUDE_HEIGHT : FLIGHT_DEFAULT_TERMINAL_HEIGHT;
      let x: number, y: number, w: number, h: number;
      switch (edge) {
        case "right":
          x = podX + podWidth + SPAWN_GAP; y = podY; w = defaultW; h = podHeight; break;
        case "left":
          x = podX - defaultW - SPAWN_GAP; y = podY; w = defaultW; h = podHeight; break;
        case "bottom":
          x = podX; y = podY + podHeight + SPAWN_GAP; w = podWidth; h = defaultH; break;
        case "top":
          x = podX; y = podY - defaultH - SPAWN_GAP; w = podWidth; h = defaultH; break;
      }
      addFlightPodAt(workspaceId, type, x, y, w, h, podCwd);
    },
    [addFlightPodAt, podX, podY, podWidth, podHeight, podCwd, workspaceId],
  );

  const edges: Array<{
    edge: "top" | "right" | "bottom" | "left";
    zoneStyle: React.CSSProperties;
    btnContainerStyle: React.CSSProperties;
  }> = [
    {
      edge: "right",
      zoneStyle: {
        position: "absolute",
        left: podX + podWidth,
        top: podY,
        width: EDGE_ZONE_SIZE,
        height: podHeight,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      },
      btnContainerStyle: { display: "flex", flexDirection: "column", gap: 2 },
    },
    {
      edge: "left",
      zoneStyle: {
        position: "absolute",
        left: podX - EDGE_ZONE_SIZE,
        top: podY,
        width: EDGE_ZONE_SIZE,
        height: podHeight,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      },
      btnContainerStyle: { display: "flex", flexDirection: "column", gap: 2 },
    },
    {
      edge: "bottom",
      zoneStyle: {
        position: "absolute",
        left: podX,
        top: podY + podHeight,
        width: podWidth,
        height: EDGE_ZONE_SIZE,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      },
      btnContainerStyle: { display: "flex", flexDirection: "row", gap: 2 },
    },
    {
      edge: "top",
      zoneStyle: {
        position: "absolute",
        left: podX,
        top: podY - EDGE_ZONE_SIZE,
        width: podWidth,
        height: EDGE_ZONE_SIZE,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      },
      btnContainerStyle: { display: "flex", flexDirection: "row", gap: 2 },
    },
  ];

  const blockedSet = new Set(blockedEdges ? blockedEdges.split(",") : []);

  return (
    <>
      {edges.filter(({ edge }) => !blockedSet.has(edge)).map(({ edge, zoneStyle, btnContainerStyle }) => (
        <div
          key={edge}
          className="flight-edge-zone"
          style={{ ...zoneStyle, zIndex: podZIndex + 1, cursor: "default" }}
        >
          <div className="flight-edge-btns" style={btnContainerStyle}>
            <button
              className="flight-edge-btn"
              onClick={(e) => { e.stopPropagation(); spawn("claude", edge); }}
              title="Add Claude pod"
              style={edgeBtnStyle}
            >
              <svg width="14" height="14" viewBox="-2 -1 28 26" fill="none">
                <path d={CLAUDE_PATH} fill="#D97757" fillRule="nonzero" />
              </svg>
            </button>
            <button
              className="flight-edge-btn"
              onClick={(e) => { e.stopPropagation(); spawn("terminal", edge); }}
              title="Add Terminal pod"
              style={edgeBtnStyle}
            >
              <svg width="16" height="16" viewBox="0 0 12 12" fill="none">
                <polyline points="2,3.5 5,6 2,8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                <line x1="6" y1="8.5" x2="10" y2="8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
      ))}
    </>
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

const launcherStyles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 0,
    minWidth: 0,
    userSelect: "none",
    background: "var(--terminal-bg)",
  },
  main: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
    cursor: "pointer",
    padding: 16,
  },
  name: {
    fontSize: 18,
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontWeight: 400,
    color: "var(--text-primary)",
    letterSpacing: "0.01em",
    lineHeight: 1,
  },
  path: {
    fontSize: 12,
    color: "var(--text-secondary)",
    fontWeight: 600,
    letterSpacing: "0.02em",
  },
};
