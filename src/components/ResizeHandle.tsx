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

  // "vertical" direction = horizontal line (separates top/bottom)
  // "horizontal" direction = vertical line (separates left/right)
  const isHorizontalLine = direction === "vertical";

  // Vertical lines: 1px visible line
  // Horizontal lines: 80% as noticeable (lower opacity)
  const lineThickness = 1;
  const lineOpacity = isHorizontalLine ? 0.8 : 1;

  return (
    <div
      ref={handleRef}
      onMouseDown={onMouseDown}
      style={{
        flexShrink: 0,
        // Wider hit area (6px) for easy grabbing, but thin visible line
        width: isHorizontalLine ? "100%" : 6,
        height: isHorizontalLine ? 6 : "100%",
        cursor: isHorizontalLine ? "row-resize" : "col-resize",
        background: "transparent",
        zIndex: 10,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onMouseEnter={(e) => {
        const line = e.currentTarget.firstElementChild as HTMLDivElement;
        if (line) line.style.background = "#444";
      }}
      onMouseLeave={(e) => {
        if (!dragging.current) {
          const line = e.currentTarget.firstElementChild as HTMLDivElement;
          if (line) line.style.background = "#2a2a2a";
        }
      }}
    >
      <div
        style={{
          width: isHorizontalLine ? "100%" : lineThickness,
          height: isHorizontalLine ? lineThickness : "100%",
          background: "#2a2a2a",
          opacity: lineOpacity,
          transition: "background 0.15s",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
