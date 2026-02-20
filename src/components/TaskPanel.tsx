import React, { useState, useEffect, useRef, useCallback } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { api } from "../lib/tauri";
import type { TaskEntry, TaskRun } from "../lib/types";

interface TaskPanelProps {
  rootPath: string;
  workspaceId: string;
}

export function TaskPanel({ rootPath }: TaskPanelProps) {
  const [tasks, setTasks] = useState<TaskEntry[]>([]);
  const [viewingTask, setViewingTask] = useState<string | null>(null);
  const [popupPos, setPopupPos] = useState({ x: 0, y: 0 });
  const { taskRuns, runTask, stopTask } = useWorkspaceStore();

  useEffect(() => {
    api.listTasks(rootPath).then(setTasks).catch(() => setTasks([]));
    api.syncClaudeCommands(rootPath).catch(() => {});
  }, [rootPath]);

  if (tasks.length === 0) return null;

  function handleRowClick(e: React.MouseEvent, key: string) {
    if (!taskRuns[key]) return;
    setPopupPos({ x: e.clientX, y: e.clientY });
    setViewingTask(key);
  }

  return (
    <>
      <div style={styles.separator} />
      {tasks.map((task) => {
        const key = `${rootPath}:${task.name}`;
        const run = taskRuns[key];
        const isRunning = run?.status === "running";

        return (
          <div
            key={task.name}
            style={styles.row}
            onClick={(e) => handleRowClick(e, key)}
          >
            <StatusDot status={run?.status ?? null} />
            <span style={styles.label}>{task.label}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                isRunning ? stopTask(rootPath, task.name) : runTask(rootPath, task.name, task.command, task.cwd);
              }}
              style={styles.actionBtn}
            >
              {isRunning ? <StopIcon /> : <PlayIcon />}
            </button>
          </div>
        );
      })}

      {viewingTask && taskRuns[viewingTask] && (
        <FloatingTerminal
          key={viewingTask}
          run={taskRuns[viewingTask]}
          anchorX={popupPos.x}
          anchorY={popupPos.y}
          onClose={() => setViewingTask(null)}
        />
      )}
    </>
  );
}

// --- Icons ---

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

function StatusDot({ status }: { status: string | null }) {
  if (!status) return <span style={{ ...styles.dot, background: "#444" }} />;
  const colors: Record<string, string> = {
    running: "#e8b930",
    success: "#4caf50",
    error: "#e06c75",
    stopped: "#888",
  };
  return (
    <span
      style={{ ...styles.dot, background: colors[status] || "#444" }}
      className={status === "running" ? "pulse-dot" : undefined}
    />
  );
}

// --- Floating Terminal Popup ---

function FloatingTerminal({
  run,
  anchorX,
  anchorY,
  onClose,
}: {
  run: TaskRun;
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
    // Delay to avoid the opening click immediately closing
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

    for (const chunk of run.output) {
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

    let lastLen = run.output.length;
    const interval = setInterval(() => {
      if (run.output.length > lastLen) {
        for (let i = lastLen; i < run.output.length; i++) {
          termRef.current?.write(run.output[i]);
        }
        lastLen = run.output.length;
      }
    }, 100);

    return () => clearInterval(interval);
  }, [run.status]);

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
      {/* Titlebar — X on left */}
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
          {run.taskName}
        </span>
      </div>
      {/* Terminal */}
      <div ref={containerRef} style={{ height: 300, overflow: "hidden" }} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  separator: {
    height: 1,
    background: "#333",
    margin: "4px 0 2px",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "3px 8px",
    cursor: "default",
    fontSize: 12,
  },
  label: {
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    fontWeight: 600,
    color: "#ccc",
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
  dot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    flexShrink: 0,
  },
};
