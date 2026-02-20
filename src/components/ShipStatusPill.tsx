import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore, shipOutputBuffer } from "../stores/workspaceStore";
import { api } from "../lib/tauri";
import type { ShipDetailPhase, ShipSession } from "../lib/types";

const encoder = new TextEncoder();

const PHASE_LABELS: Record<ShipDetailPhase, string> = {
  detecting: "Detecting state...",
  committing: "Committing changes...",
  pushing: "Pushing to remote...",
  creating_pr: "Creating PR...",
  checking: "Checking PR status...",
  reviewing: "Reviewing code...",
  writing_verdict: "Writing verdict...",
  finishing: "Finishing up...",
  complete: "Ship complete",
};

function openUrl(url: string) {
  invoke("plugin:shell|open", { path: url }).catch(() => {
    window.open(url, "_blank");
  });
}

/** Derive display state from the session + live PR status */
function getDisplayState(session: ShipSession, livePrUrl: string | null) {
  const hasSignal = !!session.signal;
  const isManualReview = hasSignal && session.signal!.verdict === "manual_review";
  const isAutoMerge = hasSignal && session.signal!.verdict === "auto_merge";
  const hasError = session.exited && session.exitCode !== null && session.exitCode !== 0;
  const isFinishing = session.exited && !hasSignal && !hasError;

  if (isManualReview) {
    return {
      title: `Review Needed — PR #${session.signal!.pr_number}`,
      subtitle: session.signal!.summary || "Manual review required",
      extra: session.signal!.flagged_items?.length
        ? `${session.signal!.flagged_items.length} flagged item${session.signal!.flagged_items.length !== 1 ? "s" : ""}`
        : null,
      accentColor: "#f59e0b",
      titleColor: "#e8b930",
      prUrl: session.signal!.pr_url,
    };
  }
  if (isAutoMerge) {
    return {
      title: `Merging PR #${session.signal!.pr_number}`,
      subtitle: session.signal!.summary || "Auto-merging approved PR",
      extra: null,
      accentColor: "#22c55e",
      titleColor: "#7ddf7d",
      prUrl: session.signal!.pr_url,
    };
  }
  if (hasError) {
    return {
      title: "Ship Failed",
      subtitle: `Process exited with code ${session.exitCode}`,
      extra: null,
      accentColor: "#e06c75",
      titleColor: "#e06c75",
      prUrl: livePrUrl,
    };
  }
  if (isFinishing) {
    return {
      title: "Shipping",
      subtitle: PHASE_LABELS.finishing,
      extra: null,
      accentColor: "#3b82f6",
      titleColor: "#7db8df",
      prUrl: livePrUrl,
    };
  }
  // In progress
  return {
    title: "Shipping",
    subtitle: PHASE_LABELS[session.phase],
    extra: null,
    accentColor: "#3b82f6",
    titleColor: "#7db8df",
    prUrl: livePrUrl,
  };
}

