import React, { useEffect, useRef, useMemo } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { FlightPod } from "./FlightPod";
import { FlightHUD } from "./FlightHUD";
import { FLIGHT_ZOOM_MIN, FLIGHT_ZOOM_MAX } from "../lib/types";

/** Renders a single workspace's flight canvas. Hidden via display:none when inactive. */
const WorkspaceFlightView = React.memo(function WorkspaceFlightView({
  workspaceId,
  isActive,
}: {
  workspaceId: string;
  isActive: boolean;
}) {
  const getOrCreateFlightLayout = useWorkspaceStore((s) => s.getOrCreateFlightLayout);
  const setFlightViewport = useWorkspaceStore((s) => s.setFlightViewport);
  const containerRef = useRef<HTMLDivElement>(null);

  // Stable selectors — primitives only, no new objects
  const panX = useWorkspaceStore((s) => s.flightLayouts[workspaceId]?.viewport?.panX ?? 0);
  const panY = useWorkspaceStore((s) => s.flightLayouts[workspaceId]?.viewport?.panY ?? 0);
  const zoom = useWorkspaceStore((s) => s.flightLayouts[workspaceId]?.viewport?.zoom ?? 1.0);

  const podIds = useWorkspaceStore((s) => {
    const pods = s.flightLayouts[workspaceId]?.pods;
    if (!pods) return "";
    return pods.map((p) => p.id).join("\n");
  });
  const podIdList = useMemo(
    () => (podIds ? podIds.split("\n") : []),
    [podIds]
  );

  useEffect(() => {
    getOrCreateFlightLayout(workspaceId);
  }, [workspaceId, getOrCreateFlightLayout]);

  // Native wheel listener — MUST be non-passive to call preventDefault()
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const store = useWorkspaceStore.getState();
      const vp = store.flightLayouts[workspaceId]?.viewport;
      if (!vp) return;
      // altKey = Option+scroll, ctrlKey = trackpad pinch gesture
      if (e.altKey || e.ctrlKey) {
        const zoomFactor = 1 - e.deltaY * (e.ctrlKey ? 0.01 : 0.002);
        const newZoom = Math.max(FLIGHT_ZOOM_MIN, Math.min(FLIGHT_ZOOM_MAX, vp.zoom * zoomFactor));
        // Hybrid zoom: CSS zoom >= 1.0, transform scale < 1.0
        // Both use translate3d for pan. The mapping from canvas point P to
        // screen position differs:
        //   CSS zoom:       screen = (pan + P) * zoom   (zoom multiplies everything)
        //   transform scale: screen = pan + P * zoom     (zoom only scales content)
        // To keep cursor-point fixed, compute the canvas point under cursor,
        // then solve for new pan.
        const rect = el.getBoundingClientRect();
        const parentZoom = rect.width / el.offsetWidth;
        const cx = (e.clientX - rect.left) / parentZoom;
        const cy = (e.clientY - rect.top) / parentZoom;

        // Canvas point under cursor with OLD zoom:
        let pointX: number, pointY: number;
        if (vp.zoom >= 1.0) {
          // CSS zoom: screen = (pan + P) * zoom → P = screen/zoom - pan
          pointX = cx / vp.zoom - vp.panX;
          pointY = cy / vp.zoom - vp.panY;
        } else {
          // transform scale: screen = pan + P * zoom → P = (screen - pan) / zoom
          pointX = (cx - vp.panX) / vp.zoom;
          pointY = (cy - vp.panY) / vp.zoom;
        }

        // New pan so same point stays at same screen position with NEW zoom:
        let newPanX: number, newPanY: number;
        if (newZoom >= 1.0) {
          // CSS zoom: cx = (pan + P) * zoom → pan = cx/zoom - P
          newPanX = cx / newZoom - pointX;
          newPanY = cy / newZoom - pointY;
        } else {
          // transform scale: cx = pan + P * zoom → pan = cx - P * zoom
          newPanX = cx - pointX * newZoom;
          newPanY = cy - pointY * newZoom;
        }

        store.setFlightViewport(workspaceId, {
          panX: newPanX, panY: newPanY, zoom: newZoom,
        });
      } else {
        store.setFlightViewport(workspaceId, {
          panX: vp.panX - e.deltaX,
          panY: vp.panY - e.deltaY,
        });
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [workspaceId, setFlightViewport]);

  return (
    <div
      ref={containerRef}
      style={{ ...canvasStyles.canvas, display: isActive ? "flex" : "none" }}
    >
      <div
        style={{
          ...canvasStyles.viewport,
          // CSS zoom > 1.0: re-rasterizes at higher res → crisp upscale
          // transform scale < 1.0: pixel-perfect downscale → crisp shrink
          // Hybrid gives sharp text at ALL zoom levels
          ...(zoom >= 1.0
            ? { transform: `translate3d(${panX}px, ${panY}px, 0)`, zoom: zoom }
            : { transform: `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})`, transformOrigin: "0 0" }
          ),
        }}
      >
        {podIdList.map((podId) => (
          <FlightPod key={podId} podId={podId} workspaceId={workspaceId} zoom={zoom} />
        ))}
      </div>
      {isActive && <FlightHUD workspaceId={workspaceId} zoom={zoom} />}
    </div>
  );
});

export function FlightCanvas() {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const hasActiveWorkspace = useWorkspaceStore(
    (s) => !!s.activeWorkspaceId && s.workspaces.some((w) => w.id === s.activeWorkspaceId)
  );

  // Collect IDs of all workspaces that have flight layouts (or are active),
  // as a stable string to avoid returning new arrays from the selector.
  const mountedIdsString = useWorkspaceStore((s) => {
    const wsIds = new Set(s.workspaces.map((w) => w.id));
    const ids = new Set<string>();
    for (const id of Object.keys(s.flightLayouts)) {
      if (wsIds.has(id)) ids.add(id);
    }
    if (s.activeWorkspaceId && wsIds.has(s.activeWorkspaceId)) {
      ids.add(s.activeWorkspaceId);
    }
    return Array.from(ids).join("\n");
  });
  const mountedIds = useMemo(
    () => (mountedIdsString ? mountedIdsString.split("\n") : []),
    [mountedIdsString]
  );

  if (!hasActiveWorkspace) {
    return (
      <div style={canvasStyles.empty}>
        <div style={canvasStyles.emptyText}>
          No workspace selected.
          <br />
          Add a workspace from the sidebar to get started.
        </div>
      </div>
    );
  }

  return (
    <div style={canvasStyles.container}>
      {mountedIds.map((wsId) => (
        <WorkspaceFlightView
          key={wsId}
          workspaceId={wsId}
          isActive={wsId === activeWorkspaceId}
        />
      ))}
    </div>
  );
}

const canvasStyles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    display: "flex",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    position: "relative",
  },
  canvas: {
    flex: 1,
    position: "relative",
    overflow: "hidden",
    background: "transparent",
    cursor: "default",
  },
  viewport: {
    position: "absolute",
    top: 0,
    left: 0,
    willChange: "transform",
  },
  empty: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    textAlign: "center" as const,
    color: "var(--text-dim)",
    fontSize: 14,
    lineHeight: 1.6,
  },
};
