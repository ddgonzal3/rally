import React, { useRef, useCallback, useMemo, useEffect } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { Terminal } from "./Terminal";
import { SplitContainer } from "./SplitContainer";
import { api } from "../lib/tauri";
import { showContextMenu } from "../lib/contextMenu";
import { setLastFocusedFlightPodId } from "../lib/flightState";
import { FlightPodFooter } from "./FlightPodFooter";
import type { FlightPod as FlightPodType } from "../lib/types";
import {
  FLIGHT_MIN_CLAUDE_WIDTH,
  FLIGHT_MIN_CLAUDE_HEIGHT,
  FLIGHT_MIN_TERMINAL_WIDTH,
  FLIGHT_MIN_TERMINAL_HEIGHT,
  FLIGHT_DEFAULT_CLAUDE_WIDTH,
  FLIGHT_DEFAULT_CLAUDE_HEIGHT,
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
const OVERLAP_OVERRIDE_DEPTH = 30; // How far past snap the user must drag to allow overlap

/** Push a pod out of any overlapping neighbors. Returns adjusted x/y.
 *  If rawPos is provided, overlap prevention is skipped when the user
 *  has dragged far enough past the snap boundary (intentional overlap). */
export function preventOverlap(
  moving: SnapEdges,
  others: SnapEdges[],
  rawPos?: { x: number; y: number },
): SnapEdges {
  let { x, y } = moving;
  const { width, height } = moving;

  for (const o of others) {
    // Check if they overlap (with MIN_POD_GAP margin)
    const overlapX = x < o.x + o.width + MIN_POD_GAP && x + width + MIN_POD_GAP > o.x;
    const overlapY = y < o.y + o.height + MIN_POD_GAP && y + height + MIN_POD_GAP > o.y;

    if (overlapX && overlapY) {
      // If we have the raw cursor position, check if the user is pushing
      // deep enough into the overlap to signal they want stacking
      if (rawPos) {
        const rawOverlapX = rawPos.x < o.x + o.width + MIN_POD_GAP && rawPos.x + width + MIN_POD_GAP > o.x;
        const rawOverlapY = rawPos.y < o.y + o.height + MIN_POD_GAP && rawPos.y + height + MIN_POD_GAP > o.y;

        if (rawOverlapX && rawOverlapY) {
          // Measure how deep the raw position is into the overlap zone
          const depthRight = (o.x + o.width + MIN_POD_GAP) - rawPos.x;
          const depthLeft = rawPos.x + width + MIN_POD_GAP - o.x;
          const depthDown = (o.y + o.height + MIN_POD_GAP) - rawPos.y;
          const depthUp = rawPos.y + height + MIN_POD_GAP - o.y;
          const minDepth = Math.min(depthRight, depthLeft, depthDown, depthUp);

          // User has pushed well past the snap — let them overlap
          if (minDepth > OVERLAP_OVERRIDE_DEPTH) {
            x = rawPos.x;
            y = rawPos.y;
            continue;
          }
        }
      }

      // Normal push-out behavior
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

// Re-export from shared module for backwards compatibility
export { lastFocusedFlightPodId } from "../lib/flightState";

export const FlightPod = React.memo(function FlightPod({
  podId,
  workspaceId,
  zoom,
  isSelected,
}: FlightPodProps) {
  const updateFlightPod = useWorkspaceStore((s) => s.updateFlightPod);
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
  const shellTabs = useWorkspaceStore((s) => s.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId)?.shellTabs);
  const activeShellTabId = useWorkspaceStore((s) => s.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId)?.activeShellTabId);
  const addFlightShellTab = useWorkspaceStore((s) => s.addFlightShellTab);
  const removeFlightShellTab = useWorkspaceStore((s) => s.removeFlightShellTab);
  const setActiveFlightShellTab = useWorkspaceStore((s) => s.setActiveFlightShellTab);
  const setFlightShellTabPtyId = useWorkspaceStore((s) => s.setFlightShellTabPtyId);

  // Pod layout: use the shared layout system
  const podLayoutId = `flight:${podId}`;
  const getOrCreatePodLayout = useWorkspaceStore((s) => s.getOrCreatePodLayout);
  const podLayoutRoot = useWorkspaceStore((s) => s.layouts[podLayoutId]?.root);

  const activeShellTab = useMemo(() => {
    if (!shellTabs || shellTabs.length === 0) return null;
    return shellTabs.find((t) => t.id === activeShellTabId) ?? shellTabs[0];
  }, [shellTabs, activeShellTabId]);

  // Derive basename for display
  const cwdBasename = useMemo(() => {
    if (!podCwd) return "Terminal";
    const parts = podCwd.replace(/\/$/, "").split("/");
    return parts[parts.length - 1] || podCwd;
  }, [podCwd]);

  const podRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const suppressClickRef = useRef(false);

  // Ensure pod layout exists
  useEffect(() => {
    if (podType) {
      getOrCreatePodLayout(podLayoutId, podCwd, podType);
    }
  }, [podLayoutId, podCwd, podType, getOrCreatePodLayout]);

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
      const final = preventOverlap(snapped, others, { x: rawX, y: rawY });

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

  // Generic edge/corner resize handler
  type ResizeEdge = "right" | "bottom" | "left" | "top" | "bottom-right" | "bottom-left" | "top-right" | "top-left";
  const handleEdgeResize = useCallback((e: React.MouseEvent, edge: ResizeEdge) => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const origX = podX;
    const origY = podY;
    const origW = podWidth;
    const origH = podHeight;

    const minW = podType === "claude" ? FLIGHT_MIN_CLAUDE_WIDTH : FLIGHT_MIN_TERMINAL_WIDTH;
    const minH = podType === "claude" ? FLIGHT_MIN_CLAUDE_HEIGHT : FLIGHT_MIN_TERMINAL_HEIGHT;

    const resizesRight = edge.includes("right");
    const resizesBottom = edge.includes("bottom");
    const resizesLeft = edge === "left" || edge === "bottom-left" || edge === "top-left";
    const resizesTop = edge === "top" || edge === "top-right" || edge === "top-left";

    const onMouseMove = (me: MouseEvent) => {
      const dx = (me.clientX - startX) / zoom;
      const dy = (me.clientY - startY) / zoom;

      let newX = origX, newY = origY, newW = origW, newH = origH;

      if (resizesRight) newW = Math.max(minW, origW + dx);
      if (resizesBottom) newH = Math.max(minH, origH + dy);
      if (resizesLeft) { newW = Math.max(minW, origW - dx); newX = origX + origW - newW; }
      if (resizesTop) { newH = Math.max(minH, origH - dy); newY = origY + origH - newH; }

      updateFlightPod(workspaceId, podId, {
        x: newX, y: newY, width: newW, height: newH,
      } as Partial<FlightPodType>);
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [podHeight, podId, podType, podWidth, podX, podY, updateFlightPod, workspaceId, zoom]);

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

  const handleShellPtySpawned = useCallback((ptyId: string) => {
    updateFlightPod(workspaceId, podId, { shellPtyId: ptyId } as Partial<FlightPodType>);
  }, [updateFlightPod, workspaceId, podId]);

  const handleFocusClick = useCallback((e: React.MouseEvent) => {
    // Don't fire after a drag
    if (suppressClickRef.current) return;
    // Don't steal focus if clicking inside the shell panel
    if ((e.target as HTMLElement).closest("[data-shell-panel]")) return;

    // When zoomed out past threshold, click enters focus mode on this pod
    if (zoom < ZOOM_TO_FIT_THRESHOLD) {
      window.dispatchEvent(new CustomEvent("flight-focus-pod", { detail: { workspaceId, podId } }));
      return;
    }
    // Focus the MAIN terminal (first one, not shell)
    if (!podRef.current) return;
    const mainTerminal = podRef.current.querySelector("[data-main-terminal] textarea.xterm-helper-textarea") as HTMLTextAreaElement | null;
    if (mainTerminal) mainTerminal.focus();
  }, [zoom, workspaceId, podId]);

  const hasScriptFooter = useWorkspaceStore((s) => {
    const config = s.rallyConfigs[podCwd];
    return !!(config?.statusBar && config.statusBar.length > 0);
  });

  if (!podType) return null;
  if (!podLayoutRoot) return null;

  const isClaudePod = podType === "claude";
  const SHELL_FOOTER_H = isClaudePod && shellExpanded ? 29 : 0;
  const SCRIPT_FOOTER_H = isClaudePod && hasScriptFooter ? 28 : 0;
  const FOOTER_H = SHELL_FOOTER_H + SCRIPT_FOOTER_H;
  const terminalBodyHeight = isClaudePod && shellExpanded
    ? podHeight - FOOTER_H - shellHeight
    : podHeight - FOOTER_H;

  return (
    <>
    <div
      ref={podRef}
      data-flight-pod={podId}
      onMouseDownCapture={() => { setLastFocusedFlightPodId(podId); }}
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
        cursor: zoom < ZOOM_TO_FIT_THRESHOLD ? "zoom-in" : undefined,
      }}
    >
      {/* Main terminal body — uses shared layout system */}
      <div
        data-main-terminal=""
        style={{
          flex: shellExpanded ? "none" : 1,
          height: shellExpanded ? terminalBodyHeight : undefined,
          minHeight: 0,
          display: "flex",
          overflow: "hidden",
        }}
      >
        <SplitContainer
          node={podLayoutRoot}
          workspaceId={podLayoutId}
          workspacePath={podCwd}
          isRoot
        />
      </div>

      {/* Shell tab bar + expandable panel (Claude pods only, hidden when collapsed) */}
      {isClaudePod && shellExpanded && (
        <>
          {/* Shell tab bar — matches Claude tab bar style */}
          <div
            style={{ ...tabBarStyles.bar, borderTop: "1px solid rgba(255, 255, 255, 0.06)", position: "relative" as const }}
          >
            {/* Resize handle at top edge (only when expanded) */}
            {shellExpanded && (
              <div
                onMouseDown={handleShellResizeStart}
                style={{ position: "absolute", top: -2, left: 0, right: 0, height: 6, cursor: "ns-resize", zIndex: 2 }}
              />
            )}
            <div style={tabBarStyles.tabs}>
              {shellTabs && shellTabs.length > 0 ? (
                shellTabs.map((tab) => {
                  const isActive = tab.id === (activeShellTabId ?? shellTabs[0]?.id);
                  return (
                    <div
                      key={tab.id}
                      className={`pane-tab${isActive ? " pane-tab-active" : ""}`}
                      onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        e.stopPropagation();
                        setActiveFlightShellTab(workspaceId, podId, tab.id);
                        if (!shellExpanded) handleShellToggle(e as any);
                      }}
                      style={{ ...tabBarStyles.tab, ...(isActive ? tabBarStyles.tabActive : tabBarStyles.tabInactive) }}
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ flexShrink: 0 }}>
                        <polyline points="2,4 5,6 2,8" stroke="#999" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                        <line x1="6" y1="8" x2="10" y2="8" stroke="#999" strokeWidth="1.2" strokeLinecap="round" />
                      </svg>
                      <span style={tabBarStyles.tabLabel}>{tab.title}</span>
                      <button
                        className={`tab-close${isActive ? " tab-close-active" : ""}`}
                        style={tabBarStyles.tabClose}
                        data-close=""
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); removeFlightShellTab(workspaceId, podId, tab.id); }}
                      >
                        <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
                          <line x1="3" y1="3" x2="11" y2="11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                          <line x1="11" y1="3" x2="3" y2="11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      </button>
                    </div>
                  );
                })
              ) : (
                /* Legacy single shell tab */
                <div
                  className="pane-tab pane-tab-active"
                  onMouseDown={(e) => { e.stopPropagation(); if (!shellExpanded) handleShellToggle(e as any); }}
                  style={{ ...tabBarStyles.tab, ...tabBarStyles.tabActive }}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ flexShrink: 0 }}>
                    <polyline points="2,4 5,6 2,8" stroke="#999" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                    <line x1="6" y1="8" x2="10" y2="8" stroke="#999" strokeWidth="1.2" strokeLinecap="round" />
                  </svg>
                  <span style={tabBarStyles.tabLabel}>{cwdBasename}</span>
                  <button
                    className="tab-close tab-close-active"
                    style={tabBarStyles.tabClose}
                    data-close=""
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (shellPtyId) api.killPty(shellPtyId).catch(() => {});
                      updateFlightPod(workspaceId, podId, { shellExpanded: false, shellPtyId: undefined } as any);
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
                      <line x1="3" y1="3" x2="11" y2="11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      <line x1="11" y1="3" x2="3" y2="11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              )}
              <button
                className="tab-action new-tab-btn"
                style={tabBarStyles.newTabBtn}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); addFlightShellTab(workspaceId, podId, podCwd); if (!shellExpanded) handleShellToggle(e as any); }}
                title="New terminal tab"
              >
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                  <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div style={tabBarStyles.actions} />
          </div>

          {/* Expandable shell terminal */}
          <div
            data-shell-panel=""
            data-shell-area=""
            style={{
              display: shellExpanded ? "flex" : "none",
              flexDirection: "column",
              height: shellHeight,
              minHeight: 0,
              background: "var(--terminal-bg)",
              overflow: "hidden",
            }}
          >
            {activeShellTab ? (
              <Terminal
                key={activeShellTab.id}
                cwd={activeShellTab.cwd}
                ptyId={activeShellTab.ptyId}
                workspaceId={workspaceId}
                onPtySpawned={(ptyId) => setFlightShellTabPtyId(workspaceId, podId, activeShellTab.id, ptyId)}
              />
            ) : (
              <Terminal
                cwd={podCwd}
                ptyId={shellPtyId}
                workspaceId={workspaceId}
                onPtySpawned={handleShellPtySpawned}
              />
            )}
          </div>
        </>
      )}

      {/* Script footer — shows rally.json statusBar scripts for this pod's repo */}
      {isClaudePod && <FlightPodFooter repoPath={podCwd} onOpenTerminal={!shellExpanded ? () => togglePodShell(workspaceId, podId) : undefined} />}

      {/* Invisible resize edges and corners */}
      {([
        { edge: "top" as ResizeEdge, style: { top: -3, left: 6, right: 6, height: 6, cursor: "ns-resize" } },
        { edge: "bottom" as ResizeEdge, style: { bottom: -3, left: 6, right: 6, height: 6, cursor: "ns-resize" } },
        { edge: "left" as ResizeEdge, style: { left: -3, top: 6, bottom: 6, width: 6, cursor: "ew-resize" } },
        { edge: "right" as ResizeEdge, style: { right: -3, top: 6, bottom: 6, width: 6, cursor: "ew-resize" } },
        { edge: "top-left" as ResizeEdge, style: { top: -3, left: -3, width: 10, height: 10, cursor: "nwse-resize" } },
        { edge: "top-right" as ResizeEdge, style: { top: -3, right: -3, width: 10, height: 10, cursor: "nesw-resize" } },
        { edge: "bottom-left" as ResizeEdge, style: { bottom: -3, left: -3, width: 10, height: 10, cursor: "nesw-resize" } },
        { edge: "bottom-right" as ResizeEdge, style: { bottom: -3, right: -3, width: 10, height: 10, cursor: "nwse-resize" } },
      ] as const).map(({ edge, style }) => (
        <div
          key={edge}
          onMouseDown={(e) => handleEdgeResize(e, edge)}
          style={{ position: "absolute", zIndex: 10, ...style }}
        />
      ))}
    </div>

    </>
  );
});