export function ShipStatusPill() {
  const session = useWorkspaceStore((s) => s.shipSession);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const prStatuses = useWorkspaceStore((s) => s.prStatuses);
  const dismissShipSession = useWorkspaceStore((s) => s.dismissShipSession);
  const dockShipSession = useWorkspaceStore((s) => s.dockShipSession);
  const [expanded, setExpanded] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside click when expanded
  useEffect(() => {
    if (!expanded) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClick);
    }, 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [expanded]);

  if (!session) return null;

  const repoName = session.repoPath.split("/").pop() ?? "repo";
  // Get live PR URL from PR status polling (available before signal arrives)
  const livePr = prStatuses[session.repoPath];
  const livePrUrl = livePr?.state === "OPEN" ? livePr.url : null;
  const display = getDisplayState(session, livePrUrl);

  return (
    <div ref={panelRef} style={{
      ...styles.container,
      ...(expanded ? { width: 720, maxWidth: 720 } : {}),
    }}>
      {/* Toolbar — only when expanded */}
      {expanded && (
        <div style={styles.toolbar}>
          <span style={styles.toolbarTitle}>Ship: {repoName}</span>
          <div style={{ flex: 1 }} />
          <button
            style={styles.dockBtn}
            onClick={() => {
              if (activeWorkspaceId) {
                dockShipSession(activeWorkspaceId);
                setExpanded(false);
              }
            }}
            title="Dock to layout"
          >
            Dock ↗
          </button>
          <button style={styles.collapseBtn} onClick={() => setExpanded(false)}>✕</button>
        </div>
      )}

      {/* Terminal — always mounted, visibility toggled. This avoids buffer
          replay garble by keeping the xterm live from session start. */}
      <ShipTerminalView session={session} visible={expanded} />

      {/* Status footer — always visible */}
      <div
        style={{
          ...styles.footer,
          borderTop: expanded ? "1px solid #333" : "none",
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <div style={{ ...styles.accent, background: display.accentColor }} />
        <div style={styles.footerContent}>
          <div style={styles.footerHeader}>
            <span style={{ ...styles.title, color: display.titleColor }}>
              {display.title}
            </span>
            <button
              style={styles.dismiss}
              onClick={(e) => {
                e.stopPropagation();
                dismissShipSession();
              }}
              title="Dismiss"
            >
              ×
            </button>
          </div>
          <div style={styles.subtitle}>{display.subtitle}</div>
          {display.extra && <div style={styles.extra}>{display.extra}</div>}
          {display.prUrl && (
            <div style={styles.actions}>
              <button
                style={styles.actionBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  openUrl(display.prUrl!);
                }}
              >
                View PR
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: "fixed",
    bottom: 12,
    left: 12,
    zIndex: 1001,
    minWidth: 280,
    maxWidth: 360,
    background: "#2a2a2a",
    borderRadius: 6,
    boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    transition: "width 0.2s ease, max-width 0.2s ease",
  },
  // --- Toolbar (expanded only) ---
  toolbar: {
    display: "flex",
    alignItems: "center",
    padding: "5px 10px",
    background: "#252525",
    borderBottom: "1px solid #333",
    gap: 8,
    flexShrink: 0,
  },
  toolbarTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: "#999",
  },
  dockBtn: {
    background: "#333",
    border: "1px solid #444",
    color: "#ccc",
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 4,
    cursor: "pointer",
  },
  collapseBtn: {
    background: "none",
    border: "none",
    color: "#666",
    cursor: "pointer",
    fontSize: 13,
    padding: "0 4px",
    lineHeight: "1",
  },
  // --- Status footer (always visible) ---
  footer: {
    display: "flex",
    cursor: "pointer",
    userSelect: "none" as const,
    flexShrink: 0,
  },
  accent: {
    width: 3,
    flexShrink: 0,
  },
  footerContent: {
    flex: 1,
    padding: "8px 12px",
  },
  footerHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 8,
  },
  title: {
    fontSize: 12,
    fontWeight: 600,
    lineHeight: "1.3",
  },
  subtitle: {
    fontSize: 11,
    color: "#999",
    marginTop: 3,
    lineHeight: "1.4",
  },
  extra: {
    fontSize: 10,
    color: "#777",
    marginTop: 2,
  },
  actions: {
    display: "flex",
    gap: 6,
    marginTop: 6,
  },
  actionBtn: {
    background: "#3a3a3a",
    border: "1px solid #4a4a4a",
    color: "#ccc",
    fontSize: 11,
    padding: "3px 10px",
    borderRadius: 4,
    cursor: "pointer",
  },
  dismiss: {
    background: "none",
    border: "none",
    color: "#888",
    cursor: "pointer",
    fontSize: 16,
    padding: "0 2px",
    lineHeight: "1",
    flexShrink: 0,
  },
};

// --- Terminal View (rendered inside the expanded container) ---

