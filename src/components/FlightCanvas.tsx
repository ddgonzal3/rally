import React, { useEffect, useRef, useMemo, useCallback } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { FlightPod, snapToNeighbors, preventOverlap } from "./FlightPod";
import { FlightHUD } from "./FlightHUD";
import { FLIGHT_ZOOM_MIN, FLIGHT_ZOOM_MAX, FLIGHT_DEFAULT_CLAUDE_WIDTH, FLIGHT_DEFAULT_CLAUDE_HEIGHT, FLIGHT_DEFAULT_TERMINAL_WIDTH, FLIGHT_DEFAULT_TERMINAL_HEIGHT } from "../lib/types";
import { showContextMenu } from "../lib/contextMenu";
import { CLAUDE_PATH } from "./FileIcons";

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
    // Wheel handler — ONLY for zoom (Option+scroll or pinch)
    // Regular scroll always goes to terminals, never pans
    const wheelHandler = (e: WheelEvent) => {
      // Only intercept Option+scroll or pinch (ctrlKey)
      if (!e.altKey && !e.ctrlKey) return;

      e.preventDefault();
      const store = useWorkspaceStore.getState();
      const vp = store.flightLayouts[workspaceId]?.viewport;
      if (!vp) return;

      const zoomFactor = 1 - e.deltaY * (e.ctrlKey ? 0.01 : 0.003);
      const newZoom = Math.max(FLIGHT_ZOOM_MIN, Math.min(FLIGHT_ZOOM_MAX, vp.zoom * zoomFactor));
      const rect = el.getBoundingClientRect();
      const parentZoom = rect.width / el.offsetWidth;
      const cx = (e.clientX - rect.left) / parentZoom;
      const cy = (e.clientY - rect.top) / parentZoom;

      let pointX: number, pointY: number;
      if (vp.zoom >= 1.0) {
        pointX = cx / vp.zoom - vp.panX;
        pointY = cy / vp.zoom - vp.panY;
      } else {
        pointX = (cx - vp.panX) / vp.zoom;
        pointY = (cy - vp.panY) / vp.zoom;
      }

      let newPanX: number, newPanY: number;
      if (newZoom >= 1.0) {
        newPanX = cx / newZoom - pointX;
        newPanY = cy / newZoom - pointY;
      } else {
        newPanX = cx - pointX * newZoom;
        newPanY = cy - pointY * newZoom;
      }

      store.setFlightViewport(workspaceId, {
        panX: newPanX, panY: newPanY, zoom: newZoom,
      });
    };
    el.addEventListener("wheel", wheelHandler, { passive: false });

    // Modifier+mousemove gestures:
    // Shift+move = pan canvas, Option+move = drag pod under cursor
    let lastX = 0;
    let lastY = 0;
    let isPanning = false;
    let isDraggingPod = false;
    let dragPodId: string | null = null;

    const moveHandler = (e: MouseEvent) => {
      // Shift+move = pan
      if (e.shiftKey && !e.altKey) {
        if (isDraggingPod) { isDraggingPod = false; dragPodId = null; }
        if (!isPanning) {
          isPanning = true;
          lastX = e.clientX;
          lastY = e.clientY;
          el.style.cursor = "grabbing";
          return;
        }
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        if (dx !== 0 || dy !== 0) {
          const s = useWorkspaceStore.getState();
          s.setFlightViewport(workspaceId, {
            panX: (s.flightLayouts[workspaceId]?.viewport.panX ?? 0) + dx,
            panY: (s.flightLayouts[workspaceId]?.viewport.panY ?? 0) + dy,
          });
        }
        return;
      }
      if (isPanning && !e.shiftKey) {
        isPanning = false;
        el.style.cursor = "";
      }

      // Option+move = drag pod under cursor
      if (e.altKey && !e.shiftKey) {
        if (!isDraggingPod) {
          // Find which pod the cursor is over
          const podEl = (e.target as HTMLElement).closest("[data-flight-pod]");
          if (!podEl) return;
          dragPodId = podEl.getAttribute("data-flight-pod");
          if (!dragPodId) return;
          isDraggingPod = true;
          lastX = e.clientX;
          lastY = e.clientY;
          el.style.cursor = "move";
          // Bring to front
          useWorkspaceStore.getState().bringPodToFront(workspaceId, dragPodId);
          return;
        }
        if (!dragPodId) return;
        const s = useWorkspaceStore.getState();
        const vp = s.flightLayouts[workspaceId]?.viewport;
        const z = vp?.zoom ?? 1;
        const dx = (e.clientX - lastX) / z;
        const dy = (e.clientY - lastY) / z;
        lastX = e.clientX;
        lastY = e.clientY;
        if (dx !== 0 || dy !== 0) {
          const pod = s.flightLayouts[workspaceId]?.pods.find((p) => p.id === dragPodId);
          if (pod) {
            const rawX = pod.x + dx;
            const rawY = pod.y + dy;
            const others = (s.flightLayouts[workspaceId]?.pods ?? [])
              .filter((p) => p.id !== dragPodId)
              .map((p) => ({ x: p.x, y: p.y, width: p.width, height: p.height }));
            const snapped = snapToNeighbors(
              { x: rawX, y: rawY, width: pod.width, height: pod.height },
              others,
              "drag",
            );
            const final = preventOverlap(snapped, others);
            s.updateFlightPod(workspaceId, dragPodId, {
              x: final.x,
              y: final.y,
            } as any);
          }
        }
        return;
      }
      if (isDraggingPod && !e.altKey) {
        isDraggingPod = false;
        dragPodId = null;
        el.style.cursor = "";
      }
    };

    const keyUpHandler = (e: KeyboardEvent) => {
      if (e.key === "Shift" && isPanning) {
        isPanning = false;
        el.style.cursor = "";
      }
      if (e.key === "Alt" && isDraggingPod) {
        isDraggingPod = false;
        dragPodId = null;
        el.style.cursor = "";
      }
    };

    el.addEventListener("mousemove", moveHandler);
    window.addEventListener("keyup", keyUpHandler);

    return () => {
      el.removeEventListener("wheel", wheelHandler);
      el.removeEventListener("mousemove", moveHandler);
      window.removeEventListener("keyup", keyUpHandler);
    };
  }, [workspaceId, setFlightViewport]);

  // Right-click on empty canvas → context menu to add pods at click position
  const handleCanvasContextMenu = useCallback((e: React.MouseEvent) => {
    // Only handle clicks on the canvas itself, not on pods
    if ((e.target as HTMLElement).closest("[data-flight-pod]")) return;
    e.preventDefault();

    const store = useWorkspaceStore.getState();
    const ws = store.workspaces.find((w) => w.id === workspaceId);
    const paths = ws?.paths ?? [];
    if (paths.length === 0) return;

    const vp = store.flightLayouts[workspaceId]?.viewport;
    if (!vp) return;

    // Convert screen click position to canvas coordinates
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const parentZoom = rect.width / (containerRef.current?.offsetWidth ?? rect.width);
    const cx = (e.clientX - rect.left) / parentZoom;
    const cy = (e.clientY - rect.top) / parentZoom;

    let canvasX: number, canvasY: number;
    if (vp.zoom >= 1.0) {
      canvasX = cx / vp.zoom - vp.panX;
      canvasY = cy / vp.zoom - vp.panY;
    } else {
      canvasX = (cx - vp.panX) / vp.zoom;
      canvasY = (cy - vp.panY) / vp.zoom;
    }

    const folderName = (p: string) => p.split("/").pop() || p;
    const items: Parameters<typeof showContextMenu>[0] = [];

    // Claude Code section
    items.push({ label: "Claude Code", action: () => {}, disabled: true });
    for (const p of paths) {
      items.push({
        label: `  ${folderName(p)}`,
        action: () => store.addFlightPodAt(workspaceId, "claude", canvasX, canvasY, FLIGHT_DEFAULT_CLAUDE_WIDTH, FLIGHT_DEFAULT_CLAUDE_HEIGHT, p),
      });
    }
    items.push("separator");
    // Terminal section
    items.push({ label: "Terminal", action: () => {}, disabled: true });
    for (const p of paths) {
      items.push({
        label: `  ${folderName(p)}`,
        action: () => store.addFlightPodAt(workspaceId, "terminal", canvasX, canvasY, FLIGHT_DEFAULT_TERMINAL_WIDTH, FLIGHT_DEFAULT_TERMINAL_HEIGHT, p),
      });
    }
    showContextMenu(items);
  }, [workspaceId]);

  return (
    <div
      ref={containerRef}
      style={{ ...canvasStyles.canvas, display: isActive ? "flex" : "none" }}
      onContextMenu={handleCanvasContextMenu}
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
