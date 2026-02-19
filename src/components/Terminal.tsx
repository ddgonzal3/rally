import React, { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../lib/tauri";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  title: string;
  cwd: string;
  command?: string;
  onClose?: () => void;
}

const encoder = new TextEncoder();

export function Terminal({ title, cwd, command, onClose }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const unlistenOutputRef = useRef<UnlistenFn | null>(null);
  const unlistenExitRef = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerminal({
      theme: {
        background: "#1a1a1a",
        foreground: "#e0e0e0",
        cursor: "#7c6ef5",
        selectionBackground: "#7c6ef544",
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
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Spawn PTY and wire up I/O
    (async () => {
      try {
        const cols = term.cols;
        const rows = term.rows;
        const ptyId = await api.spawnPty(cwd, command ?? null, cols, rows);
        ptyIdRef.current = ptyId;

        // Listen for PTY output
        unlistenOutputRef.current = await listen<{ data: number[] }>(
          `pty-output-${ptyId}`,
          (event) => {
            term.write(new Uint8Array(event.payload.data));
          }
        );

        // Listen for PTY exit
        unlistenExitRef.current = await listen<{ code: number | null }>(
          `pty-exit-${ptyId}`,
          (event) => {
            const code = event.payload.code;
            term.writeln(
              `\r\n\x1b[90m[Process exited${code != null ? ` with code ${code}` : ""}]\x1b[0m`
            );
          }
        );

        // Forward keystrokes to PTY
        term.onData((data) => {
          if (ptyIdRef.current) {
            api.writePty(
              ptyIdRef.current,
              Array.from(encoder.encode(data))
            );
          }
        });

        // Forward resize to PTY
        term.onResize(({ cols, rows }) => {
          if (ptyIdRef.current) {
            api.resizePty(ptyIdRef.current, cols, rows);
          }
        });
      } catch (e) {
        term.writeln(`\x1b[31mFailed to start terminal: ${e}\x1b[0m`);
      }
    })();

    // Handle container resize
    const observer = new ResizeObserver(() => {
      fitAddon.fit();
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      // Clean up PTY
      if (ptyIdRef.current) {
        api.killPty(ptyIdRef.current);
        ptyIdRef.current = null;
      }
      // Unlisten events
      unlistenOutputRef.current?.();
      unlistenExitRef.current?.();
      // Dispose terminal
      term.dispose();
    };
  }, [cwd, command]);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.headerTitle}>{title}</span>
        <div style={styles.headerActions}>
          {onClose && (
            <button style={styles.headerBtn} title="Close" onClick={onClose}>
              x
            </button>
          )}
        </div>
      </div>
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
    border: "1px solid #333",
    borderRadius: 6,
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "4px 10px",
    background: "#252525",
    borderBottom: "1px solid #333",
    minHeight: 28,
  },
  headerTitle: {
    fontSize: 11,
    fontWeight: 500,
    color: "#999",
  },
  headerActions: {
    display: "flex",
    gap: 4,
  },
  headerBtn: {
    background: "none",
    border: "none",
    color: "#666",
    cursor: "pointer",
    fontSize: 14,
    padding: "0 4px",
    lineHeight: 1,
  },
  terminal: {
    flex: 1,
    padding: 4,
  },
};