function ShipTerminalView({
  session,
  visible,
}: {
  session: NonNullable<ReturnType<typeof useWorkspaceStore.getState>["shipSession"]>;
  visible: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const [termHeight, setTermHeight] = useState(420);

  // The xterm stays alive for the entire session, processing output
  // incrementally from the store buffer — even when the overlay is
  // collapsed (offscreen). Key design decisions:
  //
  // 1. Raw bytes only: the store buffers raw PTY bytes. We write them
  //    directly to xterm — no TextDecoder/TextEncoder round-trip, which
  //    corrupts multi-byte UTF-8 chars split across read boundaries.
  //
  // 2. Cols locked at 80: matches the PTY spawn width. Rows are fitted
  //    to the container and the PTY is resized to match, so both stay
  //    in sync (prevents cursor positioning garble).
  //
  // 3. Incremental processing: chunks are polled from the store buffer
  //    (which has everything from byte one) rather than replayed in bulk.
  useEffect(() => {
    if (!containerRef.current) return;

    const PTY_COLS = 80;

    const term = new XTerminal({
      cols: PTY_COLS,
      rows: 24,
      theme: {
        background: "#1e1e1e",
        foreground: "#e0e0e0",
        cursor: "#a0a0a0",
        selectionBackground: "#44444488",
        black: "#1e1e1e",
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
      scrollback: 10000,
      cursorBlink: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    termRef.current = term;

    // Fit rows to container height, keeping cols locked at PTY_COLS.
    // Resize the PTY to match so dimensions stay in sync.
    const dims = fitAddon.proposeDimensions();
    if (dims && Number.isFinite(dims.rows)) {
      const rows = Math.max(4, Math.round(dims.rows));
      if (rows !== term.rows) {
        term.resize(PTY_COLS, rows);
        const cur = useWorkspaceStore.getState().shipSession;
        if (cur && !cur.exited) {
          api.resizePty(cur.ptyId, PTY_COLS, rows);
        }
      }
    }

    // Set container height to match xterm's actual rendered size (no gap)
    const xtermScreen = containerRef.current.querySelector('.xterm-screen') as HTMLElement;
    if (xtermScreen) {
      setTermHeight(xtermScreen.offsetHeight + 8); // +8 for padding
    }

    // Write raw bytes to xterm — identical to how panel terminals work.
    // No TextDecoder, no regex stripping, no string conversion.
    // Phase markers will appear as text but this tests whether the
    // text processing pipeline was causing the garble.
    let lastLen = 0;
    let exitWritten = false;

    const poll = setInterval(() => {
      const cur = useWorkspaceStore.getState().shipSession;
      if (!cur || cur.ptyId !== session.ptyId) {
        clearInterval(poll);
        return;
      }
      // Read from module-level buffer (not Zustand state) to avoid
      // triggering React re-renders
      if (shipOutputBuffer.length > lastLen) {
        for (let i = lastLen; i < shipOutputBuffer.length; i++) {
          term.write(shipOutputBuffer[i]);
        }
        lastLen = shipOutputBuffer.length;
      }
      if (cur.exited && !exitWritten) {
        exitWritten = true;
        term.writeln(
          `\r\n\x1b[90m[Process exited${cur.exitCode != null ? ` with code ${cur.exitCode}` : ""}]\x1b[0m`
        );
      }
    }, 50);

    // Forward keystrokes to the PTY
    term.onData((data) => {
      const current = useWorkspaceStore.getState().shipSession;
      if (current && !current.exited) {
        api.writePty(current.ptyId, Array.from(encoder.encode(data)));
      }
    });

    return () => {
      clearInterval(poll);
      term.dispose();
      termRef.current = null;
    };
  }, [session.ptyId]);

  // Force repaint when becoming visible — the canvas wasn't painted while
  // offscreen, so the display would be blank without this.
  useLayoutEffect(() => {
    if (!visible || !termRef.current) return;
    termRef.current.refresh(0, termRef.current.rows - 1);
    termRef.current.scrollToBottom();
  }, [visible]);

  return (
    <div
      ref={containerRef}
      style={{
        width: 712,
        height: termHeight,
        overflow: "hidden",
        padding: 4,
        background: "#1e1e1e",
        ...(visible ? {} : {
          position: "fixed" as const,
          left: -9999,
          top: -9999,
          visibility: "hidden" as const,
        }),
      }}
    />
  );
}
