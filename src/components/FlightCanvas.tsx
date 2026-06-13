import React, { useEffect, useRef, useMemo, useCallback, useState } from "react";
import ReactDOM from "react-dom";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { FlightPod, snapToNeighbors, preventOverlap } from "./FlightPod";
import { FlightHUD } from "./FlightHUD";
import { FLIGHT_ZOOM_MIN, FLIGHT_ZOOM_MAX, FLIGHT_DEFAULT_CLAUDE_WIDTH, FLIGHT_DEFAULT_CLAUDE_HEIGHT, FLIGHT_DEFAULT_TERMINAL_WIDTH, FLIGHT_DEFAULT_TERMINAL_HEIGHT } from "../lib/types";
import { CLAUDE_PATH } from "./FileIcons";
import { StashDock } from "./StashDock";

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
  const [focusMode, setFocusMode] = useState(true);
  const focusModeRef = useRef(focusMode);
  focusModeRef.current = focusMode;
  const navigateToRef = useRef<((podId: string) => void) | null>(null);
  const focusedPodIdRef = useRef<string | null>(null);
  const [autoFocus, setAutoFocus] = useState(true);
  const autoFocusRef = useRef(autoFocus);
  autoFocusRef.current = autoFocus;
  const [focusVisibleCount, setFocusVisibleCount] = useState<number | null>(null);
  const focusVisibleCountRef = useRef(focusVisibleCount);
  focusVisibleCountRef.current = focusVisibleCount;
  const [gridWrapped, setGridWrapped] = useState(false);
  const gridWrappedRef = useRef(gridWrapped);
  gridWrappedRef.current = gridWrapped;
  const [focusStartColumn, setFocusStartColumn] = useState(0);
  const focusStartColumnRef = useRef(focusStartColumn);
  focusStartColumnRef.current = focusStartColumn;
  const [marquee, setMarquee] = useState<{ sx1: number; sy1: number; sx2: number; sy2: number } | null>(null);
  const skipTransitionRef = useRef(false);

  // Stable selectors — primitives only, no new objects
  const panX = useWorkspaceStore((s) => s.flightLayouts[workspaceId]?.viewport?.panX ?? 0);
  const panY = useWorkspaceStore((s) => s.flightLayouts[workspaceId]?.viewport?.panY ?? 0);
  const zoom = useWorkspaceStore((s) => s.flightLayouts[workspaceId]?.viewport?.zoom ?? 1.0);

  const podIds = useWorkspaceStore((s) => {
    const pods = s.flightLayouts[workspaceId]?.pods;
    if (!pods) return "";
    return pods.filter((p) => !p.stashed).map((p) => p.id).join("\n");
  });
  const podIdList = useMemo(
    () => (podIds ? podIds.split("\n") : []),
    [podIds]
  );

  // Stashed pods — separate selector for dock rendering
  const stashedPodIds = useWorkspaceStore((s) => {
    const pods = s.flightLayouts[workspaceId]?.pods;
    if (!pods) return "";
    return pods.filter((p) => p.stashed).map((p) => p.id).join("\n");
  });
  const stashedPodIdList = useMemo(
    () => (stashedPodIds ? stashedPodIds.split("\n") : []),
    [stashedPodIds],
  );

  // Focus mode: sorted pod order and computed width per snap item
  const focusPodOrder = useMemo(() => {
    if (!focusMode) return podIdList;
    const store = useWorkspaceStore.getState();
    const pods = store.flightLayouts[workspaceId]?.pods ?? [];
    // Sort by x then y to get stable left-to-right order
    return [...pods]
      .sort((a, b) => {
        const rowA = Math.round(a.y / 100);
        const rowB = Math.round(b.y / 100);
        if (rowA !== rowB) return rowA - rowB;
        return a.x - b.x;
      })
      .map((p) => p.id);
  }, [focusMode, podIdList, workspaceId]);

  // Width of each snap item: divide container by focusColumns
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const DOCK_HEIGHT = 40;
  const dockHeightRef = useRef(0);
  dockHeightRef.current = stashedPodIdList.length > 0 ? DOCK_HEIGHT : 0;
  useEffect(() => {
    if (!containerRef.current) return;
    const measure = () => {
      setContainerSize({
        w: containerRef.current?.clientWidth ?? 0,
        h: containerRef.current?.clientHeight ?? 0,
      });
      // In focus mode, relayout pods to fit new container size.
      // Preserve the currently focused pod so width changes (e.g. opening
      // the activity bar) don't snap back to the first pod.
      if (focusModeRef.current) {
        setTimeout(() => {
          const pods = useWorkspaceStore.getState().flightLayouts[workspaceId]?.pods ?? [];
          if (pods.length === 0) return;
          const current = focusedPodIdRef.current;
          const target =
            current && pods.some((p) => p.id === current) ? current : pods[0].id;
          navigateToRef.current?.(target);
        }, 0);
      }
    };
    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, [workspaceId]);

  // Cap columns to number of pods
  const effectiveColumns = Math.min(2, podIdList.length || 1);

  const focusPodWidth = useMemo(() => {
    if (!focusMode || containerSize.w === 0) return undefined;
    const GAP = 8;
    const PAD = 12;
    return Math.floor((containerSize.w - PAD * 2 - GAP * (effectiveColumns - 1)) / effectiveColumns);
  }, [focusMode, effectiveColumns, containerSize.w]);

  const hasStashedPods = stashedPodIdList.length > 0;
  const focusPodHeight = useMemo(() => {
    if (!focusMode || containerSize.h === 0) return undefined;
    const GAP = 8;
    const PAD = 12;
    const HUD_HEIGHT = 35;
    return Math.floor(containerSize.h - HUD_HEIGHT - PAD * 2 - (hasStashedPods ? DOCK_HEIGHT : 0));
  }, [focusMode, containerSize.h, hasStashedPods]);

  useEffect(() => {
    getOrCreateFlightLayout(workspaceId);
  }, [workspaceId, getOrCreateFlightLayout]);

  // Listen for zoom-click on pods to enter focus mode
  useEffect(() => {
    const handler = (e: Event) => {
      const { workspaceId: wsId, podId } = (e as CustomEvent).detail;
      if (wsId !== workspaceId) return;
      setFocusMode(true);
      focusModeRef.current = true;
      // Pods are already positioned from the last focus layout —
      // just snap viewport to show the clicked pod. No relayout needed.
      // Suppress the CSS transition so it's an instant snap, not an animated slide.
      skipTransitionRef.current = true;
      requestAnimationFrame(() => { skipTransitionRef.current = false; });
      const store = useWorkspaceStore.getState();
      const pod = store.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId);
      if (pod) {
        const PAD = 12;
        store.setFlightViewport(workspaceId, {
          panX: PAD - pod.x,
          panY: 0,
          zoom: 1.0,
        });
        store.bringPodToFront(workspaceId, podId);
      }
    };
    window.addEventListener("flight-focus-pod", handler);
    return () => window.removeEventListener("flight-focus-pod", handler);
  }, [workspaceId]);

  // Native wheel listener — MUST be non-passive to call preventDefault()
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Scroll behavior depends on where the user last clicked:
    // - Clicked on empty canvas → scroll pans
    // - Clicked inside a terminal → scroll goes to terminal
    let canvasFocused = true; // Start with canvas focused (no terminal active)
    // Focused pod tracked on a component ref so resize handlers in other
    // effects can read it.

    // Track clicks to determine scroll target + active pod for column nav
    const clickTracker = (e: MouseEvent) => {
      const podEl = (e.target as HTMLElement).closest("[data-flight-pod]");
      if (podEl) {
        canvasFocused = false;
        el.classList.remove("flight-panning");
        // Track clicked pod as the active pod for Cmd+N / Shift+Arrow nav
        const podId = podEl.getAttribute("data-flight-pod");
        if (podId) focusedPodIdRef.current = podId;
      } else {
        canvasFocused = true;
        el.classList.add("flight-panning");
      }
    };
    el.addEventListener("mousedown", clickTracker, true); // capture phase

    // Inertia-proof scroll: navigate once per gesture. After a nav fires,
    // subsequent events are blocked. A new gesture is recognized when deltaX
    // decays below a threshold then jumps back up (new flick), or after a
    // time gap from the nav event (not from the last inertia event).
    let navTime = 0;
    let navFiredInGesture = false;
    let lastDelta = 0;

    // RAF-throttled viewport updates — coalesce rapid wheel events into one
    // store update per frame to avoid re-rendering 6 pods on every wheel tick.
    let pendingViewport: { panX?: number; panY?: number; zoom?: number } | null = null;
    let viewportRafId: number | null = null;
    const flushViewport = () => {
      viewportRafId = null;
      if (pendingViewport) {
        useWorkspaceStore.getState().setFlightViewport(workspaceId, pendingViewport);
        pendingViewport = null;
      }
    };
    const scheduleViewportUpdate = (vp: { panX?: number; panY?: number; zoom?: number }) => {
      pendingViewport = vp;
      if (viewportRafId === null) {
        viewportRafId = requestAnimationFrame(flushViewport);
      }
    };

    const wheelHandler = (e: WheelEvent) => {
      // Focus mode: intercept horizontal scroll only, navigate one pod at a time
      // Vertical scroll passes through to terminals for scrollback
      if (focusModeRef.current && !e.altKey && !e.ctrlKey) {
        const absDeltaX = Math.abs(e.deltaX);
        const absDeltaY = Math.abs(e.deltaY);

        // Only intercept if clearly horizontal (not vertical terminal scroll)
        if (absDeltaX > 2 && absDeltaX > absDeltaY * 2) {
          e.preventDefault();
          e.stopImmediatePropagation();

          if (navFiredInGesture) {
            // Detect new gesture: deltaX decayed then spiked back up
            // (inertia decays monotonically; a new flick jumps up)
            if (absDeltaX > lastDelta * 2 && absDeltaX > 8) {
              navFiredInGesture = false;
            }
            lastDelta = Math.min(lastDelta, absDeltaX); // track decay floor
            if (navFiredInGesture) return;
          }

          // Focus mode: navigate by column order (sorted by x position)
          const store = useWorkspaceStore.getState();
          const pods = store.flightLayouts[workspaceId]?.pods ?? [];
          if (pods.length < 2) return;

          // Group pods into columns by x position, sorted left-to-right
          const colMap = new Map<number, typeof pods>();
          for (const p of pods) {
            const key = Math.round(p.x);
            if (!colMap.has(key)) colMap.set(key, []);
            colMap.get(key)!.push(p);
          }
          const columns = [...colMap.entries()].sort((a, b) => a[0] - b[0]);

          // Find current column
          let currentColIdx = 0;
          if (focusedPodIdRef.current) {
            currentColIdx = columns.findIndex(([, colPods]) =>
              colPods.some(p => p.id === focusedPodIdRef.current)
            );
            if (currentColIdx < 0) currentColIdx = 0;
          }

          // Swipe right (deltaX < 0) = go LEFT (previous column)
          // Swipe left (deltaX > 0) = go RIGHT (next column)
          const nextColIdx = e.deltaX < 0
            ? Math.max(currentColIdx - 1, 0)
            : Math.min(currentColIdx + 1, columns.length - 1);

          if (nextColIdx === currentColIdx) return;

          const targetPod = columns[nextColIdx][1][0]; // first pod in target column
          focusedPodIdRef.current = targetPod.id;
          navFiredInGesture = true;
          lastDelta = absDeltaX; // start tracking decay from this peak
          navigateToRef.current?.(targetPod.id);
          return;
        }

        // Vertical scroll: let it pass through to the terminal
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

        scheduleViewportUpdate({ panX: newPanX, panY: newPanY, zoom: newZoom });
        return;
      }

      // Pan if: canvas was last clicked, OR cursor is currently over empty canvas
      const cursorOverPod = !!(e.target as HTMLElement).closest("[data-flight-pod]");
      if (canvasFocused || !cursorOverPod) {
        e.preventDefault();
        const store = useWorkspaceStore.getState();
        const vp = store.flightLayouts[workspaceId]?.viewport;
        if (vp) {
          // Accumulate deltas if a pending update exists, so rapid wheel
          // events don't lose distance when coalesced into one RAF.
          const basePanX = pendingViewport?.panX ?? vp.panX;
          const basePanY = pendingViewport?.panY ?? vp.panY;
          scheduleViewportUpdate({
            panX: basePanX - e.deltaX * 2,
            panY: basePanY - e.deltaY * 2,
          });
        }
        return;
      }

      // Otherwise: cursor is over a pod and terminal is focused → let terminal scroll
    };
    el.addEventListener("wheel", wheelHandler, { passive: false, capture: true });

    // Modifier+mousemove gestures:
    // Shift+move = pan canvas, Option+move = drag pod under cursor
    let lastX = 0;
    let lastY = 0;
    let isPanning = false;
    let spaceHeld = false;

    // Spacebar + drag to pan (like Figma/Photoshop)
    const spaceDownHandler = (e: KeyboardEvent) => {
      if (e.key === " " && !e.repeat && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        spaceHeld = true;
        el.style.cursor = "grab";
      }
    };
    const spaceUpHandler = (e: KeyboardEvent) => {
      if (e.key === " ") {
        spaceHeld = false;
        if (isPanning) {
          isPanning = false;
          el.classList.remove("flight-panning");
        }
        el.style.cursor = "";
      }
    };

    const moveHandler = (e: MouseEvent) => {
      // Space+move = pan
      if (spaceHeld) {
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
      if (isPanning) {
        isPanning = false;
        el.style.cursor = "";
        el.classList.remove("flight-panning");
      }
    };

    el.addEventListener("mousemove", moveHandler);
    window.addEventListener("keydown", spaceDownHandler);
    window.addEventListener("keyup", spaceUpHandler);

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
      // Track active pod for column-based navigation (scroll, Shift+Arrow, Cmd+N)
      focusedPodIdRef.current = podId;
      const store = useWorkspaceStore.getState();
      const pod = store.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId);
      if (!pod) return;
      const rect = el.getBoundingClientRect();
      const parentZoom = rect.width / el.offsetWidth;
      const containerW = rect.width / parentZoom;
      const containerH = rect.height / parentZoom;

      if (focusModeRef.current) {
        // Focus mode: lay out pods in repo columns
        // Each column = one repo (ordered by workspace.paths)
        // Within a column, multiple pods for the same repo stack vertically
        const HUD_HEIGHT = 35;
        const GAP = 8;
        const PAD = 12;

        const allPods = store.flightLayouts[workspaceId]?.pods ?? [];
        const ws = store.workspaces.find((w) => w.id === workspaceId);
        const repoPaths = ws?.paths ?? [];

        // Group pods by their CWD, ordered by workspace.paths
        // Pods whose CWD doesn't match any repo path go at the end
        const repoColumns: { repoPath: string; pods: typeof allPods }[] = [];
        const usedPodIds = new Set<string>();

        for (const repoPath of repoPaths) {
          const repoPods = allPods.filter((p) => p.cwd === repoPath && !usedPodIds.has(p.id));
          if (repoPods.length > 0) {
            repoColumns.push({ repoPath, pods: repoPods });
            repoPods.forEach((p) => usedPodIds.add(p.id));
          }
        }
        // Orphan pods (CWD doesn't match any workspace path)
        const orphans = allPods.filter((p) => !usedPodIds.has(p.id));
        if (orphans.length > 0) {
          repoColumns.push({ repoPath: "__orphans__", pods: orphans });
        }

        // All columns get uniform sizing based on how many fit in the viewport.
        // Navigation works by panning the viewport, not by reorganizing pods.
        const totalColumns = repoColumns.length;
        const viewportCols = focusVisibleCountRef.current
          ? Math.min(focusVisibleCountRef.current, totalColumns)
          : totalColumns;

        const availW = containerW - PAD * 2;
        const availH = containerH - HUD_HEIGHT - PAD * 2 - dockHeightRef.current;

        // Grid wrapping: arrange visible columns in a balanced grid
        let gridCols: number;
        let gridRows: number;
        const allVisible = viewportCols >= totalColumns;
        if (gridWrappedRef.current && viewportCols > 2) {
          gridCols = Math.ceil(viewportCols / 2);
          gridRows = 2;
        } else {
          gridCols = viewportCols; // Size columns to fit this many in viewport
          gridRows = 1;
        }

        const colW = Math.floor((availW - GAP * (gridCols - 1)) / Math.max(gridCols, 1));
        const gridRowH = Math.floor((availH - GAP * (gridRows - 1)) / Math.max(gridRows, 1));

        // Lay out ALL columns at the same size
        for (let colIdx = 0; colIdx < repoColumns.length; colIdx++) {
          const column = repoColumns[colIdx];
          let colX: number;
          let colY: number;
          let colH: number;

          if (gridWrappedRef.current && viewportCols > 2) {
            // Grid layout: fill pages (gridCols x gridRows), overflow pages extend right
            const pageSize = gridCols * gridRows;
            const pageIdx = Math.floor(colIdx / pageSize);
            const withinPage = colIdx % pageSize;
            const gc = withinPage % gridCols;
            const gr = Math.floor(withinPage / gridCols);
            const pageOffsetX = pageIdx * (gridCols * (colW + GAP));
            colX = PAD + pageOffsetX + gc * (colW + GAP);
            colY = gr * (gridRowH + GAP);
            colH = gridRowH;
          } else {
            // Horizontal row — all columns same width, extending beyond viewport
            colX = PAD + colIdx * (colW + GAP);
            colY = 0;
            colH = gridRowH;
          }

          const podCount = column.pods.length;
          const podH = Math.floor((colH - GAP * (podCount - 1)) / Math.max(podCount, 1));

          for (let rowIdx = 0; rowIdx < column.pods.length; rowIdx++) {
            const y = PAD + colY + rowIdx * (podH + GAP);
            store.updateFlightPod(workspaceId, column.pods[rowIdx].id, {
              x: colX, y, width: colW, height: podH,
            } as any);
          }
        }

        // Pan viewport to show the target pod
        if (allVisible) {
          // All columns fit — no panning needed
          store.setFlightViewport(workspaceId, { panX: 0, panY: 0, zoom: 1.0 });
        } else if (gridWrappedRef.current && viewportCols > 2) {
          // Grid mode with overflow: pan by grid pages
          const targetColIdx = repoColumns.findIndex(col => col.pods.some(p => p.id === podId));
          const pageSize = gridCols * gridRows;
          const pageIdx = Math.floor(targetColIdx / pageSize);
          const panX = -(pageIdx * (gridCols * (colW + GAP)));
          store.setFlightViewport(workspaceId, { panX, panY: 0, zoom: 1.0 });
        } else {
          // Row mode: pan to show the target column
          const targetColIdx = repoColumns.findIndex(col => col.pods.some(p => p.id === podId));
          const panX = -(targetColIdx * (colW + GAP));
          store.setFlightViewport(workspaceId, { panX, panY: 0, zoom: 1.0 });
        }
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

    // --- Cmd+Arrow navigation + Cmd+0 zoom-to-fit-all + Option+F focus toggle ---
    const navHandler = (e: KeyboardEvent) => {
      // Cmd+F: toggle Focus Mode on the most centered pod (flight mode only)
      if (e.metaKey && e.key.toLowerCase() === "f" && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        const next = !focusModeRef.current;
        setFocusMode(next);
        focusModeRef.current = next;
        if (next) {
          // Find the pod closest to viewport center
          const s = useWorkspaceStore.getState();
          const pods = s.flightLayouts[workspaceId]?.pods ?? [];
          const vp = s.flightLayouts[workspaceId]?.viewport;
          if (pods.length > 0 && vp) {
            const rect = el.getBoundingClientRect();
            const pz = rect.width / el.offsetWidth;
            const cw = rect.width / pz;
            const ch = rect.height / pz;
            // Viewport center in canvas coords
            let vcx: number, vcy: number;
            if (vp.zoom >= 1.0) {
              vcx = (cw / 2) / vp.zoom - vp.panX;
              vcy = (ch / 2) / vp.zoom - vp.panY;
            } else {
              vcx = (cw / 2 - vp.panX) / vp.zoom;
              vcy = (ch / 2 - vp.panY) / vp.zoom;
            }
            let closest = pods[0];
            let closestDist = Infinity;
            for (const p of pods) {
              const dx = (p.x + p.width / 2) - vcx;
              const dy = (p.y + p.height / 2) - vcy;
              const d = dx * dx + dy * dy;
              if (d < closestDist) { closestDist = d; closest = p; }
            }
            setTimeout(() => navigateToRef.current?.(closest.id), 0);
          }
        }
        return;
      }
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

      // Shift+Arrow: navigate one column left/right in focus mode
      if (e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey &&
          (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
          focusModeRef.current) {
        e.preventDefault();
        const store = useWorkspaceStore.getState();
        const pods = store.flightLayouts[workspaceId]?.pods ?? [];
        if (pods.length < 2) return;

        // Group pods into columns by x position, sorted left-to-right
        const colMap = new Map<number, typeof pods>();
        for (const p of pods) {
          const key = Math.round(p.x);
          if (!colMap.has(key)) colMap.set(key, []);
          colMap.get(key)!.push(p);
        }
        const columns = [...colMap.entries()].sort((a, b) => a[0] - b[0]);

        let currentColIdx = 0;
        if (focusedPodIdRef.current) {
          currentColIdx = columns.findIndex(([, colPods]) =>
            colPods.some(p => p.id === focusedPodIdRef.current)
          );
          if (currentColIdx < 0) currentColIdx = 0;
        }

        const nextColIdx = e.key === "ArrowRight"
          ? Math.min(currentColIdx + 1, columns.length - 1)
          : Math.max(currentColIdx - 1, 0);

        if (nextColIdx !== currentColIdx) {
          const targetPod = columns[nextColIdx][1][0];
          focusedPodIdRef.current = targetPod.id;
          navigateToPod(targetPod.id);
        }
        return;
      }

      // Cmd+0: show all pods in focus mode (reset visible count)
      if (e.metaKey && e.key === "0" && !e.shiftKey) {
        e.preventDefault();
        if (!focusModeRef.current) {
          setFocusMode(true);
          focusModeRef.current = true;
        }
        setFocusVisibleCount(null);
        focusVisibleCountRef.current = null;
        setFocusStartColumn(0);
        focusStartColumnRef.current = 0;
        setTimeout(() => {
          const pods = useWorkspaceStore.getState().flightLayouts[workspaceId]?.pods ?? [];
          if (pods.length > 0) navigateToRef.current?.(pods[0].id);
        }, 0);
        return;
      }


      // Cmd+G: toggle grid wrap (single row ↔ balanced grid)
      if (e.metaKey && e.key.toLowerCase() === "g" && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        if (!focusModeRef.current) {
          setFocusMode(true);
          focusModeRef.current = true;
        }
        setGridWrapped((v) => !v);
        gridWrappedRef.current = !gridWrappedRef.current;
        setTimeout(() => {
          const pods = useWorkspaceStore.getState().flightLayouts[workspaceId]?.pods ?? [];
          if (pods.length > 0) navigateToRef.current?.(pods[0].id);
        }, 0);
        return;
      }

      // Cmd+number: show N pods in focus mode, Cmd+0: show all
      if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        const numMap: Record<string, number> = { "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9 };
        const digit = numMap[e.key] ?? numMap[e.code?.replace("Digit", "")];
        if (digit) {
          e.preventDefault();
          // Enter focus mode if not already
          if (!focusModeRef.current) {
            setFocusMode(true);
            focusModeRef.current = true;
          }
          setFocusVisibleCount(digit);
          focusVisibleCountRef.current = digit;
          // Auto-create pods for repos that don't have one yet
          const store2 = useWorkspaceStore.getState();
          const ws2 = store2.workspaces.find((w) => w.id === workspaceId);
          const repoPaths = ws2?.paths ?? [];
          const existingPods = store2.flightLayouts[workspaceId]?.pods ?? [];
          const existingCwds = new Set(existingPods.map((p) => p.cwd));
          const neededPaths = repoPaths.slice(0, digit).filter((p) => !existingCwds.has(p));
          for (const path of neededPaths) {
            store2.addFlightPodAt(workspaceId, "claude", 0, 0, 900, 800, path);
          }
          // Navigate to the currently active pod (or first pod if none tracked)
          // and set focusStartColumn so the active pod's column is leftmost
          setTimeout(() => {
            const store3 = useWorkspaceStore.getState();
            const pods = store3.flightLayouts[workspaceId]?.pods ?? [];
            if (pods.length === 0) return;

            // Determine which pod to focus — use current tracked pod if valid
            const activePod = focusedPodIdRef.current
              ? pods.find(p => p.id === focusedPodIdRef.current)
              : null;
            const targetPodId = activePod ? activePod.id : pods[0].id;

            // Find the target pod's column index to set as start column
            const ws3 = store3.workspaces.find((w) => w.id === workspaceId);
            const rp = ws3?.paths ?? [];
            const allPods = pods;
            const usedIds = new Set<string>();
            const cols: string[][] = [];
            for (const repoPath of rp) {
              const rPods = allPods.filter((p) => p.cwd === repoPath && !usedIds.has(p.id));
              if (rPods.length > 0) {
                cols.push(rPods.map(p => p.id));
                rPods.forEach(p => usedIds.add(p.id));
              }
            }
            const orphans = allPods.filter(p => !usedIds.has(p.id));
            if (orphans.length > 0) cols.push(orphans.map(p => p.id));

            const colIdx = cols.findIndex(col => col.includes(targetPodId));
            const startCol = Math.max(colIdx, 0);
            setFocusStartColumn(startCol);
            focusStartColumnRef.current = startCol;

            navigateToRef.current?.(targetPodId);
          }, 0);
          return;
        }
      }
    };
    document.addEventListener("keydown", navHandler, true); // capture phase

    // Free mode: horizontal scroll on pods pans freely
    let freeScrollTimer: ReturnType<typeof setTimeout> | null = null;
    let freeScrollActive = false;
    const focusScrollHandler = (e: WheelEvent) => {
      if (e.altKey || e.ctrlKey) return;
      if (focusModeRef.current) return; // Handled by wheelHandler now

      {
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
      el.removeEventListener("wheel", wheelHandler, { capture: true });
      el.removeEventListener("wheel", focusScrollHandler);
      el.removeEventListener("mousedown", clickTracker, true);
      el.removeEventListener("mousemove", moveHandler);
      el.removeEventListener("mousedown", marqueeDownHandler);
      window.removeEventListener("keydown", spaceDownHandler);
      window.removeEventListener("keyup", spaceUpHandler);
      document.removeEventListener("keydown", deleteHandler);
      document.removeEventListener("keydown", navHandler, true);
      if (freeScrollTimer) clearTimeout(freeScrollTimer);
      if (viewportRafId !== null) cancelAnimationFrame(viewportRafId);
    };
  }, [workspaceId, setFlightViewport]);

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

    const GAP = 8;
    let bestDist = Infinity;
    let bestPlacement = { x: canvasX, y: canvasY, w: defaultW, h: defaultH };

    for (const pod of pods) {
      const podRight = pod.x + pod.width;
      const podBottom = pod.y + pod.height;
      const clampedX = Math.max(pod.x, Math.min(canvasX, podRight));
      const clampedY = Math.max(pod.y, Math.min(canvasY, podBottom));

      if (canvasX >= podRight) {
        const dist = Math.hypot(canvasX - podRight, canvasY - clampedY);
        if (dist < bestDist) { bestDist = dist; bestPlacement = { x: podRight + GAP, y: pod.y, w: defaultW, h: pod.height }; }
      }
      if (canvasX <= pod.x) {
        const dist = Math.hypot(canvasX - pod.x, canvasY - clampedY);
        if (dist < bestDist) { bestDist = dist; bestPlacement = { x: pod.x - defaultW - GAP, y: pod.y, w: defaultW, h: pod.height }; }
      }
      if (canvasY >= podBottom) {
        const dist = Math.hypot(canvasX - clampedX, canvasY - podBottom);
        if (dist < bestDist) { bestDist = dist; bestPlacement = { x: pod.x, y: podBottom + GAP, w: pod.width, h: defaultH }; }
      }
      if (canvasY <= pod.y) {
        const dist = Math.hypot(canvasX - clampedX, canvasY - pod.y);
        if (dist < bestDist) { bestDist = dist; bestPlacement = { x: pod.x, y: pod.y - defaultH - GAP, w: pod.width, h: defaultH }; }
      }
    }

    const others = pods.map((p) => ({ x: p.x, y: p.y, width: p.width, height: p.height }));
    const adjusted = preventOverlap(
      { x: bestPlacement.x, y: bestPlacement.y, width: bestPlacement.w, height: bestPlacement.h },
      others,
    );
    return { x: adjusted.x, y: adjusted.y, w: bestPlacement.w, h: bestPlacement.h };
  }, [workspaceId]);

  // Right-click on empty canvas → frosted glass popup to add pods
  const [contextMenu, setContextMenu] = useState<{ screenX: number; screenY: number; canvasX: number; canvasY: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null);
  const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
  }, []);
  /** After adding a pod, enter focus mode (if auto-focus is on) and relayout */
  const autoEnterFocusAndRelayout = useCallback(() => {
    setTimeout(() => {
      const pods = useWorkspaceStore.getState().flightLayouts[workspaceId]?.pods ?? [];
      if (pods.length === 0) return;
      const newest = pods[pods.length - 1];
      if (!focusModeRef.current && autoFocusRef.current) {
        setFocusMode(true);
        focusModeRef.current = true;
      }
      if (focusModeRef.current) {
        navigateToRef.current?.(newest.id);
      }
    }, 0);
  }, [workspaceId]);

  /** Show the frosted glass folder picker menu on double-click or right-click */
  const openCanvasMenu = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-flight-pod]")) return;
    if ((e.target as HTMLElement).closest("[data-focus-snap-item]")) return;
    if ((e.target as HTMLElement).closest("[data-focus-scroller]")) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    // Ignore if mouse moved (was a drag)
    if (e.type === "dblclick" && mouseDownPosRef.current) {
      const dx = e.clientX - mouseDownPosRef.current.x;
      const dy = e.clientY - mouseDownPosRef.current.y;
      if (dx * dx + dy * dy > 25) return;
    }
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



  return (
    <div
      ref={containerRef}
      data-flight-canvas=""
      style={{ ...canvasStyles.canvas, display: isActive ? "flex" : "none" }}
      onMouseDown={handleCanvasMouseDown}
      onContextMenu={openCanvasMenu}
      onDoubleClick={openCanvasMenu}
    >
      <style>{`
        [data-flight-canvas]::after {
          content: "";
          position: absolute;
          inset: 0;
          z-index: 0;
          background-image:
            radial-gradient(circle, rgba(255,255,255,0.07) 0.8px, transparent 0.8px);
          background-size: 24px 24px;
          background-position: 0 0;
          pointer-events: none;
        }
        /* Hide scrollbar on focus mode scroller */
        [data-flight-canvas] > div::-webkit-scrollbar { display: none; }
      `}</style>

      {/* Single viewport for both modes — never change container CSS to avoid breaking xterm canvases */}
      <div
        style={{
          ...canvasStyles.viewport,
          transition: focusMode && !skipTransitionRef.current ? "left 0.08s ease-out, top 0.08s ease-out" : "none",
          ...(zoom === 1.0
            ? { left: panX, top: panY }
            : zoom > 1.0
              ? { transform: `translate3d(${panX}px, ${panY}px, 0)`, zoom: zoom }
              : { transform: `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})`, transformOrigin: "0 0" }
          ),
        }}
      >
        {podIdList.map((podId) => (
          <FlightPod key={podId} podId={podId} workspaceId={workspaceId} zoom={zoom} isSelected={selectedPods.has(podId)} />
        ))}
      </div>
      {isActive && <FlightHUD workspaceId={workspaceId} zoom={zoom} focusMode={focusMode} autoFocus={autoFocus} onToggleAutoFocus={() => setAutoFocus((v) => !v)} onToggleFocus={() => {
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

      {/* Stash dock — rendered when pods are stashed */}
      <StashDock workspaceId={workspaceId} />

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
                autoEnterFocusAndRelayout();
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
                autoEnterFocusAndRelayout();
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
    zIndex: 1,
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
