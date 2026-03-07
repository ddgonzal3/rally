import React, { useState, useEffect, useMemo, useRef } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { api } from "../lib/tauri";
import type { ScriptEntry } from "../lib/types";
import {
  isWatcherScript,
  getWatcherDisplayStatus,
  getDisplayName,
  clearWatcherStatusCache,
  type WatcherBuildStatus,
} from "../lib/watcherStatus";
import { useDetectedPorts } from "../lib/useDetectedPorts";
import { PortPill } from "./PortPill";
import { showContextMenu, type MenuAction } from "../lib/contextMenu";

const watcherActionButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 16,
  height: 16,
  padding: 0,
  margin: 0,
  background: "none",
  border: "none",
  color: "var(--text-secondary)",
  cursor: "pointer",
  borderRadius: 3,
  flexShrink: 0,
  lineHeight: 0,
  appearance: "none",
  WebkitAppearance: "none",
};

function StopActionIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true" style={{ display: "block" }}>
      <rect x="2" y="2" width="9" height="9" rx="1.5" fill="currentColor" />
    </svg>
  );
}

function RestartActionIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ display: "block" }}>
      <path d="M1.5 6a4.5 4.5 0 0 1 8.18-2.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M10.5 6a4.5 4.5 0 0 1-8.18 2.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M9 1.5L9.7 3.4L7.8 3.4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 10.5L2.3 8.6L4.2 8.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}


// --- ScriptDot sub-component ---

