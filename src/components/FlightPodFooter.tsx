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
import { showContextMenu, type MenuAction } from "../lib/contextMenu";

const podActionButtonStyle: React.CSSProperties = {
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

function StopIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true" style={{ display: "block" }}>
      <rect x="2" y="2" width="9" height="9" rx="1.5" fill="currentColor" />
    </svg>
  );
}

function RestartIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ display: "block" }}>
      <path d="M1.5 6a4.5 4.5 0 0 1 8.18-2.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M10.5 6a4.5 4.5 0 0 1-8.18 2.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M10.2 1v2.4H7.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M1.8 11v-2.4h2.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

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
  const [hovered, setHovered] = useState(false);
  const [hasLeftSinceStart, setHasLeftSinceStart] = useState(false);

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

  // "built at" / "ran at" timestamp — matches dev mode BuildStatusBar
  const [builtAt, setBuiltAt] = useState<string | null>(null);
  const [flashing, setFlashing] = useState(false);
  const prevStatusRef = useRef<WatcherBuildStatus>("idle");
  const buildCompletionCount = run?.buildCompletionCount ?? 0;
  const prevCompletionCountRef = useRef(buildCompletionCount);

  // Flash detection: building -> success triggers a 3s flash
  useEffect(() => {
    if (buildStatus === "success" && prevStatusRef.current === "building") {
      setFlashing(true);
      const timer = setTimeout(() => setFlashing(false), 3000);
      const now = new Date();
      const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
      setBuiltAt(timeStr);
      prevStatusRef.current = buildStatus;
      return () => clearTimeout(timer);
    }
    if (buildStatus !== "success") setFlashing(false);
    if (buildStatus === "error") setBuiltAt(null);
    prevStatusRef.current = buildStatus;
  }, [buildStatus, isWatcher]);

  // Detect rebuild completions via buildCompletionCount
  useEffect(() => {
    if (buildCompletionCount > prevCompletionCountRef.current && isWatcher) {
      const now = new Date();
      const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
      setBuiltAt(timeStr);
      if (!flashing) {
        setFlashing(true);
        setTimeout(() => setFlashing(false), 3000);
      }
    }
    prevCompletionCountRef.current = buildCompletionCount;
  }, [buildCompletionCount, isWatcher]);

  // Auto-dismiss "built at" after 120s — also reset non-watcher scripts to idle
  useEffect(() => {
    if (!builtAt) return;
    const timer = setTimeout(() => {
      setBuiltAt(null);
      if (!isWatcher && !isRunning) {
        clearScript(repoPath, scriptName);
      }
    }, 120000);
    return () => clearTimeout(timer);
  }, [builtAt, isWatcher, isRunning, clearScript, repoPath, scriptName]);

  // Dot style
  const dotStyle: React.CSSProperties = {
    width: 7,
    height: 7,
    borderRadius: "50%",
    flexShrink: 0,
  };

  if (flashing) {
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
    dotStyle.background = "var(--status-green)";
    dotStyle.opacity = 0.7;
  } else if (buildStatus === "success") {
    dotStyle.background = "var(--status-green)";
    dotStyle.opacity = 0.7;
  } else {
    dotStyle.background = "var(--text-dim)";
    dotStyle.opacity = 0.6;
  }

  const restart = () => {
    if (isRunning) stopScript(repoPath, scriptName);
    clearScript(repoPath, scriptName);
    clearWatcherStatusCache(key);
    setFlashing(false);
    setBuiltAt(null);
    setHasLeftSinceStart(false);
    prevStatusRef.current = "idle";
    setTimeout(() => {
      runScript(repoPath, scriptName, command);
      setTimeout(() => openStatusBarDrawer(repoPath, scriptName), 50);
    }, 100);
  };

  const kill = () => {
    if (isRunning) stopScript(repoPath, scriptName);
    clearScript(repoPath, scriptName);
    clearWatcherStatusCache(key);
    setFlashing(false);
    setBuiltAt(null);
    setHasLeftSinceStart(false);
    prevStatusRef.current = "idle";
    if (isDrawerOpen) {
      useWorkspaceStore.getState().closeStatusBarDrawer();
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const items: MenuAction[] = [
      { label: "Restart", action: restart, accelerator: "Alt+Click" },
    ];
    if (isRunning) {
      items.push({ label: "Stop", action: kill });
    }
    const bar = (e.currentTarget as HTMLElement).closest("[data-pod-footer]");
    const barTop = bar ? bar.getBoundingClientRect().top : e.clientY;
    showContextMenu(items, { x: e.clientX, y: barTop });
  };

  // Only show action icons when the script is actively running
  const showActions = isRunning && hovered;

  return (
    <div
      onMouseEnter={() => {
        setHovered(true);
        if (!isRunning) setHasLeftSinceStart(true);
        if ((isRunning || buildStatus === "error") && isDrawerOpen) {
          cancelDrawerHoverClose();
        }
      }}
      onMouseLeave={() => {
        setHovered(false);
        if (isRunning) setHasLeftSinceStart(true);
        if (isDrawerOpen && statusBarDrawer?.hoverMode) {
          startDrawerHoverClose(() => {
            useWorkspaceStore.getState().closeDrawerIfHover();
          });
        }
      }}
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
      onContextMenu={handleContextMenu}
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
        onMouseEnter={() => {
          if (isRunning || buildStatus === "error") {
            cancelDrawerHoverClose();
            openStatusBarDrawer(repoPath, scriptName, true);
          }
        }}
        style={dotStyle}
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

      {builtAt && (
        <span
          style={{
            fontSize: 11,
            color: "var(--text-secondary)",
            whiteSpace: "nowrap",
            lineHeight: 1,
          }}
        >
          {isWatcher ? "built" : "ran"} {builtAt}
        </span>
      )}

      {/* Action icons — fade in on hover (matches dev mode BuildStatusBar) */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          opacity: showActions ? 1 : 0,
          width: showActions ? (isRunning ? 36 : 18) : 0,
          overflow: "hidden",
          transition: "opacity 0.15s ease, width 0.15s ease",
          pointerEvents: showActions ? "auto" : "none",
          flexShrink: 0,
          margin: 0,
          padding: 0,
        }}
      >
        {isRunning && (
          <button
            className="tab-action"
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); kill(); }}
            title="Stop"
            style={{ ...podActionButtonStyle, opacity: 0.88 }}
          >
            <StopIcon />
          </button>
        )}
        <button
          className="tab-action"
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); restart(); }}
          title="Restart"
          style={podActionButtonStyle}
        >
          <RestartIcon />
        </button>
      </div>
    </div>
  );
}

