import React, { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useWorkspaceStore, scriptOutputBuffers } from "../stores/workspaceStore";
import { api } from "../lib/tauri";
import type { ThemeName } from "../lib/types";
import { TerminalPromptIcon } from "./FileIcons";

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
  const stopScript = useWorkspaceStore((s) => s.stopScript);
  const clearScript = useWorkspaceStore((s) => s.clearScript);
  const scriptRuns = useWorkspaceStore((s) => s.scriptRuns);
  const theme = useWorkspaceStore((s) => s.theme);

  const panelRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [height, setHeight] = useState(233);
  const [pinned, setPinned] = useState(false);
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
      if (pinned) return;
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
  }, [drawer, pinned, closeStatusBarDrawer]);

  // Initialize xterm, replay buffer, and stream live output
  useEffect(() => {
    if (!termRef.current || !drawer) return;

    const term = new XTerminal({
      scrollback: 5000,
      disableStdin: false,
      cursorBlink: true,
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

    // Wire input to PTY (Ctrl+C, typing, etc.)
    // Read ptyId from store at send-time so it's always fresh
    const bufferKey = `${drawer.repoPath}:${drawer.scriptName}`;
    const encoder = new TextEncoder();
    const onDataDisposable = term.onData((data) => {
      const currentRun = useWorkspaceStore.getState().scriptRuns[bufferKey];
      if (currentRun?.ptyId) {
        api.writePty(currentRun.ptyId, Array.from(encoder.encode(data))).catch(() => {});
      }
    });

    // Focus the terminal so it captures keyboard input (Ctrl+C, etc.)
    requestAnimationFrame(() => term.focus());

    // Replay buffered output — raw Uint8Array, never TextDecoder
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
      onDataDisposable.dispose();
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
    const term = xtermRef.current;
    const ro = new ResizeObserver(() => {
      try {
        fitAddon.fit();
        term?.scrollToBottom();
      } catch {}
    });
    ro.observe(termRef.current);
    return () => ro.disconnect();
  }, [drawer]);

  if (!drawer) return null;

  const bufferKey = `${drawer.repoPath}:${drawer.scriptName}`;
  const currentRun = scriptRuns[bufferKey];
  const isRunning = currentRun?.status === "running";

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
      boxShadow: theme === "light"
        ? "0 -3px 12px rgba(0,0,0,0.08)"
        : "0 -3px 12px rgba(255,255,255,0.035)",
    }}>
      {/* Combined resize handle + header */}
      <div
        onMouseDown={onHandleMouseDown}
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0 10px",
          minHeight: 29,
          maxHeight: 29,
          cursor: "row-resize",
          flexShrink: 0,
          background: "var(--bg-surface)",
          boxShadow: "inset 0 -1px 0 var(--bg-elevated)",
          borderTop: "1px solid var(--border)",
          gap: 6,
        }}>
        <button
          onClick={(e) => { e.stopPropagation(); setPinned((p) => !p); }}
          title={pinned ? "Unpin (click outside will close)" : "Pin open"}
          style={{ ...drawerBtnStyle, padding: "2px 0" }}
        >
          {pinned ? (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M4.10002 1.08186L3.72499 1.94778L5.18409 3.40687L4.53635 7.42274C4.01662 7.60746 3.55856 7.93327 3.21358 8.36365C2.87267 8.79115 2.65993 9.30651 2.59998 9.85L3.09777 10.3478L6.91588 10.2932L6.9091 16L7.94543 14.9637L7.94548 10.2728L11.3 10.2319L11.8181 9.71367C11.7748 9.17983 11.5742 8.67084 11.2417 8.25096C10.9092 7.83107 10.4597 7.51912 9.95002 7.35457L9.42496 3.35227L10.925 1.85227L10.5772 1L4.10002 1.08186ZM8.5523 2.80687L8.40224 3.24324L9.00224 7.75686L9.30907 8.1455C9.88043 8.32423 10.369 8.70152 10.6864 9.20914L7.95912 9.20914L3.77272 9.26369C4.10766 8.75069 4.60442 8.36429 5.18409 8.16594L5.5046 7.76369L6.23411 3.22959L6.0977 2.80687L5.31359 2.02277L9.34997 1.96825L8.5523 2.80687Z" fill="var(--text-primary)" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M15.4181 4.50005L14.5522 4.12501L13.0931 5.58411L9.07726 4.93638C8.89254 4.41665 8.56673 3.95859 8.13635 3.61361C7.70885 3.2727 7.19349 3.05996 6.65 3L6.1522 3.4978L6.20684 7.31591L0.5 7.30913L1.53633 8.34546L6.22719 8.3455L6.26814 11.7L6.78633 12.2182C7.32017 12.1748 7.82916 11.9743 8.24904 11.6418C8.66893 11.3093 8.98088 10.8597 9.14543 10.35L13.1477 9.82499L14.6477 11.325L15.5 10.9773L15.4181 4.50005ZM13.6931 8.95233L13.2568 8.80226L8.74314 9.40226L8.3545 9.70909C8.17577 10.2805 7.79848 10.769 7.29086 11.0864V8.35915L7.23631 4.17275C7.74931 4.50768 8.13571 5.00445 8.33406 5.58411L8.73631 5.90463L13.2704 6.63413L13.6931 6.49772L14.4772 5.71362L14.5317 9.75L13.6931 8.95233Z" fill="var(--text-dim)" />
            </svg>
          )}
        </button>
        <TerminalPromptIcon size={14} />
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
          {drawer.scriptName}
        </span>
        {isRunning && (
          <button
            onClick={() => stopScript(drawer.repoPath, drawer.scriptName)}
            title="Kill process"
            style={drawerBtnStyle}
          >
            <svg width="12" height="12" viewBox="0 0 10 10" fill="none"><rect x="2" y="2" width="6" height="6" rx="1" fill="var(--text-dim)" /></svg>
          </button>
        )}
        {!isRunning && currentRun && (
          <button
            onClick={() => {
              clearScript(drawer.repoPath, drawer.scriptName);
              closeStatusBarDrawer();
            }}
            title="Clear"
            style={drawerBtnStyle}
          >
            <svg width="12" height="12" viewBox="0 0 10 10" fill="none">
              <path d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5" stroke="var(--text-dim)" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      <div ref={termRef} style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", justifyContent: "flex-end" }} />
    </div>
  );
}

const drawerBtnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "none",
  border: "none",
  color: "var(--text-dim)",
  cursor: "pointer",
  padding: "2px 4px",
  borderRadius: 3,
  flexShrink: 0,
};
