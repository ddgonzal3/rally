import React, { useRef, useEffect } from "react";
import { useDragState, getDragState } from "../lib/dragContext";

export type DropPosition = "top" | "bottom" | "left" | "right" | "center";

/** Custom event dispatched by App.tsx when Finder drops files on the window. */
export const FILE_DROP_COMMIT_EVENT = "file-drop-commit";

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
  onDrop,
  onFileDrop,
}: {
  groupId: string;
  /** Number of panes in THIS group — needed to allow same-group splits when ≥2 */
  paneCount: number;
  onDrop: (position: DropPosition) => void;
  onFileDrop?: (position: DropPosition, filePaths: string[]) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const drag = useDragState();

  const isSameGroup = drag.type === "pane" && drag.groupId === groupId;
  // Same-group drop only makes sense when the group has 2+ panes
  // (splitting the only pane out would leave an empty group)
  const allowSameGroup = isSameGroup && paneCount >= 2;

  // Compute overlay visibility & position during render from drag state
  let visible = false;
  let hovered: DropPosition | null = null;

  // Expand detection bounds slightly so overlay activates before cursor
  // fully crosses the resize handle between panels (~6px gap).
  const HIT_EXPAND = 8;

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
          mx >= rect.left - HIT_EXPAND &&
          mx <= rect.right + HIT_EXPAND &&
          my >= rect.top - HIT_EXPAND &&
          my <= rect.bottom + HIT_EXPAND
        ) {
          const pos = getDropPosition(rect, mx, my);
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
      if (
        d.mouseX < rect.left ||
        d.mouseX > rect.right ||
        d.mouseY < rect.top ||
        d.mouseY > rect.bottom
      ) return;

      const pos = getDropPosition(rect, d.mouseX, d.mouseY);
      if (!pos) return;

      if (d.type === "file" && d.filePaths.length > 0) {
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
  }, [groupId, paneCount, onDrop, onFileDrop]);

  return (
    <div ref={containerRef} style={styles.hitTarget}>
      {visible && hovered && hovered !== "center" && (
        <div style={{ ...styles.preview, ...previewStyle(hovered) }} />
      )}
      {visible && hovered === "center" && (
        <div style={{ ...styles.preview, inset: 2 }} />
      )}
    </div>
  );
}

function previewStyle(pos: DropPosition): React.CSSProperties {
  switch (pos) {
    case "top": return { top: 2, left: 2, right: 2, height: "45%" };
    case "bottom": return { bottom: 2, left: 2, right: 2, height: "45%" };
    case "left": return { top: 2, left: 2, bottom: 2, width: "45%" };
    case "right": return { top: 2, right: 2, bottom: 2, width: "45%" };
    default: return {};
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
    background: "rgba(255, 255, 255, 0.05)",
    border: "1px solid rgba(255, 255, 255, 0.12)",
    borderRadius: 4,
    transition: "all 0.1s ease",
    pointerEvents: "none",
  },
};