const ZOOM_TO_FIT_THRESHOLD = 0.65; // Below this zoom level, clicking a pod zooms to fit it

const tabBarStyles: Record<string, React.CSSProperties> = {
  bar: {
    height: 29,
    display: "flex",
    alignItems: "stretch",
    justifyContent: "space-between",
    cursor: "grab",
    flexShrink: 0,
    background: "var(--bg-surface)",
  },
  tabs: {
    display: "flex",
    alignItems: "stretch",
    minWidth: 0,
    overflow: "hidden",
    flex: 1,
  },
  tab: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    padding: "0 6px 0 8px",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
    minWidth: 0,
  },
  tabActive: {
    color: "var(--text-primary)",
    background: "var(--bg-app)",
    borderTop: "1px solid var(--tab-indicator)",
    marginBottom: -1,
    paddingBottom: 1,
  },
  tabInactive: {
    color: "var(--text-dim)",
    background: "var(--bg-surface)",
    borderRight: "1px solid var(--bg-elevated)",
    boxShadow: "inset 0 -1px 0 var(--bg-elevated)",
  },
  tabLabel: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontWeight: 600,
  },
  tabClose: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 20,
    height: 20,
    background: "none",
    border: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
    borderRadius: 4,
    padding: 0,
    flexShrink: 0,
  },
  newTabBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    width: 20,
    minWidth: 20,
    height: 20,
    background: "var(--bg-surface)",
    border: "none",
    color: "var(--text-dim)",
    cursor: "pointer",
    borderRadius: 4,
    padding: 0,
    flexShrink: 0,
    marginLeft: 2,
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    flexShrink: 0,
    paddingRight: 4,
  },
  actionBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 20,
    height: 20,
    background: "none",
    border: "none",
    color: "var(--text-dim)",
    cursor: "pointer",
    borderRadius: 4,
    padding: 0,
  },
};

