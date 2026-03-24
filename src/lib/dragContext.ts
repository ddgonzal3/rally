/**
 * Mouse-event-based drag system for tab and file dragging between groups.
 * Avoids the HTML5 Drag & Drop API which is unreliable in Tauri/WKWebView.
 *
 * Supports two drag types:
 *   "pane" — dragging a tab between pane groups
 *   "file" — dragging a file from the explorer or Finder into a pane group
 *
 * Uses useSyncExternalStore for proper React 18/19 integration —
 * components call useDragState() to reactively read drag state.
 */

import { useSyncExternalStore } from "react";

export type DragType = "pane" | "file";

export interface DragState {
  isDragging: boolean;
  type: DragType;
  groupId: string | null;
  paneId: string | null;
  filePaths: string[];
  prevMouseX: number;
  prevMouseY: number;
  mouseX: number;
  mouseY: number;
  flightPodId: string | null;
  flightTabIndex: number | null;
}

const IDLE_STATE: DragState = {
  isDragging: false,
  type: "pane",
  groupId: null,
  paneId: null,
  filePaths: [],
  prevMouseX: 0,
  prevMouseY: 0,
  mouseX: 0,
  mouseY: 0,
  flightPodId: null,
  flightTabIndex: null,
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

/** Start dragging a pane tab (internal mouse-based drag). */
export function startDrag(groupId: string, paneId: string, x: number, y: number) {
  state = {
    isDragging: true,
    type: "pane",
    groupId,
    paneId,
    filePaths: [],
    prevMouseX: x,
    prevMouseY: y,
    mouseX: x,
    mouseY: y,
    flightPodId: null,
    flightTabIndex: null,
  };

  const onMouseMove = (e: MouseEvent) => {
    state = {
      ...state,
      prevMouseX: state.mouseX,
      prevMouseY: state.mouseY,
      mouseX: e.clientX,
      mouseY: e.clientY,
    };
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

/** Start dragging a flight pod tab between pods. */
export function startFlightTabDrag(podId: string, tabIndex: number, x: number, y: number) {
  state = {
    isDragging: true,
    type: "pane",
    groupId: null,
    paneId: null,
    filePaths: [],
    prevMouseX: x,
    prevMouseY: y,
    mouseX: x,
    mouseY: y,
    flightPodId: podId,
    flightTabIndex: tabIndex,
  };

  const onMouseMove = (e: MouseEvent) => {
    state = {
      ...state,
      prevMouseX: state.mouseX,
      prevMouseY: state.mouseY,
      mouseX: e.clientX,
      mouseY: e.clientY,
    };
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

/** Start dragging file(s) from the file explorer (mouse-based). */
export function startFileDrag(filePaths: string[], x: number, y: number) {
  state = {
    isDragging: true,
    type: "file",
    groupId: null,
    paneId: null,
    filePaths,
    prevMouseX: x,
    prevMouseY: y,
    mouseX: x,
    mouseY: y,
    flightPodId: null,
    flightTabIndex: null,
  };

  const onMouseMove = (e: MouseEvent) => {
    state = {
      ...state,
      prevMouseX: state.mouseX,
      prevMouseY: state.mouseY,
      mouseX: e.clientX,
      mouseY: e.clientY,
    };
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

/**
 * Start tracking an external file drag (Finder → window).
 * No mouse listeners — Tauri's onDragDropEvent manages position updates.
 */
export function startExternalFileDrag(filePaths: string[], x: number, y: number) {
  state = {
    isDragging: true,
    type: "file",
    groupId: null,
    paneId: null,
    filePaths,
    prevMouseX: x,
    prevMouseY: y,
    mouseX: x,
    mouseY: y,
    flightPodId: null,
    flightTabIndex: null,
  };
  notify();
}

/** Update drag position (for Tauri's 'over' events during external file drag). */
export function updateDragPosition(x: number, y: number) {
  if (!state.isDragging) return;
  state = {
    ...state,
    prevMouseX: state.mouseX,
    prevMouseY: state.mouseY,
    mouseX: x,
    mouseY: y,
  };
  notify();
}

export function endDrag() {
  state = IDLE_STATE;
  notify();
}