/** Script footer bar for a flight pod — shows statusBar scripts for the pod's repo. */
export function FlightPodFooter({ repoPath, onOpenTerminal }: { repoPath: string; onOpenTerminal?: () => void }) {
  const rallyConfig = useWorkspaceStore((s) => s.rallyConfigs[repoPath]);
  const loadRallyConfig = useWorkspaceStore((s) => s.loadRallyConfig);
  const branch = useWorkspaceStore((s) => s.gitStatuses[repoPath]?.branch);
  const [scriptCache, setScriptCache] = useState<ScriptEntry[]>([]);

  useEffect(() => {
    if (!rallyConfig) loadRallyConfig(repoPath);
    api.listScripts(repoPath).then(setScriptCache).catch(() => {});
  }, [repoPath, loadRallyConfig, rallyConfig]);

  const scripts = rallyConfig?.statusBar ?? [];
  if (scripts.length === 0 && !branch) return null;

  const repoName = repoPath.split("/").pop() ?? repoPath;

  return (
    <div
      data-pod-footer
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
          marginRight: branch ? 4 : 5,
        }}
      >
        {repoName}
      </span>
      {branch && (
        <span
          style={{
            fontSize: 12,
            color: "var(--text-primary)",
            whiteSpace: "nowrap",
            lineHeight: 1,
            flexShrink: 0,
            marginRight: 6,
            opacity: 0.7,
          }}
        >
          {branch.length > 24 ? branch.slice(0, 22) + "…" : branch}
        </span>
      )}
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
