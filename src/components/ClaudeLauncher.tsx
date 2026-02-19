import React from "react";

interface ClaudeLauncherProps {
  workspacePath: string;
  onLaunch: () => void;
}

export function ClaudeLauncher({ workspacePath, onLaunch }: ClaudeLauncherProps) {
  return (
    <div style={styles.container}>
      <div style={styles.content}>
        <button style={styles.button} onClick={onLaunch}>
          Start Claude Code
        </button>
        <div style={styles.path}>{workspacePath}</div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#1a1a1a",
    minHeight: 0,
    minWidth: 0,
  },
  content: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 10,
  },
  button: {
    padding: "10px 24px",
    fontSize: 13,
    fontWeight: 600,
    color: "#fff",
    background: "#333",
    border: "1px solid #444",
    borderRadius: 6,
    cursor: "pointer",
    letterSpacing: "0.01em",
    transition: "background 0.15s, border-color 0.15s",
  },
  path: {
    fontSize: 11,
    color: "#555",
    fontFamily: "'SF Mono', monospace",
  },
};
