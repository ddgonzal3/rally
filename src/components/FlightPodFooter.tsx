import React, { useState, useEffect, useRef } from "react";
import {
  useWorkspaceStore,
  cancelDrawerHoverClose,
  startDrawerHoverClose,
} from "../stores/workspaceStore";
import { api } from "../lib/tauri";
import type { ScriptEntry } from "../lib/types";
import {
  isWatcherScript,
  getWatcherDisplayStatus,
  getDisplayName,
  clearWatcherStatusCache,
  type WatcherBuildStatus,
} from "../lib/watcherStatus";

/** Compact script dot for the flight pod footer. */
function PodScriptDot({
  repoPath,
  scriptName,
  scriptEntry,
}: {
  repoPath: string;
  scriptName: string;
  scriptEntry: ScriptEntry | undefined;
}) {
  const scriptRuns = useWorkspaceStore((s) => s.scriptRuns);
  const runScript = useWorkspaceStore((s) => s.runScript);
  const stopScript = useWorkspaceStore((s) => s.stopScript);
  const clearScript = useWorkspaceStore((s) => s.clearScript);
  const openStatusBarDrawer = useWorkspaceStore((s) => s.openStatusBarDrawer);
  const statusBarDrawer = useWorkspaceStore((s) => s.statusBarDrawer);

  const key = `${repoPath}:${scriptName}`;
  const run = scriptRuns[key];
  const isRunning = run?.status === "running";
  const isWatcher = isWatcherScript(scriptName);
  const command = scriptEntry?.command ?? scriptName;
  const displayName = getDisplayName(scriptName);

  const isDrawerOpen =
    statusBarDrawer?.repoPath === repoPath &&
    statusBarDrawer?.scriptName === scriptName;

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

  // Dot color
  let dotColor = "var(--text-dim)";
  let dotOpacity = 0.6;
  if (buildStatus === "building") {
    dotColor = "var(--status-amber)";
    dotOpacity = 1;
  } else if (buildStatus === "error") {
    dotColor = "var(--status-red)";
    dotOpacity = 1;
  } else if (isRunning && isWatcher) {
    dotColor = "var(--status-green)";
    dotOpacity = 0.7;
  } else if (buildStatus === "success") {
    dotColor = "var(--status-green)";
    dotOpacity = 0.7;
  }

  const restart = () => {
    if (isRunning) stopScript(repoPath, scriptName);
    clearScript(repoPath, scriptName);
    clearWatcherStatusCache(key);
    setTimeout(() => {
      runScript(repoPath, scriptName, command);
      setTimeout(() => openStatusBarDrawer(repoPath, scriptName), 50);
    }, 100);
  };

  return (
    <div
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.altKey) {
          restart();
          return;
        }
        if (isRunning || buildStatus === "error") {
          cancelDrawerHoverClose();
          openStatusBarDrawer(repoPath, scriptName);
        } else {
          runScript(repoPath, scriptName, command);
        }
      }}
      onMouseEnter={() => {
        if ((isRunning || buildStatus === "error") && isDrawerOpen) {
          cancelDrawerHoverClose();
        }
      }}
      onMouseLeave={() => {
        if (isDrawerOpen && statusBarDrawer?.hoverMode) {
          startDrawerHoverClose(() => {
            useWorkspaceStore.getState().closeDrawerIfHover();
          });
        }
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 3px",
        borderRadius: 3,
        cursor: "pointer",
        background: isDrawerOpen ? "var(--terminal-popup-bg)" : "transparent",
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: dotColor,
          opacity: dotOpacity,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: 13,
          fontWeight: 500,
          color: "var(--text-primary)",
          opacity: 0.8,
          whiteSpace: "nowrap",
          lineHeight: 1,
        }}
      >
        {displayName}
      </span>
    </div>
  );
}

/** Script footer bar for a flight pod — shows statusBar scripts for the pod's repo. */
export function FlightPodFooter({ repoPath, onOpenTerminal }: { repoPath: string; onOpenTerminal?: () => void }) {
  const rallyConfig = useWorkspaceStore((s) => s.rallyConfigs[repoPath]);
  const loadRallyConfig = useWorkspaceStore((s) => s.loadRallyConfig);
  const [scriptCache, setScriptCache] = useState<ScriptEntry[]>([]);

  useEffect(() => {
    if (!rallyConfig) loadRallyConfig(repoPath);
    api.listScripts(repoPath).then(setScriptCache).catch(() => {});
  }, [repoPath, loadRallyConfig, rallyConfig]);

  const scripts = rallyConfig?.statusBar ?? [];
  if (scripts.length === 0) return null;

  const repoName = repoPath.split("/").pop() ?? repoPath;

  return (
    <div
      onContextMenu={(e) => e.preventDefault()}
      style={{
        height: 28,
        display: "flex",
        alignItems: "center",
        gap: 0,
        paddingLeft: 8,
        paddingRight: 10,
        paddingBottom: 2,
        borderTop: "1px solid rgba(255, 255, 255, 0.06)",
        flexShrink: 0,
        overflow: "hidden",
        userSelect: "none",
        background: "rgb(30, 30, 30)",
      }}
    >
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "var(--text-primary)",
          whiteSpace: "nowrap",
          lineHeight: 1,
          flexShrink: 0,
          marginRight: 5,
        }}
      >
        {repoName}
      </span>
      {scripts.map((scriptName) => (
        <PodScriptDot
          key={scriptName}
          repoPath={repoPath}
          scriptName={scriptName}
          scriptEntry={scriptCache.find((e) => e.name === scriptName)}
        />
      ))}
      {onOpenTerminal && (
        <>
          <div style={{ flex: 1 }} />
          <button
            className="tab-action"
            onClick={(e) => { e.stopPropagation(); onOpenTerminal(); }}
            title="Open terminal (Ctrl+`)"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 20,
              height: 20,
              background: "none",
              border: "none",
              color: "var(--text-dim)",
              cursor: "pointer",
              borderRadius: 4,
              padding: 0,
              flexShrink: 0,
            }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M4 5l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <line x1="9" y1="11" x2="13" y2="11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </>
      )}
    </div>
  );
}
