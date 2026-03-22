import React, { useRef, useCallback, useMemo, useState, useEffect } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { Terminal } from "./Terminal";
import { ClaudeTerminalWrapper } from "./ClaudeTerminalWrapper";
import { CLAUDE_PATH } from "./FileIcons";
import { showContextMenu } from "../lib/contextMenu";
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

export interface SnapEdges {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Snap a pod's edges to nearby pod edges. Returns adjusted x/y (and optionally w/h for resize). */
export function snapToNeighbors(
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

    const gap = MIN_POD_GAP;

    if (!snappedX) {
      if (mode === "drag") {
        // Snap with gap: right edge → other left edge (with gap between)
        if (Math.abs(right + gap - oLeft) < SNAP_THRESHOLD) { x = oLeft - width - gap; snappedX = true; }
        // Left edge → other right edge (with gap between)
        else if (Math.abs(left - gap - oRight) < SNAP_THRESHOLD) { x = oRight + gap; snappedX = true; }
        // Align left edges
        else if (Math.abs(left - oLeft) < SNAP_THRESHOLD) { x = oLeft; snappedX = true; }
        // Align right edges
        else if (Math.abs(right - oRight) < SNAP_THRESHOLD) { x = oRight - width; snappedX = true; }
      } else {
        // Resize: right edge snaps to other left edge (with gap)
        if (Math.abs(right + gap - oLeft) < SNAP_THRESHOLD) { width = oLeft - gap - x; snappedX = true; }
        else if (Math.abs(right - oRight) < SNAP_THRESHOLD) { width = oRight - x; snappedX = true; }
      }
    }

    if (!snappedY) {
      if (mode === "drag") {
        // Snap with gap: bottom edge → other top edge (with gap between)
        if (Math.abs(bottom + gap - oTop) < SNAP_THRESHOLD) { y = oTop - height - gap; snappedY = true; }
        // Top edge → other bottom edge (with gap between)
        else if (Math.abs(top - gap - oBottom) < SNAP_THRESHOLD) { y = oBottom + gap; snappedY = true; }
        // Align top edges
        else if (Math.abs(top - oTop) < SNAP_THRESHOLD) { y = oTop; snappedY = true; }
        // Align bottom edges
        else if (Math.abs(bottom - oBottom) < SNAP_THRESHOLD) { y = oBottom - height; snappedY = true; }
      } else {
        // Resize: bottom edge snaps to other top edge (with gap)
        if (Math.abs(bottom + gap - oTop) < SNAP_THRESHOLD) { height = oTop - gap - y; snappedY = true; }
        else if (Math.abs(bottom - oBottom) < SNAP_THRESHOLD) { height = oBottom - y; snappedY = true; }
      }
    }

    if (snappedX && snappedY) break;
  }

  return { x, y, width, height };
}

const MIN_POD_GAP = 8; // Minimum pixels between pods — prevents overlap

/** Push a pod out of any overlapping neighbors. Returns adjusted x/y. */
export function preventOverlap(
  moving: SnapEdges,
  others: SnapEdges[],
): SnapEdges {
  let { x, y } = moving;
  const { width, height } = moving;

  for (const o of others) {
    // Check if they overlap (with MIN_POD_GAP margin)
    const overlapX = x < o.x + o.width + MIN_POD_GAP && x + width + MIN_POD_GAP > o.x;
    const overlapY = y < o.y + o.height + MIN_POD_GAP && y + height + MIN_POD_GAP > o.y;

    if (overlapX && overlapY) {
      // Find the smallest push to resolve the overlap
      const pushRight = (o.x + o.width + MIN_POD_GAP) - x;
      const pushLeft = x + width + MIN_POD_GAP - o.x;
      const pushDown = (o.y + o.height + MIN_POD_GAP) - y;
      const pushUp = y + height + MIN_POD_GAP - o.y;

      const minPush = Math.min(pushRight, pushLeft, pushDown, pushUp);
      if (minPush === pushRight) x = o.x + o.width + MIN_POD_GAP;
      else if (minPush === pushLeft) x = o.x - width - MIN_POD_GAP;
      else if (minPush === pushDown) y = o.y + o.height + MIN_POD_GAP;
      else y = o.y - height - MIN_POD_GAP;
    }
  }

  return { x, y, width, height };
}

