import React, { useCallback, useRef } from "react";
import type { SplitDirection } from "../lib/types";

interface ResizeHandleProps {
  direction: SplitDirection;
  ratio: number;
  onResize: (ratio: number, syncPeers?: boolean) => void;
}

/** Snap threshold in ratio units — wide enough to feel magnetic when near a peer divider */
const SNAP_THRESHOLD = 0.025;

interface PeerHandle {
  ratio: number;
  firstPane: HTMLElement;
  secondPane: HTMLElement;
  originalFirstFlex: string;
  originalSecondFlex: string;
}

/**
 * Collect peer resize handles in adjacent split containers.
 * Returns both ratios (for snapping) and DOM elements (for Option+drag preview).
 */
function collectPeerHandles(handle: HTMLElement, direction: SplitDirection): PeerHandle[] {
  const parent = handle.parentElement;
  if (!parent) return [];

  const grandparent = parent.parentElement;
  if (!grandparent) return [];

  const isVertical = direction === "vertical";
  const peers: PeerHandle[] = [];

  const greatGrandparent = grandparent.parentElement;
  if (!greatGrandparent) return peers;

  const siblingContainers = greatGrandparent.children;
  for (let i = 0; i < siblingContainers.length; i++) {
    const sibling = siblingContainers[i] as HTMLElement;
    if (sibling === grandparent) continue;

    const handles = sibling.querySelectorAll<HTMLElement>('[style*="cursor"]');
    for (const peerHandle of handles) {
      const cursor = peerHandle.style.cursor;
      const isPeerSameDirection =
        (isVertical && cursor === "row-resize") ||
        (!isVertical && cursor === "col-resize");
      if (!isPeerSameDirection) continue;

      const peerParent = peerHandle.parentElement;
      if (!peerParent) continue;
      const peerParentRect = peerParent.getBoundingClientRect();
      const peerHandleRect = peerHandle.getBoundingClientRect();
      const peerTotal = isVertical ? peerParentRect.height : peerParentRect.width;
      if (peerTotal < 1) continue;

      const peerPos = isVertical
        ? peerHandleRect.top - peerParentRect.top
        : peerHandleRect.left - peerParentRect.left;
      const peerRatio = peerPos / peerTotal;

      const firstPane = peerHandle.previousElementSibling as HTMLElement | null;
      const secondPane = peerHandle.nextElementSibling as HTMLElement | null;
      if (!firstPane || !secondPane) continue;

      peers.push({
        ratio: peerRatio,
        firstPane,
        secondPane,
        originalFirstFlex: firstPane.style.flex,
        originalSecondFlex: secondPane.style.flex,
      });
    }
  }

  return peers;
}

export function ResizeHandle({ direction, ratio, onResize }: ResizeHandleProps) {
  const handleRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;

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
      const startRatio = ratioRef.current;
      const total = isVertical ? rect.height : rect.width;
      const handleSize = isVertical ? handleRect.height : handleRect.width;
      const usable = Math.max(1, total - handleSize);
      const firstPane = handle.previousElementSibling as HTMLElement | null;
      const secondPane = handle.nextElementSibling as HTMLElement | null;
      let latestRatio = startRatio;

      // Collect peer handles at drag start for snapping and Option+drag sync
      const peerHandles = collectPeerHandles(handle, direction);
      let peersAreSynced = false;

      const snapRatio = (r: number): number => {
        for (const peer of peerHandles) {
          if (Math.abs(r - peer.ratio) < SNAP_THRESHOLD) return peer.ratio;
        }
        return r;
      };

      const applyPreview = (nextRatio: number, syncPeers: boolean) => {
        if (!firstPane || !secondPane) return;
        firstPane.style.flex = `${nextRatio} 1 0%`;
        secondPane.style.flex = `${1 - nextRatio} 1 0%`;
        // Option held: move aligned peer handles too
        if (syncPeers) {
          for (const peer of peerHandles) {
            peer.firstPane.style.flex = `${nextRatio} 1 0%`;
            peer.secondPane.style.flex = `${1 - nextRatio} 1 0%`;
          }
          peersAreSynced = true;
        } else if (peersAreSynced) {
          // Option released mid-drag: restore peers to original flex
          for (const peer of peerHandles) {
            peer.firstPane.style.flex = peer.originalFirstFlex;
            peer.secondPane.style.flex = peer.originalSecondFlex;
          }
          peersAreSynced = false;
        }
      };

      let pendingRaf: number | null = null;
      let latestAltKey = false;

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const pointer = isVertical ? ev.clientY : ev.clientX;
        const delta = pointer - startPointer;
        let nextRatio = Math.max(0.15, Math.min(0.85, startRatio + delta / usable));
        nextRatio = snapRatio(nextRatio);
        latestRatio = nextRatio;
        latestAltKey = ev.altKey;
        if (pendingRaf === null) {
          pendingRaf = requestAnimationFrame(() => {
            pendingRaf = null;
            applyPreview(latestRatio, latestAltKey);
          });
        }
      };

      const onMouseUp = (_ev: MouseEvent) => {
        dragging.current = false;
        if (pendingRaf !== null) {
          cancelAnimationFrame(pendingRaf);
          pendingRaf = null;
        }
        // Use peersAreSynced (set during drag) rather than ev.altKey,
        // because Option may be released slightly before the mouse button.
        applyPreview(latestRatio, peersAreSynced);
        document.documentElement.removeAttribute("data-rally-split-drag");
        document.documentElement.removeAttribute("data-rally-split-drag-direction");
        onResizeRef.current(latestRatio, peersAreSynced);
        document.dispatchEvent(new CustomEvent("rally:split-resize-end"));
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
      const wrappedMouseUp = (ev: MouseEvent) => {
        origOnMouseUp(ev);
        document.removeEventListener("mousemove", trackMouse);
        delete (window as any).__lastMouseX;
        delete (window as any).__lastMouseY;
      };

      // Disable flex transition on ALL split containers during drag
      document.documentElement.style.setProperty("--split-transition", "none");
      document.documentElement.setAttribute("data-rally-split-drag", "1");
      document.documentElement.setAttribute("data-rally-split-drag-direction", direction);
      document.dispatchEvent(new CustomEvent("rally:split-resize-start", { detail: { direction } }));

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", wrappedMouseUp, { once: true });
      document.body.style.cursor = isVertical ? "row-resize" : "col-resize";
      document.body.style.userSelect = "none";
    },
    [direction, resetLine],
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
