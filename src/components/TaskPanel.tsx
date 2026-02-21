import React, { useState, useEffect, useRef, useCallback } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useWorkspaceStore, scriptOutputBuffers } from "../stores/workspaceStore";
import { api } from "../lib/tauri";
import type { ScriptEntry, ScriptRun } from "../lib/types";
import { CLAUDE_PATH, TerminalPromptIcon } from "./FileIcons";
import { showContextMenu } from "../lib/contextMenu";

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
  const openScriptTerminal = useWorkspaceStore((s) => s.openScriptTerminal);

  // Poll to pick up build status changes from module-level buffers
  const [, setTick] = useState(0);
  const hasRunningWatchers = Object.entries(scriptRuns).some(
    ([k, r]) => k.startsWith(rootPath + ":") && r.status === "running" && isWatcherScript(r.scriptName)
  );
  useEffect(() => {
    if (!hasRunningWatchers) return;
    const id = setInterval(() => setTick((t) => t + 1), 1500);
    return () => clearInterval(id);
  }, [hasRunningWatchers]);

  useEffect(() => {
    api.listScripts(rootPath).then(setEntries).catch(() => setEntries([]));
  }, [rootPath]);

  const commands = entries.filter((e) => e.command.startsWith("claude:"));
  const scripts = entries.filter((e) => !e.command.startsWith("claude:"));

  const [renamingEntry, setRenamingEntry] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<string | null>(null);

  const refreshEntries = useCallback(() => {
    api.listScripts(rootPath).then(setEntries).catch(() => setEntries([]));
  }, [rootPath]);

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

  function handleEntryContextMenu(e: React.MouseEvent, entry: ScriptEntry) {
    e.preventDefault();
    e.stopPropagation();
    if (!entry.file_path) return;
    const isLocal = !entry.builtin;
    const actions: Parameters<typeof showContextMenu>[0] = [
      { label: "Reveal in Finder", action: () => api.revealInFinder(entry.file_path!) },
    ];
    if (isLocal) {
      actions.push("separator");
      actions.push({ label: "Rename", action: () => setRenamingEntry(entry.name) });
    }
    showContextMenu(actions);
  }

  function renderRow(entry: ScriptEntry) {
    const key = `${rootPath}:${entry.name}`;
    const run = scriptRuns[key];
    const isRunning = run?.status === "running";
    const status = run?.status ?? null;
    const isClaudeCommand = entry.command.startsWith("claude:");
    const isWatcher = !isClaudeCommand && isWatcherScript(entry.name);

    const isRenaming = renamingEntry === entry.name;
    const isEntrySelected = selectedEntry === entry.name;

    if (isWatcher) {
      const buildStatus = isRunning ? getWatcherBuildStatus(key) : "idle";
      return (
        <div
          key={entry.name}
          className={`file-node${isEntrySelected ? " file-node-active" : ""}`}
          style={styles.row}
          tabIndex={0}
          onClick={() => { setSelectedEntry(entry.name); }}
          onDoubleClick={() => openScriptFile(entry)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && isEntrySelected && !entry.builtin) {
              e.preventDefault();
              setRenamingEntry(entry.name);
            }
          }}
          onContextMenu={(e) => handleEntryContextMenu(e, entry)}
        >
          {isRunning ? <EyeOpenIcon /> : <EyeClosedIcon />}
          {isRenaming ? (
            <RenameInput
              defaultValue={entry.name}
              onCommit={async (newName) => {
                if (entry.file_path) {
                  const dir = entry.file_path.substring(0, entry.file_path.lastIndexOf("/"));
                  await api.renameFile(entry.file_path, dir + "/" + newName);
                  refreshEntries();
                }
                setRenamingEntry(null);
              }}
              onCancel={() => setRenamingEntry(null)}
            />
          ) : (
            <span
              style={{ ...styles.label, cursor: "pointer" }}
              title={entry.file_path ?? entry.command}
            >
              {entry.label}
            </span>
          )}
          {isRunning && <BuildStatusDot status={buildStatus} />}
          {isRunning && (
            <button
              className="tab-action"
              onClick={(e) => { e.stopPropagation(); openScriptTerminal(workspaceId, rootPath, entry.name); }}
              style={styles.actionBtn}
              title="View terminal"
            >
              <TerminalIcon />
            </button>
          )}
          <button
            className={!isRunning ? "script-play-btn" : undefined}
            onClick={(e) => {
              e.stopPropagation();
              if (isRunning) {
                stopScript(rootPath, entry.name);
              } else {
                runScript(rootPath, entry.name, entry.command);
              }
            }}
            style={styles.actionBtn}
          >
            {isRunning ? <StopIcon /> : <PlayIcon />}
          </button>
        </div>
      );
    }

    return (
      <div
        key={entry.name}
        className={`file-node${isEntrySelected ? " file-node-active" : ""}`}
        style={styles.row}
        tabIndex={0}
        onClick={(e) => {
          if ((e.metaKey || e.ctrlKey) && scriptRuns[key]) {
            showScriptOutput(e, key);
            return;
          }
          setSelectedEntry(entry.name);
        }}
        onDoubleClick={() => openScriptFile(entry)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && isEntrySelected && !entry.builtin) {
            e.preventDefault();
            setRenamingEntry(entry.name);
          }
        }}
        onContextMenu={(e) => handleEntryContextMenu(e, entry)}
      >
        {isClaudeCommand ? <CommandIcon /> : <TerminalPromptIcon size={14} color="#5b9e6f" />}
        {isRenaming ? (
          <RenameInput
            defaultValue={entry.name}
            onCommit={async (newName) => {
              if (entry.file_path) {
                const dir = entry.file_path.substring(0, entry.file_path.lastIndexOf("/"));
                await api.renameFile(entry.file_path, dir + "/" + newName);
                refreshEntries();
              }
              setRenamingEntry(null);
            }}
            onCancel={() => setRenamingEntry(null)}
          />
        ) : (
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
        )}
        <button
          className={!status ? "script-play-btn" : undefined}
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

