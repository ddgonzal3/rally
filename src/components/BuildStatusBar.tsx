import React, { useState, useEffect, useMemo } from "react";
import { useWorkspaceStore, scriptOutputBuffers } from "../stores/workspaceStore";
import { api } from "../lib/tauri";
import type { ScriptEntry } from "../lib/types";

// --- Watcher detection & status (copied from TaskPanel.tsx) ---

function isWatcherScript(name: string): boolean {
  return name.toLowerCase().includes("watch");
}

type WatcherBuildStatus = "idle" | "building" | "success" | "error";

const ERROR_PATTERNS = /\b(error|failed|failure|ERR!|ERROR)\b/i;
const SUCCESS_PATTERNS = /\b(built in|compiled successfully|ready in|watching for file changes|successfully compiled|ready|complete)\b/i;
const BUILDING_PATTERNS = /\b(rebuilding|compiling|bundling|transforming)\b/i;

const watcherStatusCache = new Map<string, { status: WatcherBuildStatus; chunkCount: number }>();

function getWatcherBuildStatus(bufferKey: string): WatcherBuildStatus {
  const buf = scriptOutputBuffers.get(bufferKey);
  if (!buf || buf.length === 0) return "building";
  const cached = watcherStatusCache.get(bufferKey);
  if (cached && cached.chunkCount === buf.length) return cached.status;
  const startIdx = cached?.chunkCount ?? 0;
  let currentStatus = cached?.status ?? "building";
  if (buf.length > startIdx) {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const newChunks = buf.slice(startIdx);
    const text = newChunks.map((c) => decoder.decode(c, { stream: true })).join("");
    if (BUILDING_PATTERNS.test(text)) currentStatus = "building";
    if (ERROR_PATTERNS.test(text)) currentStatus = "error";
    if (SUCCESS_PATTERNS.test(text)) currentStatus = "success";
  }
  watcherStatusCache.set(bufferKey, { status: currentStatus, chunkCount: buf.length });
  return currentStatus;
}

// --- Relative timestamps ---

const lastBuildTimes = new Map<string, number>();
const prevStatuses = new Map<string, WatcherBuildStatus>();

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

// --- Last line preview from output buffer ---

/** ANSI escape code stripper */
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b[()][A-Z0-9]|\x0f/g;

function getLastLine(bufferKey: string): string {
  const buf = scriptOutputBuffers.get(bufferKey);
  if (!buf || buf.length === 0) return "";
  // Decode just the last few chunks (avoid decoding the entire buffer)
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const tail = buf.slice(Math.max(0, buf.length - 5));
  const text = tail.map((c) => decoder.decode(c, { stream: true })).join("");
  // Split by newlines, filter empty, take last non-empty line
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return "";
  // Strip ANSI codes and carriage returns for clean display
  return lines[lines.length - 1].replace(ANSI_RE, "").replace(/\r/g, "").trim();
}

// --- Display name ---

function getDisplayName(scriptName: string): string {
  return scriptName.replace(/\.(sh|bash)$/, "");
}

// --- Status dot color ---

function getStatusColor(status: WatcherBuildStatus): string {
  switch (status) {
    case "error": return "#e06c75";
    case "success": return "#4caf50";
    case "building": return "#e8b930";
    case "idle": return "var(--text-dim)";
  }
}

// --- Aggregate status across scripts ---

function getWorstStatus(statuses: WatcherBuildStatus[]): WatcherBuildStatus {
  if (statuses.includes("error")) return "error";
  if (statuses.includes("building")) return "building";
  if (statuses.includes("success")) return "success";
  return "idle";
}

// --- Icons ---

const svgAlign: React.CSSProperties = { flexShrink: 0, display: "block" };

function EyeOpenIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={svgAlign}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" stroke="#5b9e6f" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3.5" stroke="#5b9e6f" strokeWidth="1.8" />
    </svg>
  );
}

function EyeClosedIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={svgAlign}>
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M1 1l22 22" stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" style={svgAlign}><path d="M2 1l7 4-7 4V1z" fill="currentColor" /></svg>
  );
}

function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" style={svgAlign}><rect x="2" y="2" width="6" height="6" rx="1" fill="#e06c75" /></svg>
  );
}

// --- Component ---

