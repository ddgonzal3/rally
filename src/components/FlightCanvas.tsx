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
        // Viewport uses: transform: translate3d(panX, panY, 0) + CSS zoom.
        // With CSS zoom on same element as translate, the visual position of
        // a canvas point P in the container is: (panX + P.x) * zoom.
        // To keep the point under cursor fixed when zoom changes:
        //   panX' = panX + cursorInContainer * (1/newZoom - 1/oldZoom)
        const rect = el.getBoundingClientRect();
        const parentZoom = rect.width / el.offsetWidth;
        const cursorInContainerX = (e.clientX - rect.left) / parentZoom;
        const cursorInContainerY = (e.clientY - rect.top) / parentZoom;
        store.setFlightViewport(workspaceId, {
          panX: vp.panX + cursorInContainerX * (1 / newZoom - 1 / vp.zoom),
          panY: vp.panY + cursorInContainerY * (1 / newZoom - 1 / vp.zoom),
          zoom: newZoom,
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
          transform: `translate3d(${panX}px, ${panY}px, 0)`,
          zoom: zoom,
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
