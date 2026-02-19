import React, { useCallback, useRef } from "react";
import { Terminal } from "./Terminal";
import { ClaudeLauncher } from "./ClaudeLauncher";
import { DropZoneTarget, type DropPosition } from "./DropZoneOverlay";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { getDragState, startDrag, endDrag } from "../lib/dragContext";
import type { PaneGroup, Pane } from "../lib/types";

const DRAG_THRESHOLD = 5; // px before drag starts

interface PaneGroupViewProps {
  group: PaneGroup;
  workspaceId: string;
  workspacePath: string;
}

function paneLabel(pane: Pane): string {
  if (pane.type === "claude" || pane.type === "claude-launcher") return "claude";
  return "zsh";
}

export function PaneGroupView({
  group,
  workspaceId,
  workspacePath,
}: PaneGroupViewProps) {
  const {
    setActivePane,
    closePane,
    addPaneToGroup,
    splitGroup,
    transformPane,
    dropPaneOnGroup,
  } = useWorkspaceStore();

  const activePaneId = group.activePaneId;
  const dragStartRef = useRef<{ x: number; y: number; paneId: string } | null>(null);

  function handleAddTerminal() {
    const pane: Pane = {
      id: crypto.randomUUID(),
      type: "terminal",
      title: "Terminal",
    };
    addPaneToGroup(workspaceId, group.id, pane);
  }

  function handleAddClaude() {
    const pane: Pane = {
      id: crypto.randomUUID(),
      type: "claude",
      title: "Claude Code",
      command: "claude --dangerously-skip-permissions",
    };
    addPaneToGroup(workspaceId, group.id, pane);
  }

  function handleLaunchClaude(paneId: string) {
    transformPane(workspaceId, group.id, paneId, {
      type: "claude",
      title: "Claude Code",
      command: "claude --dangerously-skip-permissions",
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
    dragStartRef.current = { x: startX, y: startY, paneId };

    const onMouseMove = (ev: MouseEvent) => {
      ev.preventDefault();
      if (!dragStartRef.current) return;
      const dx = ev.clientX - dragStartRef.current.x;
      const dy = ev.clientY - dragStartRef.current.y;
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
        // Exceeded threshold — start the drag
        startDrag(group.id, dragStartRef.current.paneId, ev.clientX, ev.clientY);
        dragStartRef.current = null;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      }
    };

    const onMouseUp = () => {
      dragStartRef.current = null;
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
                onMouseDown={(e) => handleTabMouseDown(e, pane.id)}
                style={{
                  ...styles.tab,
                  ...(isActive ? styles.tabActive : {}),
                }}
                onClick={() => setActivePane(workspaceId, group.id, pane.id)}
              >
                <span style={styles.tabLabel}>{paneLabel(pane)}</span>
                <span
                  data-close
                  style={styles.tabClose}
                  onClick={(e) => {
                    e.stopPropagation();
                    closePane(workspaceId, group.id, pane.id);
                  }}
                >
                  ×
                </span>
              </div>
            );
          })}
        </div>
        <div style={styles.actions}>
          <button
            style={styles.actionBtn}
            onClick={handleAddTerminal}
            title="New terminal tab"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <button
            style={styles.actionBtn}
            onClick={handleAddClaude}
            title="New Claude Code tab"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M3 12L8 7L3 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M8 13H14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <button
            style={styles.actionBtn}
            onClick={() => splitGroup(workspaceId, group.id, "horizontal")}
            title="Split right"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
              <line x1="8" y1="2.5" x2="8" y2="13.5" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
          <button
            style={styles.actionBtn}
            onClick={() => splitGroup(workspaceId, group.id, "vertical")}
            title="Split down"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
              <line x1="1.5" y1="8" x2="14.5" y2="8" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
        </div>
      </div>

      {/* Pane content — all mounted, only active visible */}
      <div style={styles.content}>
        {group.panes.map((pane) => {
          const isActive = pane.id === activePaneId;
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
              {pane.type === "claude-launcher" ? (
                <ClaudeLauncher
                  workspacePath={workspacePath}
                  onLaunch={() => handleLaunchClaude(pane.id)}
                />
              ) : (
                <Terminal cwd={workspacePath} command={pane.command} />
              )}
            </div>
          );
        })}

        {/* Drop zone target — always mounted for hit testing */}
        <DropZoneTarget groupId={group.id} paneCount={group.panes.length} onDrop={handleDrop} />
      </div>
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
  },
  tabBar: {
    display: "flex",
    alignItems: "flex-end",
    background: "#252525",
    minHeight: 30,
    maxHeight: 30,
    overflow: "hidden",
    flexShrink: 0,
    paddingLeft: 4,
    paddingTop: 2,
  },
  tabs: {
    display: "flex",
    flex: 1,
    overflow: "hidden",
    gap: 1,
  },
  tab: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 12px",
    fontSize: 12,
    fontWeight: 500,
    color: "#777",
    cursor: "grab",
    background: "#252525",
    border: "none",
    borderRadius: "6px 6px 0 0",
    whiteSpace: "nowrap" as const,
    userSelect: "none" as const,
    minWidth: 0,
    transition: "background 0.1s, color 0.1s",
  },
  tabActive: {
    color: "#ddd",
    background: "#1a1a1a",
  },
  tabLabel: {
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  tabClose: {
    color: "#555",
    cursor: "pointer",
    fontSize: 14,
    lineHeight: 1,
    flexShrink: 0,
    borderRadius: 3,
    padding: "0 2px",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    padding: "0 8px 4px",
    flexShrink: 0,
  },
  actionBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 26,
    height: 26,
    background: "none",
    border: "none",
    color: "#777",
    cursor: "pointer",
    fontSize: 13,
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
};
