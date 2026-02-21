import React, { useState, useEffect, useRef } from "react";
import { Terminal } from "./Terminal";

interface ClaudeTerminalWrapperProps {
  cwd: string;
  command?: string;
  initialInput?: string;
  ptyId?: string;
}

export function ClaudeTerminalWrapper({ cwd, command, initialInput, ptyId }: ClaudeTerminalWrapperProps) {
  const [ready, setReady] = useState(!!ptyId);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ptyId) return;
    const timer = setTimeout(() => setReady(true), 2500);
    return () => clearTimeout(timer);
  }, [ptyId]);

  // Focus the terminal when overlay disappears
  useEffect(() => {
    if (!ready || !containerRef.current) return;
    const textarea = containerRef.current.querySelector("textarea.xterm-helper-textarea") as HTMLTextAreaElement | null;
    if (textarea) textarea.focus();
  }, [ready]);

  const cleanCommand = command && !ptyId ? `clear && ${command}` : command;

  return (
    <div ref={containerRef} style={styles.container}>
      <Terminal cwd={cwd} command={cleanCommand} initialInput={initialInput} ptyId={ptyId} />
      {!ready && (
        <div style={styles.overlay}>
          <div style={styles.content}>
            <div style={styles.dots}>
              <span style={{ ...styles.dot, animationDelay: "0s" }} />
              <span style={{ ...styles.dot, animationDelay: "0.2s" }} />
              <span style={{ ...styles.dot, animationDelay: "0.4s" }} />
            </div>
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
    background: "#1a1a1a",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
    animation: "claude-fade-in 0.3s ease-out",
  },
  content: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 16,
  },
  dots: {
    display: "flex",
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: "#e8b930",
    animation: "claude-dot 1.4s ease-in-out infinite",
  },
  text: {
    fontSize: 13,
    color: "#555",
    fontWeight: 500,
    letterSpacing: "0.02em",
  },
};
