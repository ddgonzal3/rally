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
  const [focusMode, setFocusMode] = useState(false);
  const focusModeRef = useRef(focusMode);
  focusModeRef.current = focusMode;
  const navigateToRef = useRef<((podId: string) => void) | null>(null);
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
      // In Focus Mode, block ALL non-zoom scroll events (handled by focusScrollHandler)
      if (focusModeRef.current && !e.altKey && !e.ctrlKey) {
        e.preventDefault();
        return;
      }
      // Option+scroll or pinch = zoom — exits focus mode
      if (e.altKey || e.ctrlKey) {
        if (focusModeRef.current) setFocusMode(false);
        e.preventDefault();
        const store = useWorkspaceStore.getState();
        const vp = store.flightLayouts[workspaceId]?.viewport;
        if (!vp) return;

        // Use whichever scroll axis has the larger delta
        const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        const zoomFactor = 1 - delta * (e.ctrlKey ? 0.01 : 0.003);
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
            panX: vp.panX - e.deltaX * 2,
            panY: vp.panY - e.deltaY * 2,
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

    const moveHandler = (e: MouseEvent) => {
      // Shift+move = pan
      if (e.shiftKey && !e.altKey) {
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

      // (Option+move pod drag removed — drag via header only)
    };

    const keyUpHandler = (e: KeyboardEvent) => {
      if (e.key === "Shift" && isPanning) {
        isPanning = false;
        el.style.cursor = "";
        el.classList.remove("flight-panning");
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

    // --- Navigate to a pod: animate viewport to show it ---
    const navigateToPod = (podId: string) => {
      const store = useWorkspaceStore.getState();
      const pod = store.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId);
      if (!pod) return;
      const rect = el.getBoundingClientRect();
      const parentZoom = rect.width / el.offsetWidth;
      const containerW = rect.width / parentZoom;
      const containerH = rect.height / parentZoom;

      if (focusModeRef.current) {
        // Focus mode: resize ALL pods to fill the viewport, zoom stays at 1.0
        const HUD_HEIGHT = 50;
        const PEEK_WIDTH = 40;
        const focusW = Math.max(containerW - PEEK_WIDTH, 400);
        const focusH = Math.max(containerH - HUD_HEIGHT, 300);
        const allPods = store.flightLayouts[workspaceId]?.pods ?? [];
        for (const p of allPods) {
          if (p.width !== focusW || p.height !== focusH) {
            store.updateFlightPod(workspaceId, p.id, {
              width: focusW, height: focusH,
            } as any);
          }
        }
        // Re-read pod position after resize (it may have changed)
        const updatedPod = store.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId);
        const px = updatedPod?.x ?? pod.x;
        const py = updatedPod?.y ?? pod.y;
        store.setFlightViewport(workspaceId, { panX: -px, panY: -py, zoom: 1.0 });
      } else {
        // Free mode: fit pod in viewport with minimal padding
        const fitZoom = Math.min(containerW * 0.99 / pod.width, containerH * 0.99 / pod.height, 1.0);
        const padX = containerW * 0.005;
        const padY = containerH * 0.005;
        let panX: number, panY: number;
        if (fitZoom >= 1.0) {
          panX = padX / fitZoom - pod.x;
          panY = padY / fitZoom - pod.y;
        } else {
          panX = padX - pod.x * fitZoom;
          panY = padY - pod.y * fitZoom;
        }
        store.setFlightViewport(workspaceId, { panX, panY, zoom: fitZoom });
      }
      store.bringPodToFront(workspaceId, podId);
    };
    navigateToRef.current = navigateToPod;

    // --- Find spatial neighbor pod ---
    const findNeighborPod = (dir: "left" | "right" | "up" | "down"): string | null => {
      const store = useWorkspaceStore.getState();
      const pods = store.flightLayouts[workspaceId]?.pods ?? [];
      if (pods.length < 2) return null;
      // Find the focused pod (highest zIndex)
      const focused = [...pods].sort((a, b) => b.zIndex - a.zIndex)[0];
      if (!focused) return null;
      const fcx = focused.x + focused.width / 2;
      const fcy = focused.y + focused.height / 2;

      let best: string | null = null;
      let bestDist = Infinity;

      for (const p of pods) {
        if (p.id === focused.id) continue;
        const pcx = p.x + p.width / 2;
        const pcy = p.y + p.height / 2;
        let primary: number, orthogonal: number;
        switch (dir) {
          case "right": primary = pcx - fcx; orthogonal = Math.abs(pcy - fcy); break;
          case "left":  primary = fcx - pcx; orthogonal = Math.abs(pcy - fcy); break;
          case "down":  primary = pcy - fcy; orthogonal = Math.abs(pcx - fcx); break;
          case "up":    primary = fcy - pcy; orthogonal = Math.abs(pcx - fcx); break;
        }
        if (primary <= 0) continue; // Not in the requested direction
        const dist = primary + orthogonal * 0.5; // Favor primary direction
        if (dist < bestDist) {
          bestDist = dist;
          best = p.id;
        }
      }
      return best;
    };

    // --- Cmd+Arrow navigation + Cmd+0 zoom-to-fit-all ---
    const navHandler = (e: KeyboardEvent) => {
      // Cmd+Arrow: navigate to neighbor pod
      if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey) {
        const dirMap: Record<string, "left" | "right" | "up" | "down"> = {
          ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
        };
        const dir = dirMap[e.key];
        if (dir) {
          e.preventDefault();
          const target = findNeighborPod(dir);
          if (target) navigateToPod(target);
          return;
        }
      }

      // Cmd+0: zoom to fit ALL pods
      if (e.metaKey && e.key === "0" && !e.shiftKey) {
        e.preventDefault();
        const store = useWorkspaceStore.getState();
        const pods = store.flightLayouts[workspaceId]?.pods ?? [];
        if (pods.length === 0) return;
        // Compute bounding box of all pods
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of pods) {
          minX = Math.min(minX, p.x);
          minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x + p.width);
          maxY = Math.max(maxY, p.y + p.height);
        }
        const totalW = maxX - minX;
        const totalH = maxY - minY;
        const rect = el.getBoundingClientRect();
        const parentZoom = rect.width / el.offsetWidth;
        const containerW = rect.width / parentZoom;
        const containerH = rect.height / parentZoom;
        const fitZoom = Math.min(containerW * 0.9 / totalW, containerH * 0.9 / totalH, 1.0);
        const padX = (containerW - totalW * fitZoom) / 2;
        const padY = (containerH - totalH * fitZoom) / 2;
        let panX: number, panY: number;
        if (fitZoom >= 1.0) {
          panX = padX / fitZoom - minX;
          panY = padY / fitZoom - minY;
        } else {
          panX = padX - minX * fitZoom;
          panY = padY - minY * fitZoom;
        }
        store.setFlightViewport(workspaceId, { panX, panY, zoom: fitZoom });
        return;
      }
    };
    document.addEventListener("keydown", navHandler);

    // --- Focus Mode scroll: any scroll on a pod navigates to next/prev ---
    // Free mode: horizontal scroll pans freely
    let focusNavCooldown = false;
    let focusNavTimer: ReturnType<typeof setTimeout> | null = null;
    let freeScrollTimer: ReturnType<typeof setTimeout> | null = null;
    let freeScrollActive = false;
    const focusScrollHandler = (e: WheelEvent) => {
      if (e.altKey || e.ctrlKey) return;

      if (focusModeRef.current) {
        // Handle everywhere — not just on pods — to catch inertia events
        const onPod = !!(e.target as HTMLElement).closest("[data-flight-pod]");
        // Focus mode: eat ALL horizontal scroll events (including inertia).
        // Only navigate once per gesture.
        e.preventDefault();
        e.stopPropagation();
        if (focusNavCooldown) {
          // Eat inertia events — reset the cooldown timer so inertia extends it
          if (focusNavTimer) clearTimeout(focusNavTimer);
          focusNavTimer = setTimeout(() => { focusNavCooldown = false; }, 600);
          return;
        }
        if (Math.abs(e.deltaX) < 3) return;
        focusNavCooldown = true;
        const dir: "left" | "right" = e.deltaX > 0 ? "right" : "left";
        const target = findNeighborPod(dir);
        if (target) navigateToRef.current?.(target);
        // Long cooldown to eat all inertia events
        focusNavTimer = setTimeout(() => {
          focusNavCooldown = false;
        }, 600);
      } else {
        // Free mode: horizontal scroll pans (only on pods)
        if (!((e.target as HTMLElement).closest("[data-flight-pod]"))) return;
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY) * 2 && Math.abs(e.deltaX) > 5) {
          freeScrollActive = true;
        }
        if (freeScrollActive) {
          e.preventDefault();
          const store = useWorkspaceStore.getState();
          const vp = store.flightLayouts[workspaceId]?.viewport;
          if (vp) {
            store.setFlightViewport(workspaceId, {
              panX: vp.panX - e.deltaX * 2,
              panY: vp.panY - e.deltaY * 2,
            });
          }
          if (freeScrollTimer) clearTimeout(freeScrollTimer);
          freeScrollTimer = setTimeout(() => {
            freeScrollActive = false;
            freeScrollTimer = null;
          }, 500);
        }
      }
    };
    el.addEventListener("wheel", focusScrollHandler, { passive: false });

    return () => {
      el.removeEventListener("wheel", wheelHandler);
      el.removeEventListener("wheel", focusScrollHandler);
      el.removeEventListener("mousedown", clickTracker, true);
      el.removeEventListener("mousemove", moveHandler);
      el.removeEventListener("mousedown", marqueeDownHandler);
      window.removeEventListener("keyup", keyUpHandler);
      document.removeEventListener("keydown", deleteHandler);
      document.removeEventListener("keydown", navHandler);
      if (focusNavTimer) clearTimeout(focusNavTimer);
      if (freeScrollTimer) clearTimeout(freeScrollTimer);
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

    // Ensure the placement doesn't overlap any existing pod
    const others = pods.map((p) => ({ x: p.x, y: p.y, width: p.width, height: p.height }));
    const adjusted = preventOverlap(
      { x: bestPlacement.x, y: bestPlacement.y, width: bestPlacement.w, height: bestPlacement.h },
      others,
    );
    return { x: adjusted.x, y: adjusted.y, w: bestPlacement.w, h: bestPlacement.h };
  }, [workspaceId]);

  return (
    <div
      ref={containerRef}
      data-flight-canvas=""
      style={{ ...canvasStyles.canvas, display: isActive ? "flex" : "none" }}
      onContextMenu={handleCanvasContextMenu}
      onDoubleClick={handleCanvasContextMenu}
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
      {isActive && <FlightHUD workspaceId={workspaceId} zoom={zoom} focusMode={focusMode} onToggleFocus={() => {
        const next = !focusMode;
        setFocusMode(next);
        if (next) {
          // Enter focus mode: navigate to the highest-zIndex pod
          const s = useWorkspaceStore.getState();
          const pods = s.flightLayouts[workspaceId]?.pods ?? [];
          if (pods.length > 0) {
            const top = [...pods].sort((a, b) => b.zIndex - a.zIndex)[0];
            // Need to wait one tick for focusModeRef to update
            setTimeout(() => navigateToRef.current?.(top.id), 0);
          }
        }
      }} />}

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