// --- Watcher detection & status ---

function isWatcherScript(name: string): boolean {
  return name.toLowerCase().includes("watch");
}

type WatcherBuildStatus = "idle" | "building" | "success" | "error";

const ERROR_PATTERNS = /\b(error|failed|failure|ERR!|ERROR)\b/i;
const SUCCESS_PATTERNS = /\b(built in|compiled successfully|ready in|watching for file changes|successfully compiled|ready|complete)\b/i;
const BUILDING_PATTERNS = /\b(rebuilding|compiling|bundling|transforming)\b/i;

/**
 * Cached watcher build status — updated incrementally as new output arrives.
 * Avoids re-decoding the entire buffer on every render.
 */
const watcherStatusCache = new Map<string, { status: WatcherBuildStatus; chunkCount: number }>();

function getWatcherBuildStatus(bufferKey: string): WatcherBuildStatus {
  const buf = scriptOutputBuffers.get(bufferKey);
  // Just started, no output yet → must be building
  if (!buf || buf.length === 0) return "building";

  const cached = watcherStatusCache.get(bufferKey);
  if (cached && cached.chunkCount === buf.length) return cached.status;

  // Only decode NEW chunks since last check
  const startIdx = cached?.chunkCount ?? 0;
  // Default to "building" until we see success or error
  let currentStatus = cached?.status ?? "building";

  if (buf.length > startIdx) {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const newChunks = buf.slice(startIdx);
    const text = newChunks.map((c) => decoder.decode(c, { stream: true })).join("");

    // Check the new text — last match wins (most recent output)
    if (BUILDING_PATTERNS.test(text)) currentStatus = "building";
    if (ERROR_PATTERNS.test(text)) currentStatus = "error";
    if (SUCCESS_PATTERNS.test(text)) currentStatus = "success";
  }

  watcherStatusCache.set(bufferKey, { status: currentStatus, chunkCount: buf.length });
  return currentStatus;
}

// --- Icons ---

function EyeOpenIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" stroke="#5b9e6f" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3.5" stroke="#5b9e6f" strokeWidth="1.8" />
    </svg>
  );
}

function EyeClosedIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" stroke="#777" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" stroke="#777" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M1 1l22 22" stroke="#777" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BuildStatusDot({ status }: { status: WatcherBuildStatus }) {
  if (status === "idle") return null;
  const color = status === "error" ? "#e06c75" : status === "success" ? "#4caf50" : "#e8b930";
  return (
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        ...(status === "building" ? { animation: "pulse-glow 1.5s ease-in-out infinite" } : {}),
      }}
    />
  );
}

function TerminalIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
      <rect x="0.5" y="1" width="11" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3 4.5L5 6L3 7.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="6.5" y1="7.5" x2="9" y2="7.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function RenameInput({
  defaultValue,
  onCommit,
  onCancel,
}: {
  defaultValue: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const committed = useRef(false);
  const didSelect = useRef(false);

  const applySelection = useCallback(() => {
    const el = ref.current;
    if (!el || didSelect.current) return;
    didSelect.current = true;
    const dot = defaultValue.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : defaultValue.length);
  }, [defaultValue]);

  useEffect(() => {
    setTimeout(() => ref.current?.focus(), 0);
  }, []);

  const commit = useCallback((value: string) => {
    if (committed.current) return;
    committed.current = true;
    const trimmed = value.trim();
    if (trimmed && trimmed !== defaultValue) {
      onCommit(trimmed);
    } else {
      onCancel();
    }
  }, [defaultValue, onCommit, onCancel]);

  return (
    <input
      ref={ref}
      defaultValue={defaultValue}
      onFocus={applySelection}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); commit(e.currentTarget.value); }
        if (e.key === "Escape") { e.preventDefault(); committed.current = true; onCancel(); }
      }}
      onBlur={(e) => commit(e.currentTarget.value)}
      style={{
        flex: 1,
        minWidth: 0,
        background: "transparent",
        border: "1px solid #007acc",
        borderRadius: 2,
        color: "#e0e0e0",
        fontSize: 12,
        fontWeight: 600,
        fontFamily: "inherit",
        padding: "1px 4px",
        outline: "none",
        lineHeight: "normal",
        boxShadow: "0 0 0 1px rgba(0,122,204,0.3)",
      }}
    />
  );
}

function CommandIcon() {
  return (
    <svg width="14" height="14" viewBox="-2 -1 28 26" style={{ flexShrink: 0 }}>
      <path d={CLAUDE_PATH} fill="#D97757" fillRule="nonzero" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 10 10" fill="currentColor">
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
  watcherActions: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    flexShrink: 0,
  },
};
