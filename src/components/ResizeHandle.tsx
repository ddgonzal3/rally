import React, { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { SplitDirection } from "../lib/types";

interface ResizeHandleProps {
  direction: SplitDirection;
  ratio: number;
  onResize: (ratio: number) => void;
}

// --- Row overlay helpers ---
// Row (vertical) resize handles use a full-width overlay line so the separator
// visually spans all columns as one continuous line.

function highlightRowOverlays() {
  document
    .querySelectorAll<HTMLDivElement>("[data-row-overlay] > div")
    .forEach((el) => {
      el.style.background = "#444";
    });
}

function unhighlightRowOverlays() {
  document
    .querySelectorAll<HTMLDivElement>("[data-row-overlay] > div")
    .forEach((el) => {
      el.style.background = "#2a2a2a";
    });
}

export function ResizeHandle({ direction, ratio, onResize }: ResizeHandleProps) {
  const handleRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const isRowHandle = direction === "vertical";

  // Create/destroy a full-width overlay line for row handles.
  // The overlay is appended to the nearest [data-pane-area] ancestor
  // (the PaneLayout container) so it spans the pane area, not the full viewport.
  useEffect(() => {
    if (!isRowHandle || !handleRef.current) return;

    const paneArea = handleRef.current.closest("[data-pane-area]");
    if (!paneArea) return;

    const overlay = document.createElement("div");
    overlay.setAttribute("data-row-overlay", "");
    overlay.style.cssText = `
      position: absolute; left: 0; right: 0; height: 1px;
      pointer-events: none; z-index: 100;
    `;
    const line = document.createElement("div");
    line.style.cssText = `
      width: 100%; height: 1px; background: #2a2a2a;
      transition: background 0.15s; opacity: 0.8;
    `;
    overlay.appendChild(line);
    paneArea.appendChild(overlay);
    overlayRef.current = overlay;

    // Reposition on window resize
    const onWindowResize = () => {
      if (handleRef.current && overlay) {
        const handleRect = handleRef.current.getBoundingClientRect();
        const areaRect = paneArea.getBoundingClientRect();
        overlay.style.top = `${handleRect.bottom - 1 - areaRect.top}px`;
      }
    };
    window.addEventListener("resize", onWindowResize);

    return () => {
      window.removeEventListener("resize", onWindowResize);
      overlay.remove();
      overlayRef.current = null;
    };
  }, [isRowHandle]);

  // Keep overlay positioned at the handle's bottom edge (relative to pane area)
  useLayoutEffect(() => {
    if (!isRowHandle || !overlayRef.current || !handleRef.current) return;
    const paneArea = handleRef.current.closest("[data-pane-area]");
    if (!paneArea) return;
    const handleRect = handleRef.current.getBoundingClientRect();
    const areaRect = paneArea.getBoundingClientRect();
    overlayRef.current.style.top = `${handleRect.bottom - 1 - areaRect.top}px`;
  });

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

      if (isVertical) highlightRowOverlays();

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const pointer = isVertical ? ev.clientY : ev.clientX;
        const delta = pointer - startPointer;
        onResize(startRatio + delta / usable);
      };

      const onMouseUp = () => {
        dragging.current = false;
        document.documentElement.style.removeProperty("--split-transition");
        if (isVertical) unhighlightRowOverlays();
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
          background: "#1a1a1a",
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
            width: 1,
            height: "100%",
            background: "#2a2a2a",
            transition: "background 0.15s",
            pointerEvents: "none",
          }}
        />
      </div>
    );
  }

  // Row separator (vertical direction) — visible line comes from the overlay;
  // this div is just the invisible grab handle
  return (
    <div
      ref={handleRef}
      onMouseDown={onMouseDown}
      style={{
        flexShrink: 0,
        width: "100%",
        height: 6,
        cursor: "row-resize",
        background: "#1a1a1a",
        zIndex: 10,
      }}
      onMouseEnter={() => highlightRowOverlays()}
      onMouseLeave={() => {
        if (!dragging.current) unhighlightRowOverlays();
      }}
    />
  );
}