interface FlightPodProps {
  podId: string;
  workspaceId: string;
  zoom: number;
  isSelected?: boolean;
}

export const FlightPod = React.memo(function FlightPod({
  podId,
  workspaceId,
  zoom,
  isSelected,
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
  const suppressClickRef = useRef(false);

  // Track whether user has clicked "Start" for Claude pods (when no ptyId on restore)
  const [claudeLaunched, setClaudeLaunched] = useState(!!podPtyId);

  // Derive basename for display
  const cwdBasename = useMemo(() => {
    if (!podCwd) return "Terminal";
    const parts = podCwd.replace(/\/$/, "").split("/");
    return parts[parts.length - 1] || podCwd;
  }, [podCwd]);

  // Use capture phase so we see mousedown before xterm's stopPropagation
  React.useEffect(() => {
    const el = podRef.current;
    if (!el) return;
    const handler = () => bringPodToFront(workspaceId, podId);
    el.addEventListener("mousedown", handler, true); // capture: true
    return () => el.removeEventListener("mousedown", handler, true);
  }, [bringPodToFront, workspaceId, podId]);

  const handleHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return; // Only left-click starts drag
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
      suppressClickRef.current = true; // Suppress click after drag
      const dx = (me.clientX - dragState.current.startX) / zoom;
      const dy = (me.clientY - dragState.current.startY) / zoom;
      const rawX = dragState.current.origX + dx;
      const rawY = dragState.current.origY + dy;

      // Get other pods for snapping
      const store = useWorkspaceStore.getState();
      const pods = store.flightLayouts[workspaceId]?.pods ?? [];
      const others = pods.filter((p) => p.id !== podId).map((p) => ({ x: p.x, y: p.y, width: p.width, height: p.height }));
      const snapped = snapToNeighbors({ x: rawX, y: rawY, width: podWidth, height: podHeight }, others, "drag");
      const final = preventOverlap(snapped, others);

      updateFlightPod(workspaceId, podId, {
        x: final.x,
        y: final.y,
      } as Partial<FlightPodType>);
    };

    const onMouseUp = () => {
      dragState.current = null;
      document.querySelectorAll("[data-flight-pod]").forEach((el) => {
        (el as HTMLElement).style.pointerEvents = "";
      });
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      // Reset suppressClick after the click event fires
      setTimeout(() => { suppressClickRef.current = false; }, 0);
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

  // Drag the footer bar to resize the shell panel
  const shellResizeRef = useRef<{ startY: number; origHeight: number } | null>(null);
  const handleShellResizeStart = useCallback((e: React.MouseEvent) => {
    if (!shellExpanded) return; // Only resize when expanded
    e.preventDefault();
    e.stopPropagation();
    shellResizeRef.current = { startY: e.clientY, origHeight: shellHeight };

    const onMove = (me: MouseEvent) => {
      if (!shellResizeRef.current) return;
      // Dragging UP = larger shell (negative dy = increase height)
      const dy = (me.clientY - shellResizeRef.current.startY) / zoom;
      const newH = Math.max(80, shellResizeRef.current.origHeight - dy);
      updateFlightPod(workspaceId, podId, { shellHeight: newH } as Partial<FlightPodType>);
    };
    const onUp = () => {
      shellResizeRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [shellExpanded, shellHeight, zoom, workspaceId, podId, updateFlightPod]);

  const handlePtySpawned = useCallback((ptyId: string) => {
    updateFlightPod(workspaceId, podId, { ptyId } as Partial<FlightPodType>);
  }, [updateFlightPod, workspaceId, podId]);

  const handleShellPtySpawned = useCallback((ptyId: string) => {
    updateFlightPod(workspaceId, podId, { shellPtyId: ptyId } as Partial<FlightPodType>);
  }, [updateFlightPod, workspaceId, podId]);

  const setFlightViewport = useWorkspaceStore((s) => s.setFlightViewport);

  const handleFocusClick = useCallback((e: React.MouseEvent) => {
    // Don't fire after a drag
    if (suppressClickRef.current) return;
    // Don't steal focus if clicking inside the shell panel
    if ((e.target as HTMLElement).closest("[data-shell-panel]")) return;

    // When zoomed out past threshold, click zooms to fit this pod in the viewport
    if (zoom < ZOOM_TO_FIT_THRESHOLD) {
      const container = podRef.current?.closest("[data-flight-canvas]") as HTMLElement | null;
      if (container) {
        const rect = container.getBoundingClientRect();
        // Account for CSS zoom on ancestors — rect is in viewport pixels
        const parentZoom = rect.width / container.offsetWidth;
        const containerW = rect.width / parentZoom;
        const containerH = rect.height / parentZoom;
        const viewW = containerW * 0.9;
        const viewH = containerH * 0.9;
        const fitZoom = Math.min(viewW / podWidth, viewH / podHeight, 1.0);
        // Center the pod. Pan formula depends on zoom mode:
        // zoom >= 1: screen = (pan + P) * zoom → pan = screen/zoom - P
        // zoom < 1: screen = pan + P * zoom → pan = screen - P * zoom
        const centerX = containerW / 2;
        const centerY = containerH / 2;
        const podCenterX = podX + podWidth / 2;
        const podCenterY = podY + podHeight / 2;
        let panX: number, panY: number;
        if (fitZoom >= 1.0) {
          panX = centerX / fitZoom - podCenterX;
          panY = centerY / fitZoom - podCenterY;
        } else {
          panX = centerX - podCenterX * fitZoom;
          panY = centerY - podCenterY * fitZoom;
        }
        setFlightViewport(workspaceId, { panX, panY, zoom: fitZoom });
      }
      return;
    }
    // If showing the launcher, start Claude on click
    if (podType === "claude" && !claudeLaunched && !podPtyId) {
      setClaudeLaunched(true);
      return;
    }
    // Focus the MAIN terminal (first one, not shell)
    if (!podRef.current) return;
    const mainTerminal = podRef.current.querySelector("[data-main-terminal] textarea.xterm-helper-textarea") as HTMLTextAreaElement | null;
    if (mainTerminal) mainTerminal.focus();
  }, [zoom, podX, podY, podWidth, podHeight, workspaceId, setFlightViewport, podType, claudeLaunched, podPtyId]);

  if (!podType) return null;

  const isClaudePod = podType === "claude";
  const HEADER_H = 32;
  const FOOTER_H = isClaudePod ? 24 : 0;
  const terminalBodyHeight = isClaudePod && shellExpanded
    ? podHeight - HEADER_H - FOOTER_H - shellHeight
    : podHeight - HEADER_H - FOOTER_H;

  return (
    <>
    <div
      ref={podRef}
      data-flight-pod={podId}
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
        border: isSelected ? "1px solid rgba(100, 160, 255, 0.5)" : "1px solid rgba(255, 255, 255, 0.08)",
        borderRadius: 10,
        boxShadow: isSelected ? "0 0 0 2px rgba(100, 160, 255, 0.3), 0 2px 12px rgba(0, 0, 0, 0.2)" : "0 2px 12px rgba(0, 0, 0, 0.2)",
        overflow: "hidden",
        userSelect: "none",
      }}
    >
      {/* Header */}
      <div
        onMouseDown={handleHeaderMouseDown}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const store = useWorkspaceStore.getState();
          const GAP = 8;
          const layout = store.flightLayouts[workspaceId];
          if (!layout) return;

          const insertPod = (dir: "right" | "left" | "below" | "above") => {
            const w = FLIGHT_DEFAULT_CLAUDE_WIDTH;
            const h = FLIGHT_DEFAULT_CLAUDE_HEIGHT;
            let nx: number, ny: number, nw: number, nh: number;
            switch (dir) {
              case "right": nx = podX + podWidth + GAP; ny = podY; nw = w; nh = podHeight; break;
              case "left": nx = podX - w - GAP; ny = podY; nw = w; nh = podHeight; break;
              case "below": nx = podX; ny = podY + podHeight + GAP; nw = podWidth; nh = h; break;
              case "above": nx = podX; ny = podY - h - GAP; nw = podWidth; nh = h; break;
            }

            // Push existing pods out of the way
            const pushAmount = dir === "right" || dir === "left" ? nw + GAP : nh + GAP;
            for (const p of layout.pods) {
              if (p.id === podId) continue;
              if (dir === "right" && p.x >= nx - GAP && p.y < podY + podHeight && p.y + p.height > podY) {
                store.updateFlightPod(workspaceId, p.id, { x: p.x + pushAmount } as any);
              } else if (dir === "left" && p.x + p.width <= podX + GAP && p.y < podY + podHeight && p.y + p.height > podY) {
                store.updateFlightPod(workspaceId, p.id, { x: p.x - pushAmount } as any);
              } else if (dir === "below" && p.y >= ny - GAP && p.x < podX + podWidth && p.x + p.width > podX) {
                store.updateFlightPod(workspaceId, p.id, { y: p.y + pushAmount } as any);
              } else if (dir === "above" && p.y + p.height <= podY + GAP && p.x < podX + podWidth && p.x + p.width > podX) {
                store.updateFlightPod(workspaceId, p.id, { y: p.y - pushAmount } as any);
              }
            }

            store.addFlightPodAt(workspaceId, "claude", nx, ny, nw, nh, podCwd);
          };
          showContextMenu([
            { label: "New Right", action: () => insertPod("right") },
            { label: "New Left", action: () => insertPod("left") },
            { label: "New Above", action: () => insertPod("above") },
            { label: "New Below", action: () => insertPod("below") },
          ]);
        }}
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

        {/* Right: close */}
        <div style={headerStyles.right}>
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
        data-main-terminal=""
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
          <FlightLauncher
            cwd={podCwd}
            cwdBasename={cwdBasename}
            workspaceId={workspaceId}
            onLaunch={() => setClaudeLaunched(true)}
            onLaunchClaude={(cwd) => {
              if (cwd && cwd !== podCwd) {
                updateFlightPod(workspaceId, podId, { cwd, title: cwd.split("/").pop() || "Claude Code" } as Partial<FlightPodType>);
              }
              setClaudeLaunched(true);
            }}
            onLaunchTerminal={(cwd) => {
              // Spawn a new terminal pod next to this one
              const store = useWorkspaceStore.getState();
              store.addFlightPodAt(
                workspaceId, "terminal",
                podX + podWidth + 8, podY,
                FLIGHT_DEFAULT_TERMINAL_WIDTH, podHeight,
                cwd || podCwd,
              );
            }}
          />
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

      {/* Shell footer + expandable panel (Claude pods only) */}
      {isClaudePod && (
        <>
          {/* Footer bar — click to toggle, top edge drag to resize when expanded */}
          <div
            onClick={(e) => { if (!shellResizeRef.current) { e.stopPropagation(); handleShellToggle(e); } }}
            style={{ ...shellFooterStyles.bar, cursor: "pointer", position: "relative" as const }}
          >
            {/* Thin resize handle at top edge of footer (only when expanded) */}
            {shellExpanded && (
              <div
                onMouseDown={handleShellResizeStart}
                style={{ position: "absolute", top: -2, left: 0, right: 0, height: 6, cursor: "ns-resize", zIndex: 2 }}
              />
            )}
            <div style={shellFooterStyles.left}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                <path d="M4 5l3 3-3 3" stroke="var(--status-green)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <line x1="9" y1="11" x2="13" y2="11" stroke="var(--status-green)" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <span style={shellFooterStyles.label}>{cwdBasename}</span>
            </div>
          </div>

          {/* Expandable shell terminal */}
          <div
            data-shell-panel=""
            style={{
              display: shellExpanded ? "flex" : "none",
              flexDirection: "column",
              height: shellHeight,
              minHeight: 0,
              background: "var(--terminal-bg)",
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
        </>
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

    {/* Edge spawn buttons disabled — use right-click on canvas instead
    <EdgeSpawnButtons
      podX={podX}
      podY={podY}
      podWidth={podWidth}
      podHeight={podHeight}
      podZIndex={podZIndex}
      podCwd={podCwd}
      workspaceId={workspaceId}
      podId={podId}
    /> */}
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

/** Launcher shown inside Claude pods that haven't started yet */
function FlightLauncher({ cwd, cwdBasename, workspaceId, onLaunch, onLaunchClaude, onLaunchTerminal }: {
  cwd: string;
  cwdBasename: string;
  workspaceId: string;
  onLaunch: () => void;
  onLaunchClaude: (cwd: string) => void;
  onLaunchTerminal: (cwd: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const ws = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const paths = ws?.paths ?? [cwd];

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const folderName = (p: string) => p.split("/").pop() || p;
  const shortenPath = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

  return (
    <div style={launcherStyles.container}>
      <div className="launch-btn" style={launcherStyles.main} onClick={onLaunch}>
        <svg width="40" height="40" viewBox="-2 -1 28 26" style={{ flexShrink: 0 }}>
          <path d={CLAUDE_PATH} fill="#D97757" fillRule="nonzero" data-keep-color="" />
        </svg>
        <span style={launcherStyles.name}>Claude Code</span>
        <span style={launcherStyles.path}>{cwdBasename}</span>
      </div>
      <div ref={dropdownRef} style={launcherStyles.dropdownWrapper}>
        <span
          style={launcherStyles.trigger}
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        >
          or open ▾
        </span>
        {open && (
          <div style={launcherStyles.menu}>
            <div style={launcherStyles.menuSection}>Claude Code</div>
            {paths.map((p) => (
              <div
                key={`claude-${p}`}
                className="sidebar-btn"
                style={launcherStyles.menuItem}
                onClick={() => { setOpen(false); onLaunchClaude(p); }}
              >
                <svg width="11" height="11" viewBox="-2 -1 28 26" fill="none" style={{ flexShrink: 0 }}>
                  <path d={CLAUDE_PATH} fill="#D97757" fillRule="nonzero" data-keep-color="" />
                </svg>
                <span style={launcherStyles.menuItemText}>{folderName(p)}</span>
                {paths.length > 1 && <span style={launcherStyles.menuItemPath}>{shortenPath(p)}</span>}
              </div>
            ))}
            <div style={launcherStyles.menuDivider} />
            <div style={launcherStyles.menuSection}>Terminal</div>
            {paths.map((p) => (
              <div
                key={`term-${p}`}
                className="sidebar-btn"
                style={launcherStyles.menuItem}
                onClick={() => { setOpen(false); onLaunchTerminal(p); }}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                  <path d="M4 5l3 3-3 3" stroke="var(--status-green)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  <line x1="9" y1="11" x2="13" y2="11" stroke="var(--status-green)" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <span style={launcherStyles.menuItemText}>{folderName(p)}</span>
                {paths.length > 1 && <span style={launcherStyles.menuItemPath}>{shortenPath(p)}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

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

  const computePosition = useCallback(
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
      return { x, y, w, h };
    },
    [podX, podY, podWidth, podHeight],
  );

  const spawn = useCallback(
    (type: "claude" | "terminal", edge: "top" | "right" | "bottom" | "left") => {
      const { x, y, w, h } = computePosition(type, edge);
      addFlightPodAt(workspaceId, type, x, y, w, h, podCwd);
    },
    [addFlightPodAt, computePosition, podCwd, workspaceId],
  );

  const spawnWithPicker = useCallback(
    (type: "claude" | "terminal", edge: "top" | "right" | "bottom" | "left") => {
      const store = useWorkspaceStore.getState();
      const ws = store.workspaces.find((w) => w.id === workspaceId);
      const paths = ws?.paths ?? [];
      if (paths.length <= 1) {
        spawn(type, edge);
        return;
      }
      const { x, y, w, h } = computePosition(type, edge);
      showContextMenu(
        paths.map((p) => ({
          label: p.split("/").pop() || p,
          action: () => addFlightPodAt(workspaceId, type, x, y, w, h, p),
        })),
      );
    },
    [addFlightPodAt, computePosition, spawn, workspaceId],
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
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); spawnWithPicker("claude", edge); }}
              title="Add Claude pod (right-click for repo picker)"
              style={edgeBtnStyle}
            >
              <svg width="14" height="14" viewBox="-2 -1 28 26" fill="none">
                <path d={CLAUDE_PATH} fill="#D97757" fillRule="nonzero" />
              </svg>
            </button>
            <button
              className="flight-edge-btn"
              onClick={(e) => { e.stopPropagation(); spawn("terminal", edge); }}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); spawnWithPicker("terminal", edge); }}
              title="Add Terminal pod (right-click for repo picker)"
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
    background: "rgb(30, 30, 30)",
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
    fontSize: 13,
    fontWeight: 500,
    color: "var(--text-primary)",
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
    paddingBottom: "21%",
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
  dropdownWrapper: {
    position: "relative" as const,
    marginTop: 2,
    textAlign: "center" as const,
  },
  trigger: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-dim)",
    cursor: "pointer",
    letterSpacing: "0.02em",
  },
  menu: {
    position: "absolute" as const,
    bottom: "calc(100% + 4px)",
    left: "50%",
    transform: "translateX(-50%)",
    background: "rgba(36, 36, 36, 0.78)",
    backdropFilter: "blur(20px) saturate(180%)",
    WebkitBackdropFilter: "blur(20px) saturate(180%)",
    border: "1px solid rgba(255, 255, 255, 0.12)",
    borderRadius: 6,
    padding: "4px 0",
    minWidth: 180,
    zIndex: 20,
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.4)",
  },
  menuSection: {
    padding: "5px 12px 3px",
    fontSize: 10,
    fontWeight: 600,
    color: "var(--text-primary)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
  },
  menuDivider: {
    height: 1,
    background: "rgba(255, 255, 255, 0.08)",
    margin: "4px 0",
  },
  menuItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "5px 12px",
    fontSize: 12,
    color: "var(--text-primary)",
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
    background: "none",
    border: "none",
    width: "100%",
    textAlign: "left" as const,
  },
  menuItemText: {
    fontWeight: 500,
  },
  menuItemPath: {
    fontSize: 11,
    color: "var(--text-dim)",
    marginLeft: "auto",
    paddingLeft: 8,
  },
};

const shellFooterStyles: Record<string, React.CSSProperties> = {
  bar: {
    height: 24,
    minHeight: 24,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 8px",
    borderTop: "1px solid rgba(255, 255, 255, 0.06)",
    cursor: "pointer",
    userSelect: "none",
    flexShrink: 0,
    background: "rgb(30, 30, 30)",
  },
  left: {
    display: "flex",
    alignItems: "center",
    gap: 5,
  },
  label: {
    fontSize: 13,
    fontWeight: 500,
    color: "var(--text-primary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    lineHeight: 1,
  },
};
