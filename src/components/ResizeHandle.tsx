import React, { useCallback, useRef } from "react";
import type { SplitDirection } from "../lib/types";

interface ResizeHandleProps {
  direction: SplitDirection;
  ratio: number;
  onResize: (ratio: number) => void;
}

export function ResizeHandle({ direction, ratio, onResize }: ResizeHandleProps) {
  const handleRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const isRowHandle = direction === "vertical";

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      const handle = handleRef.current;
      if (!handle) return;

      const parent = handle.parentElement;
      if (!parent) return;

      const rect = parent.getBoundingClientRect();
      const handleRect = handle.getBoundingClientRect();
      const isVertical = direction === "vertical";
      const startPointer = isVertical ? e.clientY : e.clientX;
      const startRatio = ratio;
      const total = isVertical ? rect.height : rect.width;
      const handleSize = isVertical ? handleRect.height : handleRect.width;
      const usable = Math.max(1, total - handleSize);

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const pointer = isVertical ? ev.clientY : ev.clientX;
        const delta = pointer - startPointer;
        onResize(startRatio + delta / usable);
      };

      const onMouseUp = () => {
        dragging.current = false;
        document.documentElement.style.removeProperty("--split-transition");
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      // Disable flex transition on ALL split containers during drag
      document.documentElement.style.setProperty("--split-transition", "none");

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = isVertical ? "row-resize" : "col-resize";
      document.body.style.userSelect = "none";
    },
    [direction, onResize, ratio],
  );

  // Column separator (horizontal direction)
  if (!isRowHandle) {
    return (
      <div
        ref={handleRef}
        onMouseDown={onMouseDown}
        style={{
          flexShrink: 0,
          width: 6,
          height: "100%",
          cursor: "col-resize",
          background: "var(--bg-app)",
          zIndex: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        onMouseEnter={(e) => {
          const line = e.currentTarget.firstElementChild as HTMLDivElement;
          if (line) line.style.background = "var(--border)";
        }}
        onMouseLeave={(e) => {
          if (!dragging.current) {
            const line = e.currentTarget.firstElementChild as HTMLDivElement;
            if (line) line.style.background = "var(--border)";
          }
        }}
      >
        <div
          style={{
            width: 1,
            height: "100%",
            background: "var(--border)",
            transition: "background 0.15s",
            pointerEvents: "none",
          }}
        />
      </div>
    );
  }

  // Row separator (vertical direction) — local line within this column only
  return (
    <div
      ref={handleRef}
      onMouseDown={onMouseDown}
      style={{
        flexShrink: 0,
        width: "100%",
        height: 6,
        cursor: "row-resize",
        background: "var(--bg-app)",
        zIndex: 10,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onMouseEnter={(e) => {
        const line = e.currentTarget.firstElementChild as HTMLDivElement;
        if (line) line.style.background = "var(--border)";
      }}
      onMouseLeave={(e) => {
        if (!dragging.current) {
          const line = e.currentTarget.firstElementChild as HTMLDivElement;
          if (line) line.style.background = "var(--border)";
        }
      }}
    >
      <div
        style={{
          width: "100%",
          height: 1,
          background: "var(--border)",
          transition: "background 0.15s",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
