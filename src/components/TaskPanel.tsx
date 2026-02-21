import React, { useState, useEffect, useRef, useCallback } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useWorkspaceStore, scriptOutputBuffers } from "../stores/workspaceStore";
import { api } from "../lib/tauri";
import type { ScriptEntry, ScriptRun } from "../lib/types";
import { CLAUDE_PATH, TerminalPromptIcon } from "./FileIcons";

interface TaskPanelProps {
  rootPath: string;
  workspaceId: string;
}

export function TaskPanel({ rootPath, workspaceId }: TaskPanelProps) {
  const [entries, setEntries] = useState<ScriptEntry[]>([]);
  const [viewingScript, setViewingScript] = useState<string | null>(null);
  const [popupPos, setPopupPos] = useState({ x: 0, y: 0 });
  const scriptRuns = useWorkspaceStore((s) => s.scriptRuns);
  const runScript = useWorkspaceStore((s) => s.runScript);
  const stopScript = useWorkspaceStore((s) => s.stopScript);
  const openClaudeCommand = useWorkspaceStore((s) => s.openClaudeCommand);
  const openFile = useWorkspaceStore((s) => s.openFile);
  const startShipSession = useWorkspaceStore((s) => s.startShipSession);

  useEffect(() => {
    api.listScripts(rootPath).then(setEntries).catch(() => setEntries([]));
  }, [rootPath]);

  const commands = entries.filter((e) => e.command.startsWith("claude:"));
  const scripts = entries.filter((e) => !e.command.startsWith("claude:"));

  if (entries.length === 0) return null;

  function openScriptFile(entry: ScriptEntry) {
    if (!workspaceId || !entry.file_path) return;
    openFile(workspaceId, entry.file_path);
  }

  function showScriptOutput(e: React.MouseEvent, key: string) {
    if (!scriptRuns[key]) return;
    setPopupPos({ x: e.clientX, y: e.clientY });
    setViewingScript(key);
  }

  function renderRow(entry: ScriptEntry) {
    const key = `${rootPath}:${entry.name}`;
    const run = scriptRuns[key];
    const isRunning = run?.status === "running";
    const status = run?.status ?? null;
    const isClaudeCommand = entry.command.startsWith("claude:");

    return (
      <div
        key={entry.name}
        className="file-node"
        style={styles.row}
        onClick={(e) => {
          if ((e.metaKey || e.ctrlKey) && scriptRuns[key]) {
            showScriptOutput(e, key);
            return;
          }
          if (isClaudeCommand) {
            openScriptFile(entry);
          } else {
            openScriptFile(entry);
          }
        }}
      >
        {isClaudeCommand ? <CommandIcon /> : <TerminalPromptIcon size={14} color="#5b9e6f" />}
        <span
          style={{ ...styles.label, cursor: "pointer" }}
          onClick={(e) => {
            e.stopPropagation();
            openScriptFile(entry);
          }}
          title={entry.file_path ?? entry.command}
        >
          {isClaudeCommand ? entry.label.replace(/^\//, "") : entry.label}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (isClaudeCommand) {
              const slashCommand = entry.command.replace("claude:", "");
              if (slashCommand === "/ship") {
                startShipSession(rootPath);
              } else {
                openClaudeCommand(workspaceId, rootPath, slashCommand, entry.label);
              }
            } else if (isRunning) {
              stopScript(rootPath, entry.name);
            } else {
              runScript(rootPath, entry.name, entry.command);
            }
          }}
          style={styles.actionBtn}
        >
          {status === "running" ? (
            <StopIcon />
          ) : status === "success" ? (
            <SuccessIcon />
          ) : status === "error" ? (
            <ErrorIcon />
          ) : (
            <PlayIcon />
          )}
        </button>
      </div>
    );
  }

  return (
    <>
      {entries.length > 0 && (
        <>
          <div style={styles.divider} />
          {commands.map(renderRow)}
          {scripts.map(renderRow)}
        </>
      )}

      {viewingScript && scriptRuns[viewingScript] && (
        <FloatingTerminal
          key={viewingScript}
          run={scriptRuns[viewingScript]}
          bufferKey={viewingScript}
          anchorX={popupPos.x}
          anchorY={popupPos.y}
          onClose={() => setViewingScript(null)}
        />
      )}
    </>
  );
}

