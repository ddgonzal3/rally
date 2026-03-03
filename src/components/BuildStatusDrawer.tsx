import React, { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useWorkspaceStore, scriptOutputBuffers } from "../stores/workspaceStore";
import type { ThemeName } from "../lib/types";

// Read CSS variables at call time (after theme class is applied to :root)
function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ANSI colors per theme — mirrors Terminal.tsx so drawer output matches
const xtermAnsiColors: Record<ThemeName, Record<string, string>> = {
  dark: {
    black: '#1e1e1e', red: '#df7d7d', green: '#7ddf7d', yellow: '#dfdf7d',
    blue: '#7d7ddf', magenta: '#df7ddf', cyan: '#7ddfdf', white: '#e0e0e0',
  },
  dimmed: {
    black: '#252525', red: '#c87070', green: '#70c870', yellow: '#c8c870',
    blue: '#7070c8', magenta: '#c870c8', cyan: '#70c8c8', white: '#d2d2d2',
  },
  light: {
    black: '#111', red: '#a83224', green: '#1f8c4e', yellow: '#c47e0e',
    blue: '#20659a', magenta: '#73388e', cyan: '#128268', white: '#555',
    brightBlack: '#666', brightWhite: '#333',
  },
};

function getXtermTheme(theme: ThemeName): Record<string, string> {
  return {
    background: getCssVar('--terminal-bg'),
    foreground: getCssVar('--terminal-fg'),
    cursor: getCssVar('--terminal-cursor'),
    selectionBackground: getCssVar('--terminal-selection'),
    ...xtermAnsiColors[theme],
  };
}

export function BuildStatusDrawer() {
  const drawer = useWorkspaceStore((s) => s.statusBarDrawer);
  const closeStatusBarDrawer = useWorkspaceStore((s) => s.closeStatusBarDrawer);
  const theme = useWorkspaceStore((s) => s.theme);

  const panelRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [height, setHeight] = useState(233);
  const dragging = useRef(false);

  const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const startY = e.clientY;
    const startHeight = height;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startY - ev.clientY;
      const newHeight = Math.max(100, Math.min(500, startHeight + delta));
      setHeight(newHeight);
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
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, [height]);

  // Escape to close + click outside to close
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeStatusBarDrawer();
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      // Don't close if clicking inside the drawer or the status bar (status bar handles its own toggle)
      if (panelRef.current && !panelRef.current.contains(target)
        && !(target instanceof Element && target.closest("[data-statusbar]"))) {
        closeStatusBarDrawer();
      }
    };
    document.addEventListener("keydown", onKey);
    // Use mousedown so click registers before any focus shifts
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [drawer, closeStatusBarDrawer]);

  // Initialize xterm, replay buffer, and stream live output
  useEffect(() => {
    if (!termRef.current || !drawer) return;

    const term = new XTerminal({
      scrollback: 5000,
      disableStdin: true,
      cursorBlink: false,
      fontSize: 12,
      fontFamily: "'SF Mono', 'Menlo', 'Monaco', monospace",
      theme: getXtermTheme(theme),
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);

    try { fitAddon.fit(); } catch {}

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Replay buffered output — raw Uint8Array, never TextDecoder
    const bufferKey = `${drawer.repoPath}:${drawer.scriptName}`;
    const buf = scriptOutputBuffers.get(bufferKey);
    if (buf) {
      for (const chunk of buf) {
        term.write(chunk);
      }
    }

    // Track how many chunks we've written for incremental updates
    let writtenChunks = buf ? buf.length : 0;

    // Listen for new output
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.key === bufferKey) {
        const currentBuf = scriptOutputBuffers.get(bufferKey);
        if (currentBuf) {
          for (let i = writtenChunks; i < currentBuf.length; i++) {
            term.write(currentBuf[i]);
          }
          writtenChunks = currentBuf.length;
        }
      }
    };
    document.addEventListener("rally:watcher-output", handler);

    return () => {
      document.removeEventListener("rally:watcher-output", handler);
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [drawer?.repoPath, drawer?.scriptName]);

  // Sync xterm theme when the app theme changes
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = getXtermTheme(theme);
    }
  }, [theme]);

  // ResizeObserver for xterm fit
  useEffect(() => {
    if (!termRef.current || !fitAddonRef.current) return;
    const fitAddon = fitAddonRef.current;
    const ro = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch {}
    });
    ro.observe(termRef.current);
    return () => ro.disconnect();
  }, [drawer]);

  if (!drawer) return null;

  return (
    <div ref={panelRef} style={{
      position: "absolute" as const,
      bottom: 28,
      left: 0,
      right: 0,
      height,
      background: "var(--terminal-bg)",
      zIndex: 100,
      display: "flex",
      flexDirection: "column" as const,
    }}>
      {/* Resize handle */}
      <div
        onMouseDown={onHandleMouseDown}
        style={{
          height: 8,
          cursor: "row-resize",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderTop: "1px solid var(--border)",
        }}
      >
        <div style={{
          width: 32,
          height: 3,
          borderRadius: 2,
          background: "var(--text-dim)",
          opacity: 0.4,
        }} />
      </div>
      <div ref={termRef} style={{ flex: 1, overflow: "hidden" }} />
    </div>
  );
}
