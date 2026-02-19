/**
 * Mouse-event-based drag system for tab dragging between groups.
 * Avoids the HTML5 Drag & Drop API which is unreliable in Tauri/WKWebView.
 *
 * Uses useSyncExternalStore for proper React 18/19 integration —
 * components call useDragState() to reactively read drag state.
 */

import { useSyncExternalStore } from "react";

export interface DragState {
  isDragging: boolean;
  groupId: string | null;
  paneId: string | null;
  mouseX: number;
  mouseY: number;
}

const IDLE_STATE: DragState = {
  isDragging: false,
  groupId: null,
  paneId: null,
  mouseX: 0,
  mouseY: 0,
};

let state: DragState = IDLE_STATE;

let listeners: Array<() => void> = [];

function subscribe(fn: () => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

function notify() {
  listeners.forEach((fn) => fn());
}

function getSnapshot(): DragState {
  return state;
}

/** React hook — re-renders the component whenever the drag state changes. */
export function useDragState(): Readonly<DragState> {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function getDragState(): Readonly<DragState> {
  return state;
}

export function startDrag(groupId: string, paneId: string, x: number, y: number) {
  state = { isDragging: true, groupId, paneId, mouseX: x, mouseY: y };

  const onMouseMove = (e: MouseEvent) => {
    state = { ...state, mouseX: e.clientX, mouseY: e.clientY };
    notify();
  };

  const onMouseUp = () => {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    // Notify with isDragging still true so drop targets can act
    notify();
    // Then end the drag
    setTimeout(() => {
      state = IDLE_STATE;
      notify();
    }, 0);
  };

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  document.body.style.cursor = "grabbing";
  document.body.style.userSelect = "none";
  notify();
}

export function endDrag() {
  state = IDLE_STATE;
  notify();
}
