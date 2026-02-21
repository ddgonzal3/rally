import React, { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../lib/tauri";
import { useWorkspaceStore, shipOutputBuffer } from "../stores/workspaceStore";
import { showContextMenu } from "../lib/contextMenu";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  cwd: string;
  command?: string;
  initialInput?: string;
  ptyId?: string;  // Connect to existing PTY instead of spawning
  /** Lock columns to 80 — only for ship dock terminals where SIGWINCH
   *  col changes cause rich TUI garble. Regular terminals should NOT lock. */
  lockCols?: boolean;
  /** Called after a new PTY is spawned — lets the parent persist the ptyId
   *  so it survives React remounts (layout restructuring). When provided,
   *  the Terminal will NOT kill the PTY on unmount — the store manages it. */
  onPtySpawned?: (ptyId: string) => void;
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

export function Terminal({ cwd, command, initialInput, ptyId: existingPtyId, lockCols: lockColsProp, onPtySpawned }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const unlistenOutputRef = useRef<UnlistenFn | null>(null);
  const unlistenExitRef = useRef<UnlistenFn | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const term = termRef.current;
    const ptyId = ptyIdRef.current;

    showContextMenu(
      [
        {
          label: "Copy",
          accelerator: "CmdOrCtrl+C",
          action: () => {
            if (term) {
              const sel = term.getSelection();
              if (sel) navigator.clipboard.writeText(sel);
            }
          },
        },
        {
          label: "Paste",
          accelerator: "CmdOrCtrl+V",
          action: async () => {
            if (ptyId) {
              const text = await navigator.clipboard.readText();
              if (text) api.writePty(ptyId, Array.from(encoder.encode(text)));
            }
          },
        },
        {
          label: "Select All",
          accelerator: "CmdOrCtrl+A",
          action: () => term?.selectAll(),
        },
        "separator",
        {
          label: "Clear Terminal",
          action: () => term?.clear(),
        },
        {
          label: "Kill Terminal",
          action: () => {
            if (ptyId) api.killPty(ptyId);
          },
        },
      ],
      { x: e.clientX, y: e.clientY },
    );
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerminal({
      cols: 80,
      rows: 24,
      macOptionIsMeta: true,
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

    // Handle Cmd+C (copy), Cmd+V (paste), Cmd+A (select all)
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      const isMeta = ev.metaKey; // Cmd on macOS
      if (!isMeta) return true;

      if (ev.key === "c") {
        const sel = term.getSelection();
        if (sel) {
          navigator.clipboard.writeText(sel);
          return false; // prevent xterm from handling
        }
        // No selection → let it pass through as Ctrl+C (SIGINT)
        return true;
      }
      if (ev.key === "v") {
        navigator.clipboard.readText().then((text) => {
          if (text && ptyIdRef.current) {
            api.writePty(ptyIdRef.current, Array.from(encoder.encode(text)));
          }
        });
        return false;
      }
      if (ev.key === "a") {
        term.selectAll();
        return false;
      }
      return true;
    });

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Track whether this terminal owns the PTY (should kill on unmount)
    const ownsPty = !existingPtyId;
    // Only lock cols when explicitly requested (ship dock terminals).
    // Regular PTY reconnections after layout changes must resize freely.
    const lockCols = !!lockColsProp;
    const LOCKED_COLS = 80; // Must match ship PTY spawn size
    let ptySpawned = false;
    let rafId: number | null = null;

    /** Fit rows to container, keeping cols locked at LOCKED_COLS. */
    function fitRowsOnly(): boolean {
      const dims = fitAddon.proposeDimensions();
      if (!dims || !Number.isFinite(dims.rows)) return false;
      const rows = Math.max(MIN_ROWS, Math.round(dims.rows));
      if (rows === term.rows && term.cols === LOCKED_COLS) return false;
      const core = (term as any)._core;
      if (core?._renderService) core._renderService.clear();
      term.resize(LOCKED_COLS, rows);
      return true;
    }

    async function connectToPty(ptyId: string) {
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
          // When cols are locked (ship dock), always send the locked cols
          // to avoid SIGWINCH-triggered col-change garble
          api.resizePty(ptyIdRef.current, lockCols ? LOCKED_COLS : cols, rows);
        }
      });
    }

    async function attachExistingPty() {
      if (ptySpawned || !existingPtyId) return;
      ptySpawned = true;

      try {
        if (lockCols) {
          fitRowsOnly();
        } else {
          safeFit(term, fitAddon);
        }

        // Replay buffered output from ship session
        if (lockCols) {
          const session = useWorkspaceStore.getState().shipSession;
          if (session && session.ptyId === existingPtyId) {
            for (const chunk of shipOutputBuffer) {
              term.write(chunk);
            }
          }
        }

        await connectToPty(existingPtyId);

        // Sync PTY dimensions — this sends SIGWINCH which makes TUI apps redraw
        if (lockCols) {
          fitRowsOnly();
          if (term.rows >= MIN_ROWS) {
            api.resizePty(existingPtyId, LOCKED_COLS, term.rows);
          }
        } else {
          safeFit(term, fitAddon);
          if (term.cols >= MIN_COLS && term.rows >= MIN_ROWS) {
            api.resizePty(existingPtyId, term.cols, term.rows);
          }
        }
      } catch (e) {
        term.writeln(`\x1b[31mFailed to attach to terminal: ${e}\x1b[0m`);
      }
    }

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

        // Persist ptyId so it survives layout-induced remounts
        onPtySpawned?.(ptyId);

        await connectToPty(ptyId);

        // Send initialInput after a delay to let the command start
        if (initialInput) {
          setTimeout(() => {
            if (ptyIdRef.current) {
              api.writePty(
                ptyIdRef.current,
                Array.from(encoder.encode(initialInput + "\n"))
              );
            }
          }, 1500);
        }

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

    const initFn = existingPtyId ? attachExistingPty : spawnPty;

    const el = containerRef.current;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth < 100 || el.clientHeight < 50) return;

      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!ptySpawned) {
          initFn();
        } else {
          lockCols ? fitRowsOnly() : safeFit(term, fitAddon);
        }
      });
    });
    observer.observe(el);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
      // Kill PTY on unmount ONLY if we own it AND the store isn't managing it.
      // When onPtySpawned is provided, the store persists the ptyId and handles
      // cleanup in closePane/closeGroup — so we must not kill here (the component
      // may just be remounting due to layout restructuring).
      if (ptyIdRef.current && ownsPty && !onPtySpawned) {
        api.killPty(ptyIdRef.current);
      }
      ptyIdRef.current = null;
      unlistenOutputRef.current?.();
      unlistenExitRef.current?.();
      term.dispose();
    };
    // existingPtyId intentionally excluded — it's only used at mount time to
    // decide spawn vs. attach. When onPtySpawned stores a new ptyId, we must
    // NOT tear down the working terminal to re-attach (causes blank terminals
    // because the resize sends same dimensions → zsh doesn't redraw).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, command, initialInput]);

  return (
    <div style={styles.container} onContextMenu={handleContextMenu}>
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
