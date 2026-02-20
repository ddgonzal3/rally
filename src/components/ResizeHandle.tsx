import React, { useCallback, useRef } from "react";
import type { SplitDirection } from "../lib/types";

interface ResizeHandleProps {
  direction: SplitDirection;
  onResize: (ratio: number) => void;
}

export function ResizeHandle({ direction, onResize }: ResizeHandleProps) {
  const handleRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      const handle = handleRef.current;
      if (!handle) return;

      const parent = handle.parentElement;
      if (!parent) return;

      const rect = parent.getBoundingClientRect();
      const isVertical = direction === "vertical";

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const pos = isVertical ? ev.clientY - rect.top : ev.clientX - rect.left;
        const total = isVertical ? rect.height : rect.width;
        if (total <= 0) return;
        onResize(pos / total);
      };

      const onMouseUp = () => {
        dragging.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = isVertical ? "row-resize" : "col-resize";
      document.body.style.userSelect = "none";
    },
    [direction, onResize],
  );

  const isVertical = direction === "vertical";

  return (
    <div
      ref={handleRef}
      onMouseDown={onMouseDown}
      style={{
        flexShrink: 0,
        width: isVertical ? "100%" : 2,
        height: isVertical ? 2 : "100%",
        cursor: isVertical ? "row-resize" : "col-resize",
        background: "#2a2a2a",
        transition: "background 0.15s",
        zIndex: 10,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = "#444";
      }}
      onMouseLeave={(e) => {
        if (!dragging.current) {
          (e.currentTarget as HTMLDivElement).style.background = "#2a2a2a";
        }
      }}
    />
  );
}