export function BuildStatusBar() {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  // Return a stable string to avoid infinite re-renders (PITFALLS.md — new array breaks Object.is)
  const workspacePathsStr = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    return ws?.paths?.join("\n") ?? "";
  });
  const workspacePaths = useMemo(
    () => (workspacePathsStr ? workspacePathsStr.split("\n") : []),
    [workspacePathsStr],
  );
  const rallyConfigs = useWorkspaceStore((s) => s.rallyConfigs);
  const scriptRuns = useWorkspaceStore((s) => s.scriptRuns);
  const runScript = useWorkspaceStore((s) => s.runScript);
  const stopScript = useWorkspaceStore((s) => s.stopScript);
  const statusBarCollapsed = useWorkspaceStore((s) => s.statusBarCollapsed);
  const toggleStatusBarCollapsed = useWorkspaceStore((s) => s.toggleStatusBarCollapsed);
  const openStatusBarDrawer = useWorkspaceStore((s) => s.openStatusBarDrawer);
  const statusBarDrawer = useWorkspaceStore((s) => s.statusBarDrawer);

  // Script entries cache per repo path
  const [scriptCache, setScriptCache] = useState<Record<string, ScriptEntry[]>>({});

  // Event-driven re-renders for watcher output
  const [, setTick] = useState(0);

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const handler = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => setTick((t) => t + 1), 300);
    };
    document.addEventListener("rally:watcher-output", handler);
    return () => {
      document.removeEventListener("rally:watcher-output", handler);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, []);

  // 10-second interval for relative timestamps
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 10000);
    return () => clearInterval(interval);
  }, []);

  // Load RALLY.json configs and scripts for ALL repo paths in the workspace
  const loadRallyConfig = useWorkspaceStore((s) => s.loadRallyConfig);
  useEffect(() => {
    for (const path of workspacePaths) {
      // Ensure config is loaded for every repo (App.tsx only loads paths[0])
      if (!rallyConfigs[path]) {
        loadRallyConfig(path);
      }
      api.listScripts(path).then((entries) => {
        setScriptCache((prev) => ({ ...prev, [path]: entries }));
      }).catch(() => {});
    }
  }, [workspacePaths, loadRallyConfig, rallyConfigs]);

  // Build the list of repos that have statusBar scripts configured
  const reposWithStatusBar = useMemo(() => {
    const result: { repoPath: string; repoName: string; scripts: string[] }[] = [];
    for (const repoPath of workspacePaths) {
      const config = rallyConfigs[repoPath];
      if (!config || !config.statusBar || config.statusBar.length === 0) continue;
      const repoName = repoPath.split("/").pop() ?? repoPath;
      result.push({ repoPath, repoName, scripts: config.statusBar });
    }
    return result;
  }, [workspacePaths, rallyConfigs]);

  // Return null if nothing to show
  if (!activeWorkspaceId || reposWithStatusBar.length === 0) return null;

  // Track status transitions for timestamps
  for (const { repoPath, scripts } of reposWithStatusBar) {
    for (const scriptName of scripts) {
      const key = `${repoPath}:${scriptName}`;
      const run = scriptRuns[key];
      const isRunning = run?.status === "running";
      const isWatcher = isWatcherScript(scriptName);

      if (isRunning) {
        const status = isWatcher ? getWatcherBuildStatus(key) : "building";
        const prev = prevStatuses.get(key);
        // Update timestamp on transition to success/error
        if ((status === "success" || status === "error") && prev === "building") {
          lastBuildTimes.set(key, Date.now());
        }
        prevStatuses.set(key, status);
      } else if (!isRunning && run?.status === "success") {
        // One-shot script finished — mark timestamp if not already set
        if (!lastBuildTimes.has(key)) {
          lastBuildTimes.set(key, Date.now());
        }
        prevStatuses.set(key, "success");
      } else if (!isRunning && run?.status === "error") {
        if (!lastBuildTimes.has(key)) {
          lastBuildTimes.set(key, Date.now());
        }
        prevStatuses.set(key, "error");
      }
    }
  }

  return (
    <div style={{
      height: 34,
      background: "var(--bg-surface)",
      borderTop: "1px solid var(--border)",
      display: "flex",
      alignItems: "center",
      gap: 0,
      paddingLeft: 10,
      paddingRight: 10,
      flexShrink: 0,
      overflow: "hidden",
    }}>
      {reposWithStatusBar.map(({ repoPath, repoName, scripts }, repoIdx) => {
        const collapsed = !!statusBarCollapsed[repoPath];

        // Compute per-script statuses for aggregate dot
        const scriptStatuses = scripts.map((scriptName) => {
          const key = `${repoPath}:${scriptName}`;
          const run = scriptRuns[key];
          if (run?.status === "running") return getWatcherBuildStatus(key);
          if (run?.status === "success") return "success" as WatcherBuildStatus;
          if (run?.status === "error") return "error" as WatcherBuildStatus;
          return "idle" as WatcherBuildStatus;
        });

        return (
          <div
            key={repoPath}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "var(--bg-elevated)",
              borderRadius: 6,
              padding: "3px 8px",
              marginRight: repoIdx < reposWithStatusBar.length - 1 ? 6 : 0,
            }}
          >
            {/* Repo tab label — click to collapse/expand */}
            <span
              onClick={() => toggleStatusBarCollapsed(repoPath)}
              style={{
                cursor: "pointer",
                fontSize: 13,
                color: "var(--text-primary)",
                userSelect: "none",
                whiteSpace: "nowrap",
                fontWeight: 500,
                lineHeight: 1,
              }}
            >
              {repoName}
            </span>

            {/* Collapsed: aggregate dot */}
            {collapsed && (() => {
              const worstStatus = getWorstStatus(scriptStatuses);
              return (
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: getStatusColor(worstStatus),
                    flexShrink: 0,
                    ...(worstStatus === "building" ? { animation: "pulse-glow 1.5s ease-in-out infinite" } : {}),
                  }}
                />
              );
            })()}

            {/* Expanded: individual script slots */}
            {!collapsed && scripts.map((scriptName, scriptIdx) => {
              const key = `${repoPath}:${scriptName}`;
              const run = scriptRuns[key];
              const isRunning = run?.status === "running";
              const isWatcher = isWatcherScript(scriptName);
              let buildStatus: WatcherBuildStatus;
              if (isRunning) {
                // Use output-based status detection for all scripts, not just watchers
                buildStatus = getWatcherBuildStatus(key);
              } else if (run?.status === "success") {
                buildStatus = "success";
              } else if (run?.status === "error") {
                buildStatus = "error";
              } else {
                buildStatus = "idle";
              }
              const displayName = getDisplayName(scriptName);
              const timestamp = lastBuildTimes.get(key);
              const isDrawerOpen = statusBarDrawer?.repoPath === repoPath && statusBarDrawer?.scriptName === scriptName;

              // Find the command for this script
              const scriptEntry = scriptCache[repoPath]?.find((e) => e.name === scriptName);
              const command = scriptEntry?.command ?? scriptName;

              return (
                <React.Fragment key={scriptName}>
                  {scriptIdx > 0 && (
                    <div style={{ width: 1, height: 14, background: "var(--border)", flexShrink: 0 }} />
                  )}
                  <div
                    onClick={() => openStatusBarDrawer(repoPath, scriptName)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      padding: "2px 6px",
                      borderRadius: 3,
                      cursor: "pointer",
                      background: isDrawerOpen ? "var(--bg-hover)" : "transparent",
                    }}
                  >
                    {/* Status dot */}
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: getStatusColor(buildStatus),
                        flexShrink: 0,
                        ...(buildStatus === "building" ? { animation: "pulse-glow 1.5s ease-in-out infinite" } : {}),
                      }}
                    />

                    {/* Script name */}
                    <span
                      style={{
                        fontSize: 13,
                        color: "var(--text-primary)",
                        whiteSpace: "nowrap",
                        userSelect: "none",
                        lineHeight: 1,
                      }}
                    >
                      {displayName}
                    </span>

                    {/* Status text: live preview when building, timestamp when done, nothing when idle */}
                    {buildStatus === "building" ? (
                      <span style={{
                        fontSize: 12,
                        color: "var(--text-primary)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        maxWidth: 300,
                        lineHeight: 1,
                      }}>
                        {getLastLine(key) || "building\u2026"}
                      </span>
                    ) : buildStatus !== "idle" ? (
                      <span
                        style={{
                          fontSize: 12,
                          color: buildStatus === "error" ? "#e06c75" : "var(--text-primary)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          maxWidth: buildStatus === "error" ? 300 : undefined,
                          lineHeight: 1,
                        }}
                      >
                        {buildStatus === "error" ? (getLastLine(key) || "error") + (timestamp ? " \u00B7 " + formatRelativeTime(timestamp) : "")
                          : timestamp ? "built " + formatRelativeTime(timestamp)
                          : ""}
                      </span>
                    ) : null}

                    {/* Action button: eye toggle for watchers, play/stop for scripts */}
                    {isWatcher ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isRunning) {
                            stopScript(repoPath, scriptName);
                          } else {
                            runScript(repoPath, scriptName, command);
                          }
                        }}
                        style={actionBtnStyle}
                        title={isRunning ? "Stop watcher" : "Start watcher"}
                      >
                        {isRunning ? <EyeOpenIcon /> : <EyeClosedIcon />}
                      </button>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (buildStatus === "building") {
                            stopScript(repoPath, scriptName);
                          } else {
                            runScript(repoPath, scriptName, command);
                          }
                        }}
                        style={actionBtnStyle}
                        title={buildStatus === "building" ? "Stop" : "Run"}
                      >
                        {buildStatus === "building" ? <StopIcon /> : <PlayIcon />}
                      </button>
                    )}
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

const actionBtnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "none",
  border: "none",
  color: "var(--text-dim)",
  cursor: "pointer",
  padding: 0,
  borderRadius: 3,
  flexShrink: 0,
};
