import React, { useRef, useEffect } from "react";
import { useDragState, getDragState } from "../lib/dragContext";

export type DropPosition = "top" | "bottom" | "left" | "right" | "center";

/** Custom event dispatched by App.tsx when Finder drops files on the window. */
export const FILE_DROP_COMMIT_EVENT = "file-drop-commit";

type Pointer = { x: number; y: number };

/** Determine which zone the mouse is in based on relative position within the element */
function getDropPosition(
  rect: DOMRect,
  mx: number,
  my: number
): DropPosition | null {
  const x = mx - rect.left;
  const y = my - rect.top;
  const w = rect.width;
  const h = rect.height;
  if (w <= 0 || h <= 0) return null;

  const rx = x / w; // 0..1
  const ry = y / h; // 0..1

  // Edge threshold (25% from each edge)
  const t = 0.25;

  if (ry < t && rx > t && rx < 1 - t) return "top";
  if (ry > 1 - t && rx > t && rx < 1 - t) return "bottom";
  if (rx < t && ry > t && ry < 1 - t) return "left";
  if (rx > 1 - t && ry > t && ry < 1 - t) return "right";
  if (rx >= t && rx <= 1 - t && ry >= t && ry <= 1 - t) return "center";

  // Corner regions — assign to nearest edge
  if (ry < 0.5 && rx < 0.5) return ry < rx ? "top" : "left";
  if (ry < 0.5 && rx >= 0.5) return ry < (1 - rx) ? "top" : "right";
  if (ry >= 0.5 && rx < 0.5) return (1 - ry) < rx ? "bottom" : "left";
  return (1 - ry) < (1 - rx) ? "bottom" : "right";
}

function isInsideRect(rect: DOMRect, x: number, y: number, expand: number): boolean {
  return (
    x >= rect.left - expand &&
    x <= rect.right + expand &&
    y >= rect.top - expand &&
    y <= rect.bottom + expand
  );
}

function isNearRectEdge(rect: DOMRect, x: number, y: number, threshold = 1): boolean {
  return (
    x <= rect.left + threshold ||
    x >= rect.right - threshold ||
    y <= rect.top + threshold ||
    y >= rect.bottom - threshold
  );
}

/** When entering from outside and the first in-bounds sample lands in center, bias to entry edge. */
function inferEntryEdge(rect: DOMRect, prev: Pointer, expand: number): DropPosition | null {
  const leftOverflow = rect.left - expand - prev.x;
  const rightOverflow = prev.x - (rect.right + expand);
  const topOverflow = rect.top - expand - prev.y;
  const bottomOverflow = prev.y - (rect.bottom + expand);

  let edge: DropPosition | null = null;
  let maxOverflow = 0;

  if (leftOverflow > maxOverflow) {
    maxOverflow = leftOverflow;
    edge = "left";
  }
  if (rightOverflow > maxOverflow) {
    maxOverflow = rightOverflow;
    edge = "right";
  }
  if (topOverflow > maxOverflow) {
    maxOverflow = topOverflow;
    edge = "top";
  }
  if (bottomOverflow > maxOverflow) {
    maxOverflow = bottomOverflow;
    edge = "bottom";
  }

  return edge;
}

function nearestEdge(rect: DOMRect, x: number, y: number): DropPosition {
  const distances: Array<{ edge: DropPosition; dist: number }> = [
    { edge: "left", dist: Math.abs(x - rect.left) },
    { edge: "right", dist: Math.abs(rect.right - x) },
    { edge: "top", dist: Math.abs(y - rect.top) },
    { edge: "bottom", dist: Math.abs(rect.bottom - y) },
  ];
  distances.sort((a, b) => a.dist - b.dist);
  return distances[0].edge;
}

/**
 * Always-mounted drop zone overlay that uses useSyncExternalStore
 * (via useDragState) to reactively compute hit-testing and preview
 * position directly from the drag state during render.
 *
 * The container div is always in the DOM so the ref is always valid.
 */
