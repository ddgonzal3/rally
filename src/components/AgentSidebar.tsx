import React, { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { AgentsPanel } from "./AgentsPanel";

/**
 * Dedicated left sidebar for agents — leftmost column of the window, like
 * the conversation list in Claude Desktop. Collapses fully (width 0) with
 * one eased motion; content fades and slides so nothing reflows mid-way.
 *
 * Auto-collapses when the window snaps to half screen or narrower and
 * comes back on its own when the window grows again, unless the user
 * collapsed it by hand.
 */

export const AGENT_SIDEBAR_WIDTH = 240;
const MIN_WIDTH = 180;
const MAX_WIDTH = 440;
const STORAGE_KEY = "rally:agentSidebarCollapsed";
const WIDTH_KEY = "rally:agentSidebarWidth";
const SNAP_THRESHOLD = 150;
const EASING = "cubic-bezier(0.2, 0, 0, 1)";
const DURATION_MS = 220;

interface AgentSidebarState {
  collapsed: boolean;
  /** True when the last collapse was automatic (half-screen snap). */
  auto: boolean;
  width: number;
  setCollapsed: (collapsed: boolean, auto?: boolean) => void;
  setWidth: (width: number) => void;
  toggle: () => void;
}

export const useAgentSidebarStore = create<AgentSidebarState>((set) => ({
  collapsed: (() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  })(),
  auto: false,
  width: (() => {
    try {
      const n = Number(localStorage.getItem(WIDTH_KEY));
      return n >= MIN_WIDTH && n <= MAX_WIDTH ? n : AGENT_SIDEBAR_WIDTH;
    } catch {
      return AGENT_SIDEBAR_WIDTH;
    }
  })(),
  setWidth: (width) => {
    const clamped = Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width)));
    try {
      localStorage.setItem(WIDTH_KEY, String(clamped));
    } catch {}
    set({ width: clamped });
  },
  setCollapsed: (collapsed, auto = false) => {
    try {
      localStorage.setItem(STORAGE_KEY, String(collapsed));
    } catch {}
    set({ collapsed, auto });
  },
  toggle: () =>
    set((s) => {
      const collapsed = !s.collapsed;
      try {
        localStorage.setItem(STORAGE_KEY, String(collapsed));
      } catch {}
      return { collapsed, auto: false };
    }),
}));

export function AgentSidebar() {
  const collapsed = useAgentSidebarStore((s) => s.collapsed);
  const width = useAgentSidebarStore((s) => s.width);
  const setCollapsed = useAgentSidebarStore((s) => s.setCollapsed);
  const setWidth = useAgentSidebarStore((s) => s.setWidth);
  const prevWidthRef = useRef(window.innerWidth);
  const [dragging, setDragging] = useState(false);

  // Edge drag to resize. No transition while dragging so it tracks the pointer.
  const startResize = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = useAgentSidebarStore.getState().width;
    const zoom = parseFloat(localStorage.getItem("rally:zoomLevel") || "1") || 1;
    setDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => setWidth(startW + (ev.clientX - startX) / zoom);
    const onUp = () => {
      setDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // Half-screen auto collapse / restore.
  useEffect(() => {
    const check = () => {
      const w = window.innerWidth;
      const half = window.screen.width / 2;
      const isSnap = Math.abs(w - prevWidthRef.current) >= SNAP_THRESHOLD;
      prevWidthRef.current = w;
      const s = useAgentSidebarStore.getState();
      if (isSnap && w <= half && !s.collapsed) {
        setCollapsed(true, true);
      } else if (isSnap && w > half && s.collapsed && s.auto) {
        setCollapsed(false, false);
      }
    };
    // Initial: a window that starts narrow shouldn't open with the sidebar.
    if (window.innerWidth <= window.screen.width / 2 && !useAgentSidebarStore.getState().collapsed) {
      setCollapsed(true, true);
    }
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [setCollapsed]);

  // Cmd+B toggles. Capture phase so it works while a terminal is focused
  // (Terminal.tsx lets Cmd+B bubble).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        useAgentSidebarStore.getState().toggle();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div
      data-agent-sidebar
      aria-hidden={collapsed}
      style={{
        width: collapsed ? 0 : width,
        minWidth: 0,
        flexShrink: 0,
        overflow: "visible",
        background: "var(--bg-surface)",
        borderRight: collapsed ? "1px solid transparent" : "1px solid var(--border)",
        transition: dragging ? "none" : `width ${DURATION_MS}ms ${EASING}, border-color ${DURATION_MS}ms ${EASING}`,
        willChange: "width",
        position: "relative",
      }}
    >
      <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
        <div
          style={{
            width,
            height: "100%",
            opacity: collapsed ? 0 : 1,
            transform: collapsed ? "translateX(-12px)" : "translateX(0)",
            transition: dragging
              ? "none"
              : `opacity ${collapsed ? 120 : 180}ms ease${collapsed ? "" : ` ${DURATION_MS - 180}ms`}, transform ${DURATION_MS}ms ${EASING}`,
            pointerEvents: collapsed ? "none" : "auto",
          }}
        >
          <AgentsPanel />
        </div>
      </div>
      {!collapsed && (
        <div
          onMouseDown={startResize}
          onDoubleClick={() => setWidth(AGENT_SIDEBAR_WIDTH)}
          title="Drag to resize. Double-click to reset."
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            right: -3,
            width: 6,
            cursor: "col-resize",
            zIndex: 5,
          }}
        />
      )}
    </div>
  );
}

/** Titlebar toggle — sits right after the traffic lights. */
export function AgentSidebarToggle() {
  const collapsed = useAgentSidebarStore((s) => s.collapsed);
  const toggle = useAgentSidebarStore((s) => s.toggle);
  return (
    <button
      className="activity-btn"
      onClick={(e) => {
        e.stopPropagation();
        toggle();
      }}
      title={collapsed ? "Show agents (⌘B)" : "Hide agents (⌘B)"}
      style={{
        background: "none",
        border: "none",
        cursor: "pointer",
        width: 26,
        height: 22,
        padding: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 4,
        color: "var(--text-secondary)",
      }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.1" />
        <path d="M6 2.5v11" stroke="currentColor" strokeWidth="1.1" />
        {!collapsed && <path d="M3.2 5h1.6M3.2 7h1.6M3.2 9h1.6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />}
      </svg>
    </button>
  );
}
