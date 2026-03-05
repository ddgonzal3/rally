import React, { useState, useEffect, useMemo, useRef } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { api } from "../lib/tauri";
import type { ScriptEntry } from "../lib/types";
import {
  isWatcherScript,
  getWatcherBuildStatus,
  getStatusColor,
  getDisplayName,
  formatAbsoluteTime,
  getLastLine,
  type WatcherBuildStatus,
} from "../lib/watcherStatus";
import { useDetectedPorts } from "../lib/useDetectedPorts";
import { PortPill } from "./PortPill";

// --- Icons ---

const svgAlign: React.CSSProperties = { flexShrink: 0, display: "block" };

function EyeOpenIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={svgAlign}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" stroke="var(--status-green)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3.5" stroke="var(--status-green)" strokeWidth="1.8" />
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
    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" style={svgAlign}><rect x="2" y="2" width="6" height="6" rx="1" fill="var(--status-red)" /></svg>
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
  const detectedPorts = useDetectedPorts(activeWorkspaceId);
  const openWebView = useWorkspaceStore((s) => s.openWebView);

  // Script entries cache per repo path
  const [scriptCache, setScriptCache] = useState<Record<string, ScriptEntry[]>>({});

  // Timestamps cached in a ref — set during render when a build completes
  const buildTimeCache = useRef<Record<string, string>>({});

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

  // No timestamp effect needed — timestamps are cached in buildTimeCache ref during render

  // Return null if nothing to show
  if (!activeWorkspaceId || reposWithStatusBar.length === 0) return null;

  return (
    <div data-statusbar="" style={{
      height: 28,
      background: "var(--bg-surface)",
      borderTop: "1px solid var(--border)",
      display: "flex",
      alignItems: "center",
      gap: 0,
      paddingLeft: 4,
      paddingRight: 10,
      paddingBottom: 2,
      flexShrink: 0,
      overflow: "hidden",
      userSelect: "none" as const,
    }}>
      {reposWithStatusBar.map(({ repoPath, repoName, scripts }, repoIdx) => {
        const collapsed = !!statusBarCollapsed[repoPath];

        return (
          <div
            key={repoPath}
            style={{
              display: "flex",
              alignItems: "stretch",
              height: 22,
              background: "transparent",
              borderRadius: 0,
              marginRight: repoIdx < reposWithStatusBar.length - 1 ? 6 : 0,
            }}
          >
            {/* Repo name — arrow/chevron tab */}
            <div
              onClick={() => toggleStatusBarCollapsed(repoPath)}
              style={{
                display: "flex",
                alignItems: "center",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <div style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                padding: "0 2px 0 8px",
                background: "var(--pill-bg)",
                borderRadius: "4px 0 0 4px",
                height: 22,
              }}>
                <span
                  style={{
                    fontSize: 13,
                    color: "var(--text-primary)",
                    userSelect: "none",
                    whiteSpace: "nowrap",
                    fontWeight: 600,
                    lineHeight: 1,
                  }}
                >
                  {repoName}
                </span>

              </div>
              {/* Arrow point triangle */}
              <div style={{
                width: 0,
                height: 0,
                borderTop: "11px solid transparent",
                borderBottom: "11px solid transparent",
                borderLeft: "10px solid var(--pill-bg)",
                flexShrink: 0,
              }} />
            </div>

            {/* Expanded: individual script slots */}
            {!collapsed && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 8px 0 4px" }}>
                {scripts.map((scriptName, scriptIdx) => {
              const key = `${repoPath}:${scriptName}`;
              const run = scriptRuns[key];
              const isRunning = run?.status === "running";
              const isWatcher = isWatcherScript(scriptName);
              let buildStatus: WatcherBuildStatus;
              if (isRunning) {
                // Only use output-based status detection for watchers
                // Non-watcher scripts just show "building" while running — exit code determines final status
                buildStatus = isWatcher ? getWatcherBuildStatus(key) : "building";
              } else if (isWatcher && run?.status === "success") {
                // Watcher stopped (Ctrl+C) — back to idle, not "success"
                buildStatus = "idle";
              } else if (run?.status === "success") {
                buildStatus = "success";
              } else if (run?.status === "error") {
                buildStatus = "error";
              } else {
                buildStatus = "idle";
              }
              const displayName = getDisplayName(scriptName);
              // Cache timestamp when we first see a completed build
              if ((buildStatus === "success" || buildStatus === "error") && !buildTimeCache.current[key]) {
                buildTimeCache.current[key] = formatAbsoluteTime(Date.now());
              }
              // Clear cached timestamp when script restarts (building again)
              if (buildStatus === "building" || buildStatus === "idle") {
                delete buildTimeCache.current[key];
              }
              const timeStr = buildTimeCache.current[key];
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
                    onClick={() => {
                      // Only auto-start if there's no existing run at all
                      if (!run) {
                        runScript(repoPath, scriptName, command);
                      }
                      openStatusBarDrawer(repoPath, scriptName);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      padding: "2px 6px",
                      borderRadius: isDrawerOpen ? "3px 3px 0 0" : 3,
                      cursor: "pointer",
                      background: isDrawerOpen ? "var(--terminal-bg)" : "transparent",
                    }}
                  >
                    {/* Status dot */}
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: getStatusColor(buildStatus),
                        opacity: 0.6,
                        flexShrink: 0,
                        ...(buildStatus === "building" ? { animation: "pulse-glow 1.5s ease-in-out infinite" } : {}),
                      }}
                    />

                    {/* Script name */}
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 500,
                        color: "var(--text-secondary)",
                        whiteSpace: "nowrap",
                        userSelect: "none",
                        lineHeight: 1,
                      }}
                    >
                      {displayName}
                    </span>

                    {/* Status text: live preview when building (only if output exists), static time when done, nothing when idle */}
                    {buildStatus === "building" && getLastLine(key) ? (
                      <span style={{
                        fontSize: 12,
                        fontWeight: 500,
                        color: "var(--text-secondary)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        width: 200,
                        maxWidth: 200,
                        lineHeight: 1,
                      }}>
                        {getLastLine(key)}
                      </span>
                    ) : buildStatus !== "idle" && buildStatus !== "building" ? (
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 500,
                          color: buildStatus === "error" ? "var(--status-red)" : "var(--text-secondary)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          maxWidth: 200,
                          lineHeight: 1,
                        }}
                      >
                        {buildStatus === "error"
                          ? (getLastLine(key) || "error") + (timeStr ? " \u00B7 " + timeStr : "")
                          : timeStr ? "built at " + timeStr : "built"}
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

                    {/* Detected localhost port pills */}
                    {activeWorkspaceId && detectedPorts
                      .filter((p) => p.source.type === "script" && p.source.repoPath === repoPath && p.source.scriptName === scriptName)
                      .map((p) => (
                        <PortPill key={p.port} port={p} onClick={(url) => openWebView(activeWorkspaceId, url)} />
                      ))}
                  </div>
                </React.Fragment>
              );
                })}
              </div>
            )}
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