function ScriptDot({
  repoPath,
  scriptName,
  scriptCache,
  scriptRuns,
  runScript,
  stopScript,
  clearScript,
  openStatusBarDrawer,
  statusBarDrawer,
  detectedPorts,
  activeWorkspaceId,
  openWebView,
}: {
  repoPath: string;
  scriptName: string;
  scriptCache: Record<string, ScriptEntry[]>;
  scriptRuns: ReturnType<typeof useWorkspaceStore.getState>["scriptRuns"];
  runScript: (repoPath: string, scriptName: string, command: string) => void;
  stopScript: (repoPath: string, scriptName: string) => void;
  clearScript: (repoPath: string, scriptName: string) => void;
  openStatusBarDrawer: (repoPath: string, scriptName: string) => void;
  statusBarDrawer: { repoPath: string; scriptName: string } | null;
  detectedPorts: ReturnType<typeof useDetectedPorts>;
  activeWorkspaceId: string | null;
  openWebView: (workspaceId: string, url: string) => void;
}) {
  const [flashing, setFlashing] = useState(false);
  const [hovered, setHovered] = useState(false);
  const prevStatusRef = useRef<WatcherBuildStatus>("idle");

  const key = `${repoPath}:${scriptName}`;
  const run = scriptRuns[key];
  const isRunning = run?.status === "running";
  const isWatcher = isWatcherScript(scriptName);

  let buildStatus: WatcherBuildStatus;
  if (isWatcher) {
    buildStatus = getWatcherDisplayStatus(run);
  } else if (isRunning) {
    buildStatus = "building";
  } else if (run?.status === "success") {
    buildStatus = "success";
  } else if (run?.status === "error") {
    buildStatus = "error";
  } else {
    buildStatus = "idle";
  }

  const displayName = getDisplayName(scriptName);
  const isDrawerOpen = statusBarDrawer?.repoPath === repoPath && statusBarDrawer?.scriptName === scriptName;
  const scriptEntry = scriptCache[repoPath]?.find((e) => e.name === scriptName);
  const command = scriptEntry?.command ?? scriptName;

  // "built at" timestamp — shown when watcher finishes a build, dismissed after 30s
  const [builtAt, setBuiltAt] = useState<string | null>(null);

  // Flash detection: building -> success triggers a 3s flash
  useEffect(() => {
    if (buildStatus === "success" && prevStatusRef.current === "building") {
      setFlashing(true);
      const timer = setTimeout(() => setFlashing(false), 3000);
      // Show completion timestamp
      const now = new Date();
      const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
      setBuiltAt(timeStr);
      prevStatusRef.current = buildStatus;
      return () => clearTimeout(timer);
    }
    if (buildStatus !== "success") {
      setFlashing(false);
    }
    if (buildStatus === "building" || buildStatus === "error") {
      setBuiltAt(null);
    }
    prevStatusRef.current = buildStatus;
  }, [buildStatus, isWatcher]);

  // Auto-dismiss "built at" after 120s
  useEffect(() => {
    if (!builtAt) return;
    const timer = setTimeout(() => setBuiltAt(null), 120000);
    return () => clearTimeout(timer);
  }, [builtAt]);

  // Determine dot style
  const dotStyle: React.CSSProperties = {
    width: 7,
    height: 7,
    borderRadius: "50%",
    flexShrink: 0,
  };

  if (flashing) {
    // Success flash animation
    dotStyle.background = "var(--status-green)";
    dotStyle.animation = isWatcher
      ? "success-flash-watcher 3s ease-out forwards"
      : "success-flash 3s ease-out forwards";
  } else if (buildStatus === "building") {
    dotStyle.background = "var(--status-amber)";
  } else if (buildStatus === "error") {
    dotStyle.background = "var(--status-red)";
    dotStyle.opacity = 1;
  } else if (isRunning && isWatcher) {
    // Watcher running (idle or success) — steady green
    dotStyle.background = "var(--status-green)";
    dotStyle.opacity = 0.7;
  } else {
    // Idle
    dotStyle.background = "var(--text-dim)";
    dotStyle.opacity = 0.6;
  }

  const restart = () => {
    if (isRunning) stopScript(repoPath, scriptName);
    clearScript(repoPath, scriptName);
    clearWatcherStatusCache(key);
    setFlashing(false);
    setBuiltAt(null);
    prevStatusRef.current = "idle";
    // Small delay to let the PTY clean up before respawning
    setTimeout(() => runScript(repoPath, scriptName, command), 100);
  };

  const kill = () => {
    if (isRunning) stopScript(repoPath, scriptName);
    clearScript(repoPath, scriptName);
    clearWatcherStatusCache(key);
    setFlashing(false);
    setBuiltAt(null);
    prevStatusRef.current = "idle";
    // Close the drawer if it's showing this script
    if (statusBarDrawer?.repoPath === repoPath && statusBarDrawer?.scriptName === scriptName) {
      useWorkspaceStore.getState().closeStatusBarDrawer();
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const items: MenuAction[] = [
      {
        label: "Restart",
        action: restart,
        accelerator: "Alt+Click",
      },
    ];
    if (isRunning) {
      items.push({
        label: "Stop",
        action: kill,
      });
    }
    // Nudge Y above the status bar so the menu opens upward instead of
    // clipping against the bottom window edge.
    const bar = (e.currentTarget as HTMLElement).closest("[data-statusbar]");
    const barTop = bar ? bar.getBoundingClientRect().top : e.clientY;
    showContextMenu(items, { x: e.clientX, y: barTop });
  };

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        // Option+click = restart
        if (e.altKey) {
          e.preventDefault();
          restart();
          return;
        }
        if (isRunning) {
          e.preventDefault();
          openStatusBarDrawer(repoPath, scriptName);
        } else if (buildStatus === "error") {
          e.preventDefault();
          openStatusBarDrawer(repoPath, scriptName);
        } else {
          e.preventDefault();
          runScript(repoPath, scriptName, command);
        }
      }}
      onContextMenu={handleContextMenu}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 6px",
        borderRadius: 3,
        cursor: "pointer",
        background: isDrawerOpen ? "var(--terminal-bg)" : "transparent",
      }}
    >
      {/* Status dot */}
      <span className={buildStatus === "building" && !flashing ? "pulse-sync" : undefined} style={dotStyle} />

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

      {/* Stop & Restart icons — fade in on hover when running */}
      {isRunning && (
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 0,
          opacity: hovered ? 1 : 0,
          maxWidth: hovered ? 32 : 0,
          overflow: "hidden",
          transition: "opacity 0.15s ease, max-width 0.15s ease",
          pointerEvents: hovered ? "auto" : "none",
          flexShrink: 0,
          willChange: "opacity, max-width",
          transform: "translateZ(0)",
        }}>
          <button
            className="tab-action"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              kill();
            }}
            title="Stop"
            style={{ ...watcherActionButtonStyle, opacity: 0.88 }}
          >
            <StopActionIcon />
          </button>
          <button
            className="tab-action"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              restart();
            }}
            title="Restart"
            style={watcherActionButtonStyle}
          >
            <RestartActionIcon />
          </button>
        </div>
      )}

      {/* "built at" timestamp — auto-dismisses after 30s */}
      {builtAt && (
        <span
          style={{
            fontSize: 12,
            color: "var(--text-secondary)",
            whiteSpace: "nowrap",
            lineHeight: 1,
          }}
        >
          {isWatcher ? "built" : "ran"} at {builtAt}
        </span>
      )}

      {/* Detected localhost port pills */}
      {activeWorkspaceId && detectedPorts
        .filter((p) => p.source.type === "script" && p.source.repoPath === repoPath && p.source.scriptName === scriptName)
        .map((p) => (
          <PortPill key={p.port} port={p} onClick={(url) => openWebView(activeWorkspaceId, url)} />
        ))}
    </div>
  );
}

