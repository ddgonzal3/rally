import React, { useEffect, useRef, useMemo, useCallback, useState } from "react";
import ReactDOM from "react-dom";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { FlightPod, snapToNeighbors, preventOverlap } from "./FlightPod";
import { FlightHUD } from "./FlightHUD";
import { FLIGHT_ZOOM_MIN, FLIGHT_ZOOM_MAX, FLIGHT_DEFAULT_CLAUDE_WIDTH, FLIGHT_DEFAULT_CLAUDE_HEIGHT, FLIGHT_DEFAULT_TERMINAL_WIDTH, FLIGHT_DEFAULT_TERMINAL_HEIGHT } from "../lib/types";
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
  const removeFlightPod = useWorkspaceStore((s) => s.removeFlightPod);
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedPods, setSelectedPods] = useState<Set<string>>(new Set());
  const selectedPodsRef = useRef(selectedPods);
  selectedPodsRef.current = selectedPods;
  const [marquee, setMarquee] = useState<{ sx1: number; sy1: number; sx2: number; sy2: number } | null>(null);

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
    // Scroll behavior depends on where the user last clicked:
    // - Clicked on empty canvas → scroll pans
    // - Clicked inside a terminal → scroll goes to terminal
    let canvasFocused = true; // Start with canvas focused (no terminal active)

    // Track clicks to determine scroll target
    const clickTracker = (e: MouseEvent) => {
      const insidePod = !!(e.target as HTMLElement).closest("[data-flight-pod]");
      if (insidePod) {
        canvasFocused = false;
        el.classList.remove("flight-panning");
      } else {
        canvasFocused = true;
        el.classList.add("flight-panning");
      }
    };
    el.addEventListener("mousedown", clickTracker, true); // capture phase

    const wheelHandler = (e: WheelEvent) => {
      // Option+scroll or pinch = zoom (always, regardless of focus)
      if (e.altKey || e.ctrlKey) {
        if (e.altKey) zoomActiveWithOption = true;
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
        return;
      }

      // Pan if: canvas was last clicked, OR cursor is currently over empty canvas
      const cursorOverPod = !!(e.target as HTMLElement).closest("[data-flight-pod]");
      if (canvasFocused || !cursorOverPod) {
        e.preventDefault();
        const store = useWorkspaceStore.getState();
        const vp = store.flightLayouts[workspaceId]?.viewport;
        if (vp) {
          store.setFlightViewport(workspaceId, {
            panX: vp.panX - e.deltaX,
            panY: vp.panY - e.deltaY,
          });
        }
        return;
      }

      // Otherwise: cursor is over a pod and terminal is focused → let terminal scroll
    };
    el.addEventListener("wheel", wheelHandler, { passive: false });

    // Modifier+mousemove gestures:
    // Shift+move = pan canvas, Option+move = drag pod under cursor
    let lastX = 0;
    let lastY = 0;
    let isPanning = false;
    let isDraggingPod = false;
    let dragPodId: string | null = null;
    let zoomActiveWithOption = false; // Set when Option+scroll zooms — blocks pod drag until Option released

    const moveHandler = (e: MouseEvent) => {
      // Shift+move = pan
      if (e.shiftKey && !e.altKey) {
        if (isDraggingPod) { isDraggingPod = false; dragPodId = null; }
        if (!isPanning) {
          isPanning = true;
          lastX = e.clientX;
          lastY = e.clientY;
          el.style.cursor = "grabbing";
          el.classList.add("flight-panning");
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
        el.classList.remove("flight-panning");
      }

      // Option+move = drag pod under cursor (but NOT if we just zoomed with Option)
      if (e.altKey && !e.shiftKey && !zoomActiveWithOption) {
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
        el.classList.remove("flight-panning");
      }
      if (e.key === "Alt") {
        zoomActiveWithOption = false; // Reset zoom lock when Option released
        if (isDraggingPod) {
          isDraggingPod = false;
          dragPodId = null;
          el.style.cursor = "";
        }
      }
    };

    el.addEventListener("mousemove", moveHandler);
    window.addEventListener("keyup", keyUpHandler);

    // Marquee selection: left-click drag on empty canvas (no modifiers)
    const marqueeDownHandler = (e: MouseEvent) => {
      if (e.button !== 0 || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
      if ((e.target as HTMLElement).closest("[data-flight-pod]")) return;

      // Screen coords for the visual rectangle (rendered via portal)
      const startSX = e.clientX;
      const startSY = e.clientY;

      const store = useWorkspaceStore.getState();
      const vp = store.flightLayouts[workspaceId]?.viewport;
      if (!vp) return;

      // Convert screen point to canvas coords for intersection testing
      const screenToCanvas = (sx: number, sy: number) => {
        const r = el.getBoundingClientRect();
        const pz = r.width / el.offsetWidth;
        const cx = (sx - r.left) / pz;
        const cy = (sy - r.top) / pz;
        if (vp.zoom >= 1.0) return { x: cx / vp.zoom - vp.panX, y: cy / vp.zoom - vp.panY };
        return { x: (cx - vp.panX) / vp.zoom, y: (cy - vp.panY) / vp.zoom };
      };

      let marqueeActive = false;
      // Disable text selection during marquee
      document.body.style.userSelect = "none";
      document.body.style.webkitUserSelect = "none";

      const onMove = (me: MouseEvent) => {
        marqueeActive = true;
        // Screen coords for the visual rectangle
        setMarquee({
          sx1: Math.min(startSX, me.clientX),
          sy1: Math.min(startSY, me.clientY),
          sx2: Math.max(startSX, me.clientX),
          sy2: Math.max(startSY, me.clientY),
        });

        // Canvas coords for intersection testing
        const s = screenToCanvas(startSX, startSY);
        const c = screenToCanvas(me.clientX, me.clientY);
        const mx1 = Math.min(s.x, c.x);
        const my1 = Math.min(s.y, c.y);
        const mx2 = Math.max(s.x, c.x);
        const my2 = Math.max(s.y, c.y);

        const pods = useWorkspaceStore.getState().flightLayouts[workspaceId]?.pods ?? [];
        const selected = new Set<string>();
        for (const p of pods) {
          if (p.x < mx2 && p.x + p.width > mx1 && p.y < my2 && p.y + p.height > my1) {
            selected.add(p.id);
          }
        }
        setSelectedPods(selected);
      };

      const onUp = () => {
        setMarquee(null);
        document.body.style.userSelect = "";
        document.body.style.webkitUserSelect = "";
        if (!marqueeActive) {
          setSelectedPods(new Set());
        }
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
    el.addEventListener("mousedown", marqueeDownHandler);

    // Delete/Backspace removes selected pods
    const deleteHandler = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      // Don't delete if typing in a terminal
      if ((e.target as HTMLElement).closest("textarea, input")) return;
      const sel = selectedPodsRef.current;
      if (sel.size === 0) return;
      e.preventDefault();
      const store = useWorkspaceStore.getState();
      for (const id of sel) {
        store.removeFlightPod(workspaceId, id);
      }
      setSelectedPods(new Set());
    };
    document.addEventListener("keydown", deleteHandler);

    return () => {
      el.removeEventListener("wheel", wheelHandler);
      el.removeEventListener("mousedown", clickTracker, true);
      el.removeEventListener("mousemove", moveHandler);
      el.removeEventListener("mousedown", marqueeDownHandler);
      window.removeEventListener("keyup", keyUpHandler);
      document.removeEventListener("keydown", deleteHandler);
    };
  }, [workspaceId, setFlightViewport]);

  // Right-click on empty canvas → frosted glass popup to add pods
  const [contextMenu, setContextMenu] = useState<{ screenX: number; screenY: number; canvasX: number; canvasY: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleCanvasContextMenu = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-flight-pod]")) return;
    e.preventDefault();

    const store = useWorkspaceStore.getState();
    const vp = store.flightLayouts[workspaceId]?.viewport;
    if (!vp) return;

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

    // Store raw clientX/clientY for popup positioning
    setContextMenu({ screenX: e.clientX, screenY: e.clientY, canvasX, canvasY });
  }, [workspaceId]);

  // Close popup when clicking outside
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [contextMenu]);

  const ws = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const paths = ws?.paths ?? [];
  const folderName = (p: string) => p.split("/").pop() || p;
  const shortenPath = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
  const addFlightPodAt = useWorkspaceStore((s) => s.addFlightPodAt);

  /** Find the best snap position for a new pod near canvasX/canvasY */
  const computeSnapPlacement = useCallback((
    canvasX: number, canvasY: number,
    defaultW: number, defaultH: number,
  ) => {
    const store = useWorkspaceStore.getState();
    const pods = store.flightLayouts[workspaceId]?.pods ?? [];
    if (pods.length === 0) return { x: canvasX, y: canvasY, w: defaultW, h: defaultH };

    const GAP = 8; // MIN_POD_GAP
    // Find the nearest pod edge to the click point
    let bestDist = Infinity;
    let bestPlacement = { x: canvasX, y: canvasY, w: defaultW, h: defaultH };

    for (const pod of pods) {
      const podRight = pod.x + pod.width;
      const podBottom = pod.y + pod.height;

      // Right edge of pod
      const distRight = Math.abs(canvasX - podRight);
      if (distRight < bestDist && canvasX >= podRight) {
        bestDist = distRight;
        bestPlacement = { x: podRight + GAP, y: pod.y, w: defaultW, h: pod.height };
      }
      // Left edge of pod
      const distLeft = Math.abs(canvasX - pod.x);
      if (distLeft < bestDist && canvasX <= pod.x) {
        bestDist = distLeft;
        bestPlacement = { x: pod.x - defaultW - GAP, y: pod.y, w: defaultW, h: pod.height };
      }
      // Bottom edge of pod
      const distBottom = Math.abs(canvasY - podBottom);
      if (distBottom < bestDist && canvasY >= podBottom) {
        bestDist = distBottom;
        bestPlacement = { x: pod.x, y: podBottom + GAP, w: pod.width, h: defaultH };
      }
      // Top edge of pod
      const distTop = Math.abs(canvasY - pod.y);
      if (distTop < bestDist && canvasY <= pod.y) {
        bestDist = distTop;
        bestPlacement = { x: pod.x, y: pod.y - defaultH - GAP, w: pod.width, h: defaultH };
      }
    }

    return bestPlacement;
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
          <FlightPod key={podId} podId={podId} workspaceId={workspaceId} zoom={zoom} isSelected={selectedPods.has(podId)} />
        ))}
      </div>
      {isActive && <FlightHUD workspaceId={workspaceId} zoom={zoom} />}

      {/* Marquee selection rectangle — portal to avoid CSS zoom offset */}
      {marquee && ReactDOM.createPortal(
        <div style={{
          position: "fixed",
          left: marquee.sx1,
          top: marquee.sy1,
          width: marquee.sx2 - marquee.sx1,
          height: marquee.sy2 - marquee.sy1,
          border: "1px solid rgba(100, 160, 255, 0.6)",
          background: "rgba(100, 160, 255, 0.1)",
          borderRadius: 2,
          pointerEvents: "none",
          zIndex: 99998,
        }} />,
        document.body,
      )}

      {/* Frosted glass context menu — rendered as portal to avoid CSS zoom offset */}
      {contextMenu && ReactDOM.createPortal(
        <div
          ref={menuRef}
          style={{
            position: "fixed",
            left: contextMenu.screenX,
            top: contextMenu.screenY,
            background: "rgba(36, 36, 36, 0.78)",
            backdropFilter: "blur(20px) saturate(180%)",
            WebkitBackdropFilter: "blur(20px) saturate(180%)",
            border: "1px solid rgba(255, 255, 255, 0.12)",
            borderRadius: 6,
            padding: "4px 0",
            minWidth: 180,
            zIndex: 99999,
            boxShadow: "0 4px 16px rgba(0, 0, 0, 0.4)",
            userSelect: "none",
          }}
        >
          <div style={menuStyles.section}>Claude Code</div>
          {paths.map((p) => (
            <div
              key={`claude-${p}`}
              className="sidebar-btn"
              style={menuStyles.item}
              onClick={() => {
                const p2 = computeSnapPlacement(contextMenu.canvasX, contextMenu.canvasY, FLIGHT_DEFAULT_CLAUDE_WIDTH, FLIGHT_DEFAULT_CLAUDE_HEIGHT);
                addFlightPodAt(workspaceId, "claude", p2.x, p2.y, p2.w, p2.h, p);
                setContextMenu(null);
              }}
            >
              <svg width="11" height="11" viewBox="-2 -1 28 26" fill="none" style={{ flexShrink: 0 }}>
                <path d={CLAUDE_PATH} fill="#D97757" fillRule="nonzero" />
              </svg>
              <span style={menuStyles.itemText}>{folderName(p)}</span>
              {paths.length > 1 && <span style={menuStyles.itemPath}>{shortenPath(p)}</span>}
            </div>
          ))}
          <div style={menuStyles.divider} />
          <div style={menuStyles.section}>Terminal</div>
          {paths.map((p) => (
            <div
              key={`term-${p}`}
              className="sidebar-btn"
              style={menuStyles.item}
              onClick={() => {
                const p2 = computeSnapPlacement(contextMenu.canvasX, contextMenu.canvasY, FLIGHT_DEFAULT_TERMINAL_WIDTH, FLIGHT_DEFAULT_TERMINAL_HEIGHT);
                addFlightPodAt(workspaceId, "terminal", p2.x, p2.y, p2.w, p2.h, p);
                setContextMenu(null);
              }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                <path d="M4 5l3 3-3 3" stroke="var(--status-green)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <line x1="9" y1="11" x2="13" y2="11" stroke="var(--status-green)" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <span style={menuStyles.itemText}>{folderName(p)}</span>
              {paths.length > 1 && <span style={menuStyles.itemPath}>{shortenPath(p)}</span>}
            </div>
          ))}
        </div>,
        document.body,
      )}
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

const menuStyles: Record<string, React.CSSProperties> = {
  section: {
    padding: "5px 12px 3px",
    fontSize: 10,
    fontWeight: 600,
    color: "var(--text-primary)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
  },
  divider: {
    height: 1,
    background: "rgba(255, 255, 255, 0.08)",
    margin: "4px 0",
  },
  item: {
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
  itemText: {
    fontWeight: 500,
  },
  itemPath: {
    fontSize: 11,
    color: "var(--text-dim)",
    marginLeft: "auto",
    paddingLeft: 8,
  },
};
