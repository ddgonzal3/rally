import React, { useCallback, useEffect, useRef } from "react";
import { Terminal } from "./Terminal";
import { ClaudeLauncher } from "./ClaudeLauncher";
import { ClaudeTerminalWrapper } from "./ClaudeTerminalWrapper";
import { EditorPane } from "./EditorPane";

import { DropZoneTarget, type DropPosition } from "./DropZoneOverlay";
import { PaneTabIcon } from "./FileIcons";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { getDragState, startDrag, endDrag } from "../lib/dragContext";
import { showContextMenu } from "../lib/contextMenu";
import { api } from "../lib/tauri";
import type { PaneGroup, Pane } from "../lib/types";

const DRAG_THRESHOLD = 5; // px before drag starts

interface PaneGroupViewProps {
  groupId: string;
  workspaceId: string;
  workspacePath: string;
}

function paneLabel(pane: Pane, isDirty: boolean): string {
  if (pane.type === "claude" || pane.type === "claude-launcher") return pane.title || "claude";
  if (pane.type === "editor" || pane.type === "diff") return isDirty ? `${pane.title} *` : pane.title;
  return "zsh";
}

function paneTooltip(pane: Pane): string {
  if (pane.type === "editor" && pane.filePath) return pane.filePath;
  if (pane.type === "diff" && pane.cwd) return pane.filePath ? `${pane.cwd}/${pane.filePath}` : pane.cwd;
  if (pane.cwd) return pane.cwd;
  return pane.title;
}

// --- Path Picker Popover ---

type PendingAction = {
  type: "terminal" | "claude" | "split-h" | "split-v";
  anchorRect: DOMRect;
};