export function DropZoneTarget({
  groupId,
  paneCount,
  activeIsTerminal,
  onDrop,
  onFileDrop,
}: {
  groupId: string;
  /** Number of panes in THIS group — needed to allow same-group splits when ≥2 */
  paneCount: number;
  /** When true and dragging files, force "center" overlay (no split zones). */
  activeIsTerminal?: boolean;
  onDrop: (position: DropPosition) => void;
  onFileDrop?: (position: DropPosition, filePaths: string[]) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const drag = useDragState();
  // Persist whether this panel's overlay was visible on the COMMITTED render.
  // Updated in useEffect (not during render) to avoid StrictMode double-render corruption.
  const wasShowingRef = useRef(false);
  // Debounce "center" position for cross-group pane drags — prevents brief
  // full-panel flashes when the cursor passes through the center zone.
  const centerCountRef = useRef(0);
  // Track last shown position so the hidden element doesn't default to "center".
  const lastHoveredRef = useRef<DropPosition>("right");

  const isSameGroup = drag.type === "pane" && drag.groupId === groupId;
  // Same-group drop only makes sense when the group has 2+ panes
  // (splitting the only pane out would leave an empty group)
  const allowSameGroup = isSameGroup && paneCount >= 2;

  // Compute overlay visibility & position during render from drag state
  let visible = false;
  let hovered: DropPosition | null = null;

  const HIT_EXPAND = 0;
  const prevPointer: Pointer | null = drag.isDragging
    ? { x: drag.prevMouseX, y: drag.prevMouseY }
    : null;

  if (drag.isDragging) {
    const isFileDrag = drag.type === "file";
    const showForPaneDrag = drag.type === "pane" && (!isSameGroup || allowSameGroup);

    if (isFileDrag || showForPaneDrag) {
      const el = containerRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const { mouseX: mx, mouseY: my } = drag;
        if (
          rect.width > 0 &&
          rect.height > 0 &&
          isInsideRect(rect, mx, my, HIT_EXPAND)
        ) {
          // Clamp mouse position to rect bounds so getDropPosition
          // gets valid 0..1 relative coords even in the HIT_EXPAND zone
          const clampedX = Math.max(rect.left, Math.min(mx, rect.right));
          const clampedY = Math.max(rect.top, Math.min(my, rect.bottom));
          let pos = getDropPosition(rect, clampedX, clampedY);
          if (
            pos === "center" &&
            prevPointer &&
            (
              !isInsideRect(rect, prevPointer.x, prevPointer.y, HIT_EXPAND) ||
              isNearRectEdge(rect, prevPointer.x, prevPointer.y)
            )
          ) {
            const entryEdge = inferEntryEdge(rect, prevPointer, HIT_EXPAND);
            pos = entryEdge ?? nearestEdge(rect, clampedX, clampedY);
          }
          if (
            pos === "center" &&
            drag.type === "pane" &&
            !isSameGroup &&
            !prevPointer
          ) {
            // Safety fallback: if we somehow lack previous pointer state on entry,
            // avoid flashing full-panel by preferring the nearest edge first.
            pos = nearestEdge(rect, clampedX, clampedY);
          }
          if (
            pos === "center" &&
            drag.type === "pane" &&
            !isSameGroup &&
            !wasShowingRef.current
          ) {
            // First visible frame in a new panel: infer intended split side from motion
            // so we don't flash a full-panel center overlay before settling to an edge.
            const dx = drag.mouseX - drag.prevMouseX;
            const dy = drag.mouseY - drag.prevMouseY;
            const absDx = Math.abs(dx);
            const absDy = Math.abs(dy);
            if (absDx + absDy > 0.5) {
              if (absDx >= absDy) {
                pos = dx < 0 ? "right" : "left";
              } else {
                pos = dy < 0 ? "bottom" : "top";
              }
            } else {
              pos = nearestEdge(rect, clampedX, clampedY);
            }
          }
          // File drag onto terminal → always "center" (write path, no split)
          if (isFileDrag && activeIsTerminal) pos = "center";
          // Cross-group pane drags: debounce "center" to avoid brief full-panel
          // flash when the cursor transits through the center zone between edges.
          if (pos === "center" && drag.type === "pane" && !isSameGroup) {
            centerCountRef.current++;
            if (centerCountRef.current < 3) {
              pos = nearestEdge(rect, clampedX, clampedY);
            }
          } else if (drag.type === "pane" && !isSameGroup) {
            centerCountRef.current = 0;
          }
          // "center" on same group is a no-op (tab is already here)
          if (isSameGroup && pos === "center") {
            // keep visible=false, no overlay
          } else {
            visible = true;
            hovered = pos;
          }
        }
      }
    }
  }

  // Drop handler — shared by mouseup (pane/file-explorer drags) and
  // file-drop-commit (Finder drags)
  useEffect(() => {
    const handleDrop = () => {
      const d = getDragState();
      const el = containerRef.current;
      if (!d.isDragging || !el) return;

      const rect = el.getBoundingClientRect();
      if (!isInsideRect(rect, d.mouseX, d.mouseY, HIT_EXPAND)) return;

      const clampedX = Math.max(rect.left, Math.min(d.mouseX, rect.right));
      const clampedY = Math.max(rect.top, Math.min(d.mouseY, rect.bottom));
      let pos = getDropPosition(rect, clampedX, clampedY);
      const prevPointerOnDrop: Pointer = { x: d.prevMouseX, y: d.prevMouseY };
      if (
        pos === "center" &&
        (
          !isInsideRect(rect, prevPointerOnDrop.x, prevPointerOnDrop.y, HIT_EXPAND) ||
          isNearRectEdge(rect, prevPointerOnDrop.x, prevPointerOnDrop.y)
        )
      ) {
        const entryEdge = inferEntryEdge(rect, prevPointerOnDrop, HIT_EXPAND);
        pos = entryEdge ?? nearestEdge(rect, clampedX, clampedY);
      }
      if (!pos) return;

      if (d.type === "file" && d.filePaths.length > 0) {
        // File drag onto terminal → force "center" (write path, no split)
        if (activeIsTerminal) pos = "center";
        onFileDrop?.(pos, d.filePaths);
      } else if (d.type === "pane") {
        const sameGroup = d.groupId === groupId;
        if (sameGroup && paneCount < 2) return;
        if (sameGroup && pos === "center") return;
        onDrop(pos);
      }
    };

    document.addEventListener("mouseup", handleDrop);
    document.addEventListener(FILE_DROP_COMMIT_EVENT, handleDrop);
    return () => {
      document.removeEventListener("mouseup", handleDrop);
      document.removeEventListener(FILE_DROP_COMMIT_EVENT, handleDrop);
    };
  }, [activeIsTerminal, groupId, paneCount, onDrop, onFileDrop]);

  const show = visible && hovered !== null;
  if (hovered) lastHoveredRef.current = hovered;
  // Use last known position when hidden — avoids defaulting to "center" which
  // could flash full-panel if visibility and position don't apply atomically.
  const posStyle = previewStyle(hovered ?? lastHoveredRef.current);

  // Only enable transitions for zone changes within a panel (wasShowing=true),
  // not on initial appear (wasShowing=false).
  const enableTransition = show && wasShowingRef.current;

  // Update wasShowingRef in useEffect (after commit) instead of during render,
  // so React StrictMode double-rendering can't corrupt it.
  // Also reset center debounce when overlay disappears.
  useEffect(() => {
    wasShowingRef.current = show;
    if (!show) centerCountRef.current = 0;
  });

  return (
    <div ref={containerRef} style={styles.hitTarget}>
      <div
        style={{
          ...styles.preview,
          ...posStyle,
          transition: enableTransition ? "top 0.15s ease, left 0.15s ease, width 0.15s ease, height 0.15s ease" : "none",
          visibility: show ? "visible" : "hidden",
        }}
      />
    </div>
  );
}