// --- Icons ---

function CommandIcon() {
  return (
    <svg width="14" height="14" viewBox="-2 -1 28 26" style={{ flexShrink: 0 }}>
      <path d={CLAUDE_PATH} fill="#D97757" fillRule="nonzero" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
      <path d="M2 1l7 4-7 4V1z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="#e06c75">
      <rect x="1" y="1" width="8" height="8" rx="1" />
    </svg>
  );
}

function SuccessIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M2 5.5L4 7.5L8 3" stroke="#4caf50" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5" stroke="#e06c75" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// --- Floating Terminal Popup ---

function FloatingTerminal({
  run,
  bufferKey,
  anchorX,
  anchorY,
  onClose,
}: {
  run: ScriptRun;
  bufferKey: string;
  anchorX: number;
  anchorY: number;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: anchorX, y: anchorY });
  const dragging = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClick);
    }, 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose]);

  // Initialize xterm and replay buffered output
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerminal({
      cols: 100,
      rows: 20,
      theme: {
        background: "#1a1a1a",
        foreground: "#e0e0e0",
        cursor: "#a0a0a0",
      },
      fontSize: 12,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
      disableStdin: true,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    termRef.current = term;

    // Replay buffered output from module-level buffer
    const buf = scriptOutputBuffers.get(bufferKey) ?? [];
    for (const chunk of buf) {
      term.write(chunk);
    }

    if (run.status !== "running") {
      term.writeln(
        `\r\n\x1b[90m[Process exited${run.exitCode != null ? ` with code ${run.exitCode}` : ""}]\x1b[0m`
      );
    }

    try { fitAddon.fit(); } catch { /* ignore */ }

    return () => term.dispose();
  }, []);

  // Stream new output if still running
  useEffect(() => {
    if (!termRef.current || run.status !== "running") return;

    const buf = scriptOutputBuffers.get(bufferKey);
    let lastLen = buf?.length ?? 0;
    const interval = setInterval(() => {
      const currentBuf = scriptOutputBuffers.get(bufferKey);
      if (currentBuf && currentBuf.length > lastLen) {
        for (let i = lastLen; i < currentBuf.length; i++) {
          termRef.current?.write(currentBuf[i]);
        }
        lastLen = currentBuf.length;
      }
    }, 100);

    return () => clearInterval(interval);
  }, [run.status, bufferKey]);

  // Dragging
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    dragging.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      setPos({
        x: dragging.current.origX + (ev.clientX - dragging.current.startX),
        y: dragging.current.origY + (ev.clientY - dragging.current.startY),
      });
    };
    const onUp = () => {
      dragging.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [pos]);

  return (
    <div
      ref={panelRef}
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        width: 700,
        zIndex: 2000,
        background: "#1a1a1a",
        border: "1px solid #444",
        borderRadius: 8,
        boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        onMouseDown={handleDragStart}
        style={{
          display: "flex",
          alignItems: "center",
          padding: "4px 10px",
          background: "#252525",
          cursor: "default",
          userSelect: "none",
          borderBottom: "1px solid #333",
          gap: 8,
        }}
      >
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "#666",
            cursor: "default",
            fontSize: 13,
            padding: "0 2px",
            lineHeight: 1,
          }}
        >
          ✕
        </button>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#999" }}>
          {run.scriptName}
        </span>
      </div>
      <div ref={containerRef} style={{ height: 300, overflow: "hidden" }} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  divider: {
    height: 3,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "3px 8px 3px 12px",
    cursor: "pointer",
    fontSize: 12,
  },
  label: {
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    fontWeight: 600,
    color: "#ddd",
  },
  actionBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 20,
    height: 20,
    background: "none",
    border: "none",
    color: "#888",
    cursor: "pointer",
    padding: 0,
    borderRadius: 3,
    flexShrink: 0,
  },
};
