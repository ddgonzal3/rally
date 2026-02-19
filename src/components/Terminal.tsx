import React, { useEffect, useRef } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../lib/tauri";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  cwd: string;
  command?: string;
}

const encoder = new TextEncoder();

// Minimum acceptable terminal dimensions.
// If FitAddon proposes anything smaller, we skip the resize entirely
// to prevent xterm from entering a broken state.
const MIN_COLS = 10;
const MIN_ROWS = 4;

/**
 * Safe wrapper around FitAddon.fit().
 * Uses proposeDimensions() to get the values, validates them,
 * and only applies the resize if they're reasonable.
 * This prevents xterm from ever resizing to 1-2 columns during
 * transient layout states.
 */
function safeFit(term: XTerminal, fitAddon: FitAddon): boolean {
  const dims = fitAddon.proposeDimensions();
  if (!dims) return false;
  // Guard against NaN/Infinity from incomplete layout measurements
  if (!Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return false;
  const cols = Math.round(dims.cols);
  const rows = Math.round(dims.rows);
  if (cols < MIN_COLS || rows < MIN_ROWS) return false;
  if (cols === term.cols && rows === term.rows) return false;

  // Access xterm internals to clear renderer before resize (same as FitAddon.fit)
  const core = (term as any)._core;
  if (core?._renderService) {
    core._renderService.clear();
  }
  term.resize(cols, rows);
  return true;
}

export function Terminal({ cwd, command }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const unlistenOutputRef = useRef<UnlistenFn | null>(null);
  const unlistenExitRef = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerminal({
      cols: 80,
      rows: 24,
      theme: {
        background: "#1a1a1a",
        foreground: "#e0e0e0",
        cursor: "#a0a0a0",
        selectionBackground: "#44444488",
        black: "#1a1a1a",
        red: "#df7d7d",
        green: "#7ddf7d",
        yellow: "#dfdf7d",
        blue: "#7d7ddf",
        magenta: "#df7ddf",
        cyan: "#7ddfdf",
        white: "#e0e0e0",
      },
      fontSize: 13,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
      cursorBlink: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(containerRef.current);

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    let ptySpawned = false;
    let rafId: number | null = null;

    async function spawnPty() {
      if (ptySpawned) return;
      ptySpawned = true;

      try {
        safeFit(term, fitAddon);
        // Ensure at least 80x24 — protects against xterm auto-sizing to
        // a tiny container during initial layout settling
        const spawnCols = Math.max(term.cols, 80);
        const spawnRows = Math.max(term.rows, 24);
        const ptyId = await api.spawnPty(cwd, command ?? null, spawnCols, spawnRows);
        ptyIdRef.current = ptyId;

        unlistenOutputRef.current = await listen<{ data: number[] }>(
          `pty-output-${ptyId}`,
          (event) => {
            term.write(new Uint8Array(event.payload.data));
          }
        );

        unlistenExitRef.current = await listen<{ code: number | null }>(
          `pty-exit-${ptyId}`,
          (event) => {
            const code = event.payload.code;
            term.writeln(
              `\r\n\x1b[90m[Process exited${code != null ? ` with code ${code}` : ""}]\x1b[0m`
            );
          }
        );

        term.onData((data) => {
          if (ptyIdRef.current) {
            api.writePty(
              ptyIdRef.current,
              Array.from(encoder.encode(data))
            );
          }
        });

        term.onResize(({ cols, rows }) => {
          if (ptyIdRef.current && cols >= MIN_COLS && rows >= MIN_ROWS) {
            api.resizePty(ptyIdRef.current, cols, rows);
          }
        });

        // Sync dimensions after the async gap — a resize may have occurred
        // during the await (before onResize was registered), leaving the
        // PTY at stale dimensions.
        if (safeFit(term, fitAddon)) {
          // safeFit resized xterm, but onResize already forwarded it.
          // No extra action needed.
        } else {
          // xterm may already be at a different size than what we spawned with.
          const currentCols = term.cols;
          const currentRows = term.rows;
          if (
            currentCols >= MIN_COLS &&
            currentRows >= MIN_ROWS &&
            (currentCols !== spawnCols || currentRows !== spawnRows)
          ) {
            api.resizePty(ptyId, currentCols, currentRows);
          }
        }
      } catch (e) {
        term.writeln(`\x1b[31mFailed to start terminal: ${e}\x1b[0m`);
      }
    }

    const el = containerRef.current;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth < 100 || el.clientHeight < 50) return;

      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!ptySpawned) {
          spawnPty();
        } else {
          safeFit(term, fitAddon);
        }
      });
    });
    observer.observe(el);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
      if (ptyIdRef.current) {
        api.killPty(ptyIdRef.current);
        ptyIdRef.current = null;
      }
      unlistenOutputRef.current?.();
      unlistenExitRef.current?.();
      term.dispose();
    };
  }, [cwd, command]);

  return (
    <div style={styles.container}>
      <div ref={containerRef} style={styles.terminal} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    background: "#1a1a1a",
    overflow: "hidden",
  },
  terminal: {
    flex: 1,
    padding: 4,
    overflow: "hidden",
  },
};