const TAB_BAR_HEIGHT = 31; // 29px tab bar + 2px inset
const FULL_HEIGHT = `calc(100% - ${TAB_BAR_HEIGHT}px)`;

function previewStyle(pos: DropPosition): React.CSSProperties {
  // Use top+left+width+height (not opposing insets) so only one property
  // per axis changes when sliding between zones — avoids mid-transition expansion.
  switch (pos) {
    case "top":    return { top: TAB_BAR_HEIGHT, left: 0, width: "100%", height: "45%" };
    case "bottom": return { top: `calc(55% + ${TAB_BAR_HEIGHT * 0.55}px)`, left: 0, width: "100%", height: "45%" };
    case "left":   return { top: TAB_BAR_HEIGHT, left: 0, width: "45%", height: FULL_HEIGHT };
    case "right":  return { top: TAB_BAR_HEIGHT, left: "55%", width: "45%", height: FULL_HEIGHT };
    case "center": return { top: TAB_BAR_HEIGHT, left: 0, width: "100%", height: FULL_HEIGHT };
    default:       return { top: TAB_BAR_HEIGHT, left: 0, width: "100%", height: FULL_HEIGHT };
  }
}

const styles: Record<string, React.CSSProperties> = {
  hitTarget: {
    position: "absolute",
    inset: 0,
    zIndex: 50,
    pointerEvents: "none",
  },
  preview: {
    position: "absolute",
    background: "var(--drop-preview-bg, rgba(255, 255, 255, 0.04))",
    border: "1px solid var(--drop-preview-border, rgba(255, 255, 255, 0.08))",
    borderRadius: 2,
    transition: "top 0.15s ease, left 0.15s ease, width 0.15s ease, height 0.15s ease",
    pointerEvents: "none",
  },
};