export function PaneGroupView({
  groupId,
  workspaceId,
  workspacePath,
}: PaneGroupViewProps) {
  // Subscribe to this specific group from the store.
  // This is the key performance optimization: each PaneGroupView only
  // re-renders when ITS OWN group changes, not when other groups change.
  // Previously, all groups re-rendered on any layout change due to prop drilling.
  const group = useWorkspaceStore(
    (s) => s.layouts[workspaceId]?.groups[groupId]
  );
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setActivePane = useWorkspaceStore((s) => s.setActivePane);
  const closePane = useWorkspaceStore((s) => s.closePane);
  const addPaneToGroup = useWorkspaceStore((s) => s.addPaneToGroup);
  const splitGroup = useWorkspaceStore((s) => s.splitGroup);
  const transformPane = useWorkspaceStore((s) => s.transformPane);
  const dropPaneOnGroup = useWorkspaceStore((s) => s.dropPaneOnGroup);
  const dropFileOnGroup = useWorkspaceStore((s) => s.dropFileOnGroup);
  const reorderPanes = useWorkspaceStore((s) => s.reorderPanes);
  const closeGroup = useWorkspaceStore((s) => s.closeGroup);
  const revealFileInExplorer = useWorkspaceStore((s) => s.revealFileInExplorer);
  const dirtyPanes = useWorkspaceStore((s) => s.dirtyPanes);

  const ws = workspaces.find((w) => w.id === workspaceId);
  const paths = ws?.paths ?? [workspacePath];
  const isMultiRoot = paths.length > 1;

  if (!group) return null;

  const activePaneId = group.activePaneId;
  const dragStartRef = useRef<{ x: number; y: number; paneId: string } | null>(null);
  function executeAction(actionType: PendingAction["type"], cwd: string) {
    if (actionType === "terminal") {
      const pane: Pane = {
        id: crypto.randomUUID(),
        type: "terminal",
        title: "Terminal",
        cwd,
      };
      addPaneToGroup(workspaceId, groupId, pane);
    } else if (actionType === "claude") {
      const pane: Pane = {
        id: crypto.randomUUID(),
        type: "claude",
        title: "Claude Code",
        command: "claude --dangerously-skip-permissions",
        cwd,
      };
      addPaneToGroup(workspaceId, groupId, pane);
    } else if (actionType === "split-h") {
      splitGroup(workspaceId, groupId, "horizontal", cwd);
    } else if (actionType === "split-v") {
      splitGroup(workspaceId, groupId, "vertical", cwd);
    }
  }

  function handleAction(actionType: PendingAction["type"], _e: React.MouseEvent) {
    // Always use the active pane's cwd — never show a picker popup
    const activePane = group.panes.find((p) => p.id === activePaneId);
    executeAction(actionType, activePane?.cwd || workspacePath);
  }

  function handleLaunchClaude(paneId: string, cwd?: string) {
    transformPane(workspaceId, groupId, paneId, {
      type: "claude",
      title: "Claude Code",
      command: "claude --dangerously-skip-permissions",
      ...(cwd ? { cwd } : {}),
    });
  }

  function handleLaunchTerminal(paneId: string, cwd?: string) {
    transformPane(workspaceId, groupId, paneId, {
      type: "terminal",
      title: "Terminal",
      ...(cwd ? { cwd } : {}),
    });
  }

  function handleTabMouseDown(e: React.MouseEvent, paneId: string) {
    // Only left click
    if (e.button !== 0) return;
    // Don't start drag from close button
    if ((e.target as HTMLElement).closest("[data-close]")) return;

    e.preventDefault(); // Prevent text selection during drag

    const startX = e.clientX;
    const startY = e.clientY;
    const tabsContainer = (e.currentTarget as HTMLElement).parentElement;
    dragStartRef.current = { x: startX, y: startY, paneId };
    let reordering = false;
    let dropGap = -1;

    // Drop indicator line (VS Code style)
    const indicator = document.createElement("div");
    indicator.style.cssText =
      "position:fixed;width:2px;background:#fff;border-radius:1px;pointer-events:none;z-index:100;display:none;will-change:left;";

    const onMouseMove = (ev: MouseEvent) => {
      ev.preventDefault();
      if (!dragStartRef.current) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;

      if (!reordering && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
        if (Math.abs(dy) > Math.abs(dx) * 1.5 || Math.abs(dy) > 15) {
          startDrag(groupId, dragStartRef.current.paneId, ev.clientX, ev.clientY);
          dragStartRef.current = null;
          indicator.remove();
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);
          return;
        }
        reordering = true;
        document.body.appendChild(indicator);
      }

      // If reordering but cursor has left the tab bar vertically,
      // switch to inter-group drag (VS Code behavior)
      if (reordering && tabsContainer) {
        const barRect = tabsContainer.getBoundingClientRect();
        const TAB_ESCAPE_MARGIN = 12; // px beyond tab bar to trigger switch
        if (ev.clientY < barRect.top - TAB_ESCAPE_MARGIN || ev.clientY > barRect.bottom + TAB_ESCAPE_MARGIN) {
          reordering = false;
          indicator.remove();
          startDrag(groupId, paneId, ev.clientX, ev.clientY);
          dragStartRef.current = null;
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);
          return;
        }
      }

      if (!reordering || !tabsContainer) return;

      const tabEls = Array.from(tabsContainer.children) as HTMLElement[];
      if (tabEls.length === 0) return;
      const cursorX = ev.clientX;

      // Find the gap (between/before/after tabs) closest to cursor.
      // Gap i = the left edge of tab[i], or the right edge of the last tab.
      let bestGap = 0;
      let bestDist = Infinity;

      for (let i = 0; i <= tabEls.length; i++) {
        const gapX = i < tabEls.length
          ? tabEls[i].getBoundingClientRect().left
          : tabEls[tabEls.length - 1].getBoundingClientRect().right;
        const dist = Math.abs(cursorX - gapX);
        if (dist < bestDist) {
          bestDist = dist;
          bestGap = i;
        }
      }

      dropGap = bestGap;

      // Position indicator at the gap
      const gapX = dropGap < tabEls.length
        ? tabEls[dropGap].getBoundingClientRect().left
        : tabEls[tabEls.length - 1].getBoundingClientRect().right;
      const barRect = tabsContainer.getBoundingClientRect();
      indicator.style.display = "block";
      indicator.style.left = `${gapX - 1}px`;
      indicator.style.top = `${barRect.top + 4}px`;
      indicator.style.height = `${barRect.height - 8}px`;
    };

    const onMouseUp = () => {
      dragStartRef.current = null;
      indicator.remove();

      if (reordering && dropGap >= 0) {
        const fromIndex = group.panes.findIndex((p) => p.id === paneId);
        if (fromIndex >= 0) {
          // Convert gap position to array index:
          // gap 0 = before tab[0], gap 1 = before tab[1], etc.
          // Dropping at gap i when i <= fromIndex → toIndex = i
          // Dropping at gap i when i > fromIndex → toIndex = i - 1
          // (because removing the tab shifts everything after it left by 1)
          const toIndex = dropGap > fromIndex ? dropGap - 1 : dropGap;
          if (toIndex !== fromIndex) {
            reorderPanes(workspaceId, groupId, fromIndex, toIndex);
          }
        }
      }

      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  const handleDrop = useCallback(
    (position: DropPosition) => {
      const state = getDragState();
      if (!state.groupId || !state.paneId) return;
      dropPaneOnGroup(workspaceId, state.groupId, state.paneId, groupId, position);
      endDrag();
    },
    [workspaceId, groupId, dropPaneOnGroup]
  );

  const handleFileDrop = useCallback(
    (position: DropPosition, filePaths: string[]) => {
      dropFileOnGroup(workspaceId, groupId, filePaths, position);
      endDrag();
    },
    [workspaceId, groupId, dropFileOnGroup]
  );

  const focusGroup = useCallback(() => {
    const s = useWorkspaceStore.getState();
    if (s.activeGroupIds[workspaceId] !== groupId) {
      useWorkspaceStore.setState({
        activeGroupIds: { ...s.activeGroupIds, [workspaceId]: groupId },
      });
    }
  }, [workspaceId, groupId]);

  return (
    <div style={styles.container} onMouseDown={focusGroup}>
      {/* Tab bar */}
      <div style={styles.tabBar}>
        <div style={styles.tabs}>
          {group.panes.map((pane) => {
            const isActive = pane.id === activePaneId;
            return (
              <div
                key={pane.id}
                className={`pane-tab${isActive ? " pane-tab-active" : ""}`}
                onMouseDown={(e) => handleTabMouseDown(e, pane.id)}
                style={{
                  ...styles.tab,
                  ...(isActive ? styles.tabActive : {}),
                }}
                onClick={() => setActivePane(workspaceId, groupId, pane.id)}
                onDoubleClick={() => {
                  if (pane.type === "editor" && pane.filePath) {
                    revealFileInExplorer(pane.filePath);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const items: Parameters<typeof showContextMenu>[0] = [];
                  if (pane.type === "editor" && pane.filePath) {
                    items.push({
                      label: "Reveal in Finder",
                      action: () => api.revealInFinder(pane.filePath!),
                    });
                    items.push("separator");
                  }
                  if (pane.type === "terminal" || pane.type === "claude") {
                    items.push({
                      label: "Rename Tab",
                      action: () => {
                        const name = window.prompt("Tab name:", pane.title || "");
                        if (name !== null) {
                          transformPane(workspaceId, groupId, pane.id, { title: name });
                        }
                      },
                    });
                    items.push("separator");
                  }
                  items.push({
                    label: "Close Tab",
                    action: () => closePane(workspaceId, groupId, pane.id),
                  });
                  showContextMenu(items);
                }}
                title={paneTooltip(pane)}
              >
                <PaneTabIcon
                  type={pane.type}
                  fileName={pane.title || pane.filePath?.split("/").pop()}
                />
                <span style={styles.tabLabel}>{paneLabel(pane, dirtyPanes.has(pane.id))}</span>
                <button
                  data-close
                  className={`tab-close${isActive ? " tab-close-active" : ""}`}
                  style={styles.tabClose}
                  onClick={(e) => {
                    e.stopPropagation();
                    closePane(workspaceId, groupId, pane.id);
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 14 14" fill="none">
                    <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
        <div style={styles.actions}>
          <button
            className="tab-action"
            style={styles.actionBtn}
            onClick={(e) => handleAction("terminal", e)}
            title="New terminal tab"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className="tab-action"
            style={styles.actionBtn}
            onClick={(e) => handleAction("split-h", e)}
            title="Split right"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="1.5" width="12" height="10.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
              <line x1="7" y1="1.5" x2="7" y2="12" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </button>
          <button
            className="tab-action"
            style={styles.actionBtn}
            onClick={(e) => handleAction("split-v", e)}
            title="Split down"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="1.5" width="12" height="10.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
              <line x1="1" y1="6.75" x2="13" y2="6.75" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </button>
          <button
            className="tab-action"
            style={styles.actionBtn}
            onClick={() => closeGroup(workspaceId, groupId)}
            title="Close panel"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* Pane content — LRU cache: only active + recently-used panes are mounted */}
      <PaneContent
        panes={group.panes}
        activePaneId={activePaneId}
        workspacePath={workspacePath}
        paths={paths}
        workspaceId={workspaceId}
        groupId={groupId}
        transformPane={transformPane}
        handleLaunchClaude={handleLaunchClaude}
        handleLaunchTerminal={handleLaunchTerminal}
      />

      {/* Drop zone target — always mounted, covers full container (incl. tab bar) for earlier activation */}
      <DropZoneTarget groupId={groupId} paneCount={group.panes.length} onDrop={handleDrop} onFileDrop={handleFileDrop} />
    </div>
  );
}

// --- LRU pane mounting ---
// Only mount the active pane + last N recently-used panes.
// Unmounted panes detach their xterm, PTY listeners, and ResizeObservers.
const MAX_CACHED_PANES = 3;

function PaneContent({
  panes,
  activePaneId,
  workspacePath,
  paths,
  workspaceId,
  groupId,
  transformPane,
  handleLaunchClaude,
  handleLaunchTerminal,
}: {
  panes: Pane[];
  activePaneId: string;
  workspacePath: string;
  paths: string[];
  workspaceId: string;
  groupId: string;
  transformPane: (wsId: string, gId: string, pId: string, updates: Partial<Pane>) => void;
  handleLaunchClaude: (paneId: string, cwd?: string) => void;
  handleLaunchTerminal: (paneId: string, cwd?: string) => void;
}) {
  const recentPaneIds = useRef<string[]>([]);

  // Track LRU order — active pane is always most recent
  useEffect(() => {
    recentPaneIds.current = [
      activePaneId,
      ...recentPaneIds.current.filter((id) => id !== activePaneId),
    ].slice(0, MAX_CACHED_PANES);
  }, [activePaneId]);

  // Determine which panes to mount: active + LRU cache, filtered to existing panes
  const existingPaneIds = new Set(panes.map((p) => p.id));
  const mountedPaneIds = new Set(
    recentPaneIds.current.filter((id) => existingPaneIds.has(id))
  );
  // Always include active pane
  mountedPaneIds.add(activePaneId);

  return (
    <div style={styles.content}>
      {panes.length === 0 && (
        <div style={styles.emptyState}>
          <span style={styles.emptyText}>No open tabs</span>
        </div>
      )}
      {panes
        .filter((pane) => mountedPaneIds.has(pane.id))
        .map((pane) => {
          const isActive = pane.id === activePaneId;
          const paneCwd = pane.cwd || workspacePath;
          return (
            <div
              key={pane.id}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                display: "flex",
                flexDirection: "column",
                zIndex: isActive ? 1 : 0,
                visibility: isActive ? "visible" : "hidden",
              }}
            >
              {pane.type === "editor" && pane.filePath ? (
                <EditorPane filePath={pane.filePath} paneId={pane.id} />
              ) : pane.type === "claude-launcher" ? (
                <ClaudeLauncher
                  workspacePath={paneCwd}
                  workspacePaths={paths}
                  onLaunch={(cwd) => handleLaunchClaude(pane.id, cwd)}
                  onLaunchTerminal={(cwd) => handleLaunchTerminal(pane.id, cwd)}
                />
              ) : pane.type === "claude" ? (
                <ClaudeTerminalWrapper cwd={paneCwd} command={pane.command} initialInput={pane.initialInput} ptyId={pane.ptyId}
                  onPtySpawned={(id) => transformPane(workspaceId, groupId, pane.id, { ptyId: id })}
                  onCwdChanged={(newCwd) => transformPane(workspaceId, groupId, pane.id, { cwd: newCwd })} />
              ) : (
                <Terminal cwd={paneCwd} command={pane.command} initialInput={pane.initialInput} ptyId={pane.ptyId}
                  scriptBufferKey={pane.scriptBufferKey}
                  onPtySpawned={(id) => transformPane(workspaceId, groupId, pane.id, { ptyId: id })}
                  onCwdChanged={(newCwd) => transformPane(workspaceId, groupId, pane.id, { cwd: newCwd })} />
              )}
            </div>
          );
        })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    position: "relative",
  },
  tabBar: {
    display: "flex",
    alignItems: "stretch",
    background: "#1a1a1a",
    minHeight: 29,
    maxHeight: 29,
    overflow: "hidden",
    flexShrink: 0,
  },
  tabs: {
    display: "flex",
    flex: 1,
    overflow: "hidden",
    boxShadow: "inset 0 -1px 0 #2d2d2d",
  },
  tab: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "0 2px 0 8px",
    fontSize: 12,
    fontWeight: 500,
    color: "#999",
    cursor: "pointer",
    background: "#1a1a1a",
    border: "none",
    borderRight: "1px solid #2d2d2d",
    boxShadow: "inset 0 -1px 0 #2d2d2d",
    whiteSpace: "nowrap" as const,
    userSelect: "none" as const,
    minWidth: 0,
    transition: "background 0.1s, color 0.1s",
  },
  tabActive: {
    color: "#ddd",
    background: "#1b1b1b",
    boxShadow: "inset 0 1px 0 #4191e0",
    marginBottom: -1,
    paddingBottom: 1,
  },
  tabLabel: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontWeight: 600,
  },
  tabClose: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 18,
    height: 18,
    background: "none",
    border: "none",
    color: "#aaa",
    cursor: "pointer",
    borderRadius: 3,
    flexShrink: 0,
    padding: 0,
    transition: "background 0.06s, color 0.06s",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: 0,
    padding: "0 4px",
    flexShrink: 0,
    boxShadow: "inset 0 -1px 0 #2d2d2d",
  },
  actionBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 24,
    background: "none",
    border: "none",
    color: "#aaa",
    cursor: "pointer",
    fontSize: 12,
    borderRadius: 4,
    transition: "background 0.1s, color 0.1s",
  },
  content: {
    flex: 1,
    position: "relative",
    minHeight: 0,
    minWidth: 0,
  },
  emptyState: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#1a1a1a",
  },
  emptyText: {
    color: "#444",
    fontSize: 13,
    fontWeight: 500,
  },
};