// --- Component ---

export function BuildStatusBar() {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
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
  const clearScript = useWorkspaceStore((s) => s.clearScript);
  const openStatusBarDrawer = useWorkspaceStore((s) => s.openStatusBarDrawer);
  const statusBarDrawer = useWorkspaceStore((s) => s.statusBarDrawer);
  const detectedPorts = useDetectedPorts(activeWorkspaceId);
  const openWebView = useWorkspaceStore((s) => s.openWebView);

  // Script entries cache per repo path
  const [scriptCache, setScriptCache] = useState<Record<string, ScriptEntry[]>>({});

  // Load RALLY.json configs and scripts for ALL repo paths in the workspace
  const loadRallyConfig = useWorkspaceStore((s) => s.loadRallyConfig);
  useEffect(() => {
    for (const path of workspacePaths) {
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

  if (!activeWorkspaceId || reposWithStatusBar.length === 0) return null;

  return (
    <div data-statusbar="" onContextMenu={(e) => e.preventDefault()} style={{
      height: 28,
      background: "var(--bg-surface)",
      borderTop: "1px solid var(--border)",
      display: "flex",
      alignItems: "center",
      gap: 0,
      paddingLeft: 8,
      paddingRight: 10,
      paddingBottom: 2,
      flexShrink: 0,
      overflowX: "auto",
      overflowY: "hidden",
      userSelect: "none" as const,
      WebkitUserSelect: "none" as const,
      scrollbarWidth: "none" as const,
    }}>
      {reposWithStatusBar.map(({ repoPath, repoName, scripts }, repoIdx) => (
        <React.Fragment key={repoPath}>
          {/* Repo divider */}
          {repoIdx > 0 && (
            <div style={{
              width: 1,
              height: 14,
              background: "var(--border)",
              flexShrink: 0,
              margin: "0 8px",
            }} />
          )}

          {/* Repo name */}
          <span style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text-primary)",
            whiteSpace: "nowrap",
            lineHeight: 1,
            flexShrink: 0,
            marginRight: 2,
          }}>
            {repoName}
          </span>

          {/* Script dots */}
          {scripts.map((scriptName) => (
            <React.Fragment key={scriptName}>
              <ScriptDot
                repoPath={repoPath}
                scriptName={scriptName}
                scriptCache={scriptCache}
                scriptRuns={scriptRuns}
                runScript={runScript}
                stopScript={stopScript}
                clearScript={clearScript}
                openStatusBarDrawer={openStatusBarDrawer}
                statusBarDrawer={statusBarDrawer}
                detectedPorts={detectedPorts}
                activeWorkspaceId={activeWorkspaceId}
                openWebView={openWebView}
              />
            </React.Fragment>
          ))}
        </React.Fragment>
      ))}
    </div>
  );
}
