import React, { useCallback, useRef } from "react";
import type { SplitDirection } from "../lib/types";

interface ResizeHandleProps {
  direction: SplitDirection;
  ratio: number;
  onResize: (ratio: number) => void;
}

export function ResizeHandle({ direction, ratio, onResize }: ResizeHandleProps) {
  const handleRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const rafRef = useRef<number | null>(null);

  const isRowHandle = direction === "vertical";

  const resetLine = useCallback(() => {
    if (lineRef.current) lineRef.current.style.background = "var(--border)";
  }, []);

  const highlightLine = useCallback(() => {
    if (lineRef.current) lineRef.current.style.background = "var(--resize-hover)";
  }, []);

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
      const firstPane = handle.previousElementSibling as HTMLElement | null;
      const secondPane = handle.nextElementSibling as HTMLElement | null;
      let latestRatio = startRatio;

      const applyPreview = (nextRatio: number) => {
        if (!firstPane || !secondPane) return;
        firstPane.style.flex = `${nextRatio} 1 0%`;
        secondPane.style.flex = `${1 - nextRatio} 1 0%`;
      };

      const scheduleCommit = (nextRatio: number) => {
        latestRatio = nextRatio;
        if (rafRef.current !== null) return;
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          onResize(latestRatio);
        });
      };

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const pointer = isVertical ? ev.clientY : ev.clientX;
        const delta = pointer - startPointer;
        const nextRatio = Math.max(0.15, Math.min(0.85, startRatio + delta / usable));
        applyPreview(nextRatio);
        scheduleCommit(nextRatio);
      };

      const onMouseUp = () => {
        dragging.current = false;
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        onResize(latestRatio);
        document.documentElement.style.removeProperty("--split-transition");
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";

        // Reset line if mouse is no longer over the handle
        if (handleRef.current) {
          const r = handleRef.current.getBoundingClientRect();
          const mouseX = (window as any).__lastMouseX ?? -1;
          const mouseY = (window as any).__lastMouseY ?? -1;
          if (mouseX < r.left || mouseX > r.right || mouseY < r.top || mouseY > r.bottom) {
            resetLine();
          }
        }
      };

      // Track mouse position for mouseup hit-test
      const trackMouse = (ev: MouseEvent) => {
        (window as any).__lastMouseX = ev.clientX;
        (window as any).__lastMouseY = ev.clientY;
      };
      document.addEventListener("mousemove", trackMouse);
      const origOnMouseUp = onMouseUp;
      const wrappedMouseUp = () => {
        origOnMouseUp();
        document.removeEventListener("mousemove", trackMouse);
        delete (window as any).__lastMouseX;
        delete (window as any).__lastMouseY;
      };

      // Disable flex transition on ALL split containers during drag
      document.documentElement.style.setProperty("--split-transition", "none");

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", wrappedMouseUp, { once: true });
      document.body.style.cursor = isVertical ? "row-resize" : "col-resize";
      document.body.style.userSelect = "none";
    },
    [direction, onResize, ratio, resetLine],
  );

  // Column separator (horizontal direction)
  if (!isRowHandle) {
    return (
      <div
        ref={handleRef}
        onMouseDown={onMouseDown}
        style={{
          flexShrink: 0,
          width: 3,
          height: "100%",
          cursor: "col-resize",
          background: "linear-gradient(to bottom, var(--bg-surface) 28px, var(--bg-elevated) 28px, var(--bg-elevated) 29px, var(--bg-app) 29px)",
          zIndex: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        onMouseEnter={() => highlightLine()}
        onMouseLeave={() => {
          if (!dragging.current) resetLine();
        }}
      >
        <div
          ref={lineRef}
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
        height: 5,
        cursor: "row-resize",
        background: "transparent",
        zIndex: 10,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
      }}
      onMouseEnter={() => highlightLine()}
      onMouseLeave={() => {
        if (!dragging.current) resetLine();
      }}
    >
      <div
        ref={lineRef}
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
