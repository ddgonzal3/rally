import React, { useCallback, useRef } from "react";
import { Terminal } from "./Terminal";
import { ClaudeLauncher } from "./ClaudeLauncher";
import { ClaudeTerminalWrapper } from "./ClaudeTerminalWrapper";
import { EditorPane } from "./EditorPane";
import { DiffView } from "./DiffView";
import { DropZoneTarget, type DropPosition } from "./DropZoneOverlay";
import { PaneTabIcon } from "./FileIcons";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { getDragState, startDrag, endDrag } from "../lib/dragContext";
import { showContextMenu } from "../lib/contextMenu";
import type { PaneGroup, Pane } from "../lib/types";

const DRAG_THRESHOLD = 5; // px before drag starts

interface PaneGroupViewProps {
  group: PaneGroup;
  workspaceId: string;
  workspacePath: string;
}

function paneLabel(pane: Pane): string {
  if (pane.type === "claude" || pane.type === "claude-launcher") return pane.title || "claude";
  if (pane.type === "editor" || pane.type === "diff") return pane.title;
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
  group,
  workspaceId,
  workspacePath,
}: PaneGroupViewProps) {
  // Use individual selectors — subscribing to the entire store with
  // useWorkspaceStore() caused every pane group (and all terminals/editors
  // inside) to re-render on ANY store change (git polls, ship output, etc.)
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

  const ws = workspaces.find((w) => w.id === workspaceId);
  const paths = ws?.paths ?? [workspacePath];
  const isMultiRoot = paths.length > 1;

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
      addPaneToGroup(workspaceId, group.id, pane);
    } else if (actionType === "claude") {
      const pane: Pane = {
        id: crypto.randomUUID(),
        type: "claude",
        title: "Claude Code",
        command: "claude --dangerously-skip-permissions",
        cwd,
      };
      addPaneToGroup(workspaceId, group.id, pane);
    } else if (actionType === "split-h") {
      splitGroup(workspaceId, group.id, "horizontal", cwd);
    } else if (actionType === "split-v") {
      splitGroup(workspaceId, group.id, "vertical", cwd);
    }
  }

  function handleAction(actionType: PendingAction["type"], _e: React.MouseEvent) {
    // Always use the active pane's cwd — never show a picker popup
    const activePane = group.panes.find((p) => p.id === activePaneId);
    executeAction(actionType, activePane?.cwd || workspacePath);
  }

  function handleLaunchClaude(paneId: string) {
    transformPane(workspaceId, group.id, paneId, {
      type: "claude",
      title: "Claude Code",
      command: "claude --dangerously-skip-permissions",
    });
  }

  function handleLaunchTerminal(paneId: string) {
    transformPane(workspaceId, group.id, paneId, {
      type: "terminal",
      title: "Terminal",
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
          startDrag(group.id, dragStartRef.current.paneId, ev.clientX, ev.clientY);
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
          startDrag(group.id, paneId, ev.clientX, ev.clientY);
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
            reorderPanes(workspaceId, group.id, fromIndex, toIndex);
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
      dropPaneOnGroup(workspaceId, state.groupId, state.paneId, group.id, position);
      endDrag();
    },
    [workspaceId, group.id, dropPaneOnGroup]
  );

  const handleFileDrop = useCallback(
    (position: DropPosition, filePaths: string[]) => {
      dropFileOnGroup(workspaceId, group.id, filePaths, position);
      endDrag();
    },
    [workspaceId, group.id, dropFileOnGroup]
  );

  return (
    <div style={styles.container}>
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
                onClick={() => setActivePane(workspaceId, group.id, pane.id)}
                title={paneTooltip(pane)}
              >
                <PaneTabIcon
                  type={pane.type}
                  fileName={pane.title || pane.filePath?.split("/").pop()}
                />
                <span style={styles.tabLabel}>{paneLabel(pane)}</span>
                <button
                  data-close
                  className="tab-close"
                  style={styles.tabClose}
                  onClick={(e) => {
                    e.stopPropagation();
                    closePane(workspaceId, group.id, pane.id);
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
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
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className="tab-action"
            style={styles.actionBtn}
            onClick={(e) => handleAction("claude", e)}
            title="New Claude Code tab"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M3 12L8 7L3 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M8 13H14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className="tab-action"
            style={styles.actionBtn}
            onClick={(e) => handleAction("split-h", e)}
            title="Split right"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
              <line x1="8" y1="2.5" x2="8" y2="13.5" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
          <button
            className="tab-action"
            style={styles.actionBtn}
            onClick={(e) => handleAction("split-v", e)}
            title="Split down"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
              <line x1="1.5" y1="8" x2="14.5" y2="8" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
          <div style={{ width: 1, height: 14, background: "#333", margin: "0 2px" }} />
          <button
            className="tab-action"
            style={styles.actionBtn}
            onClick={() => closeGroup(workspaceId, group.id)}
            title="Close panel"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* Pane content — all mounted, only active visible */}
      <div style={styles.content}>
        {group.panes.length === 0 && (
          <div style={styles.emptyState}>
            <span style={styles.emptyText}>No open tabs</span>
          </div>
        )}
        {group.panes.map((pane) => {
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
              {pane.type === "diff" && pane.cwd ? (
                pane.filePath ? (
                  <DiffView rootPath={pane.cwd} filePath={pane.filePath} isUntracked={pane.command === "untracked"} />
                ) : (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#555", fontSize: 13 }}>
                    Select a file from the changes list
                  </div>
                )
              ) : pane.type === "editor" && pane.filePath ? (
                <EditorPane filePath={pane.filePath} />
              ) : pane.type === "claude-launcher" ? (
                <ClaudeLauncher
                  workspacePath={paneCwd}
                  onLaunch={() => handleLaunchClaude(pane.id)}
                  onLaunchTerminal={() => handleLaunchTerminal(pane.id)}
                />
              ) : pane.type === "claude" ? (
                <ClaudeTerminalWrapper cwd={paneCwd} command={pane.command} initialInput={pane.initialInput} ptyId={pane.ptyId}
                  onPtySpawned={(id) => transformPane(workspaceId, group.id, pane.id, { ptyId: id })} />
              ) : (
                <Terminal cwd={paneCwd} command={pane.command} initialInput={pane.initialInput} ptyId={pane.ptyId}
                  onPtySpawned={(id) => transformPane(workspaceId, group.id, pane.id, { ptyId: id })} />
              )}
            </div>
          );
        })}

      </div>

      {/* Drop zone target — always mounted, covers full container (incl. tab bar) for earlier activation */}
      <DropZoneTarget groupId={group.id} paneCount={group.panes.length} onDrop={handleDrop} onFileDrop={handleFileDrop} />
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
    minHeight: 28,
    maxHeight: 28,
    overflow: "hidden",
    flexShrink: 0,
  },
  tabs: {
    display: "flex",
    flex: 1,
    overflow: "hidden",
  },
  tab: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "0 2px 0 8px",
    fontSize: 12,
    fontWeight: 500,
    color: "#777",
    cursor: "pointer",
    background: "#1a1a1a",
    border: "none",
    borderRight: "1px solid #2d2d2d",
    whiteSpace: "nowrap" as const,
    userSelect: "none" as const,
    minWidth: 0,
    transition: "background 0.1s, color 0.1s",
  },
  tabActive: {
    color: "#ddd",
    background: "#1e1e1e",
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
    width: 20,
    height: 20,
    background: "none",
    border: "none",
    color: "#555",
    cursor: "pointer",
    borderRadius: 4,
    flexShrink: 0,
    padding: 0,
    transition: "background 0.15s, color 0.15s",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    padding: "0 6px",
    flexShrink: 0,
  },
  actionBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 22,
    background: "none",
    border: "none",
    color: "#777",
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
    overflow: "hidden",
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
