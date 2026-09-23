import React, { useState, useEffect, useRef } from "react";
import { Terminal } from "./Terminal";
import type { OnFileOpen } from "../lib/terminalLinkProvider";
import { LoadingDots } from "./LoadingDots";

interface ClaudeTerminalWrapperProps {
  cwd: string;
  command?: string;
  initialInput?: string;
  ptyId?: string;
  workspaceId?: string;
  onPtySpawned?: (ptyId: string) => void;
  onCwdChanged?: (cwd: string) => void;
  onFileOpen?: OnFileOpen;
}

const MIN_OVERLAY_MS = 1500;
const MAX_OVERLAY_MS = 5000;

export function ClaudeTerminalWrapper({ cwd, command, initialInput, ptyId, workspaceId, onPtySpawned, onCwdChanged, onFileOpen }: ClaudeTerminalWrapperProps) {
  const [ready, setReady] = useState(!!ptyId);
  const containerRef = useRef<HTMLDivElement>(null);
  const ptyArrivedRef = useRef(!!ptyId);
  const minElapsedRef = useRef(!!ptyId);

  // Track when ptyId arrives
  useEffect(() => {
    if (ptyId) ptyArrivedRef.current = true;
  }, [ptyId]);

  // Minimum overlay duration — always show at least MIN_OVERLAY_MS
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => {
      minElapsedRef.current = true;
      if (ptyArrivedRef.current) setReady(true);
    }, MIN_OVERLAY_MS);
    return () => clearTimeout(timer);
  }, [ready]);

  // When ptyId arrives after min elapsed, dismiss overlay
  useEffect(() => {
    if (ready || !ptyId) return;
    if (minElapsedRef.current) {
      setReady(true);
    }
  }, [ptyId, ready]);

  // Max overlay fallback — dismiss after MAX_OVERLAY_MS regardless
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setReady(true), MAX_OVERLAY_MS);
    return () => clearTimeout(timer);
  }, [ready]);

  // Focus the terminal when overlay disappears
  useEffect(() => {
    if (!ready || !containerRef.current) return;
    const textarea = containerRef.current.querySelector("textarea.xterm-helper-textarea") as HTMLTextAreaElement | null;
    if (textarea) textarea.focus();
  }, [ready]);

  const cleanCommand = command && !ptyId ? `clear && ${command}` : command;

  return (
    <div ref={containerRef} style={styles.container}>
      <Terminal cwd={cwd} command={cleanCommand} exitOnComplete initialInput={initialInput} ptyId={ptyId} workspaceId={workspaceId} onPtySpawned={onPtySpawned} onCwdChanged={onCwdChanged} onFileOpen={onFileOpen} />
      {!ready && (
        <div style={styles.overlay}>
          <div style={styles.content}>
            <LoadingDots />
            <div style={styles.text}>Starting Claude Code</div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: "relative",
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    minHeight: 0,
  },
  overlay: {
    position: "absolute",
    inset: 0,
    background: "var(--terminal-bg)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
    /* No fade-in — overlay must be opaque immediately to hide the
       shell command that briefly appears before `clear` runs. */
  },
  content: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 16,
  },
  text: {
    fontSize: 13,
    color: "var(--text-dim)",
    fontWeight: 500,
    letterSpacing: "0.02em",
  },
};
