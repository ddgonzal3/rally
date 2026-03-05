import React, { useCallback, useEffect, useRef, useMemo } from "react";
import { Terminal } from "./Terminal";
import { ClaudeLauncher } from "./ClaudeLauncher";
import { ClaudeTerminalWrapper } from "./ClaudeTerminalWrapper";
import { EditorPane } from "./EditorPane";
import { WebViewPane } from "./WebViewPane";

import { TerminalLauncher } from "./TerminalLauncher";
import { DropZoneTarget, type DropPosition } from "./DropZoneOverlay";
import { PaneTabIcon, FileIcon } from "./FileIcons";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { getDragState, startDrag, endDrag } from "../lib/dragContext";
import { showContextMenu } from "../lib/contextMenu";
import { api } from "../lib/tauri";
import { openInNewWindow } from "../lib/windowUtils";
import type { PaneGroup, Pane, DetectedPort } from "../lib/types";
import type { OnFileOpen } from "../lib/terminalLinkProvider";
import {
  REQUEST_NEW_TERMINAL_CWD_EVENT,
  type RequestNewTerminalCwdDetail,
} from "../lib/events";

const DRAG_THRESHOLD = 5; // px before drag starts

/** Returns true if the pane has a live terminal session that should prompt before closing. */
function paneHasActiveSession(pane: Pane | undefined): boolean {
  if (!pane) return false;
  return !!(pane.ptyId && (pane.type === "claude" || pane.type === "terminal"));
}

interface PaneGroupViewProps {
  groupId: string;
  workspaceId: string;
  workspacePath: string;
  isBottomPanel?: boolean;
}

/** Check if a terminal title indicates Claude Code is running. */
function isClaudeCodeTitle(title: string): boolean {
  const lower = title.toLowerCase();
  return lower === "claude" || lower.startsWith("claude ");
}

function paneLabel(
  pane: Pane,
  isDirty: boolean,
  workspacePath?: string,
): string {
  // User-set custom title always takes priority for renamable pane types
  if (
    pane.customTitle &&
    (pane.type === "terminal" ||
      pane.type === "claude" ||
      pane.type === "claude-launcher")
  ) {
    return pane.customTitle;
  }
  if (pane.type === "claude-launcher") {
    const cwd = pane.cwd || workspacePath || "";
    return cwd.split("/").pop() || "Claude Code";
  }
  if (pane.type === "claude") {
    const cwd = pane.cwd || workspacePath || "";
    return cwd.split("/").pop() || "claude";
  }
  if (pane.type === "webview") return pane.title;
  if (pane.type === "editor" || pane.type === "diff")
    return isDirty ? `${pane.title} *` : pane.title;
  if (pane.type === "terminal" && isClaudeCodeTitle(pane.title)) {
    const cwd = pane.cwd || workspacePath || "";
    return cwd.split("/").pop() || "claude";
  }
  if (pane.type === "terminal") {
    const cwd = pane.cwd || workspacePath || "";
    return cwd.split("/").pop() || "zsh";
  }
  return "zsh";
}

function paneTooltip(pane: Pane): string {
  if (pane.type === "editor" && pane.filePath) return pane.filePath;
  if (pane.type === "webview" && pane.webviewUrl) return pane.webviewUrl;
  if (pane.type === "diff" && pane.cwd)
    return pane.filePath ? `${pane.cwd}/${pane.filePath}` : pane.cwd;
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
  isBottomPanel,
}: PaneGroupViewProps) {
  // Subscribe to this specific group from the store.
  // This is the key performance optimization: each PaneGroupView only
  // re-renders when ITS OWN group changes, not when other groups change.
  // Previously, all groups re-rendered on any layout change due to prop drilling.
  const group = useWorkspaceStore(
    (s) => s.layouts[workspaceId]?.groups[groupId],
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
  const setEditorViewMode = useWorkspaceStore((s) => s.setEditorViewMode);
  const detectedPortsJson = useWorkspaceStore((s) =>
    JSON.stringify(s.detectedPorts[workspaceId] ?? []),
  );
  const detectedPorts: DetectedPort[] = useMemo(
    () => JSON.parse(detectedPortsJson),
    [detectedPortsJson],
  );
  const openWebView = useWorkspaceStore((s) => s.openWebView);
  const bottomCollapsed = useWorkspaceStore(
    (s) => isBottomPanel ? !!s.bottomPanelCollapsed[workspaceId] : false,
  );
  const toggleBottomPanel = useWorkspaceStore((s) => s.toggleBottomPanel);

  const ws = workspaces.find((w) => w.id === workspaceId);
  const paths = ws?.paths ?? [workspacePath];
  const isMultiRoot = paths.length > 1;

  // Close pane directly (X button) — no confirmation needed.
  // Cmd+W confirmation is handled in App.tsx separately.
  const handleClosePane = useCallback(
    (paneId: string) => {
      closePane(workspaceId, groupId, paneId);
    },
    [closePane, workspaceId, groupId],
  );

  if (!group) return null;

  const activePaneId = group.activePaneId;
  const dragStartRef = useRef<{ x: number; y: number; paneId: string } | null>(
    null,
  );

  // Inline tab rename state
  const [renamingPaneId, setRenamingPaneId] = React.useState<string | null>(
    null,
  );
  const [renameValue, setRenameValue] = React.useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  function startRename(pane: Pane) {
    if (
      pane.type !== "terminal" &&
      pane.type !== "claude" &&
      pane.type !== "claude-launcher"
    )
      return;
    setRenamingPaneId(pane.id);
    setRenameValue(pane.customTitle || paneLabel(pane, false, workspacePath));
  }

  function commitRename(paneId: string) {
    const trimmed = renameValue.trim();
    if (trimmed) {
      transformPane(workspaceId, groupId, paneId, { customTitle: trimmed });
    }
    setRenamingPaneId(null);
  }

  function cancelRename() {
    setRenamingPaneId(null);
  }

  // Focus and select text when entering rename mode
  useEffect(() => {
    if (renamingPaneId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingPaneId]);
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

  function handleAction(actionType: PendingAction["type"]) {
    if (actionType === "terminal") {
      window.dispatchEvent(
        new CustomEvent<RequestNewTerminalCwdDetail>(
          REQUEST_NEW_TERMINAL_CWD_EVENT,
          { detail: { workspaceId, groupId } },
        ),
      );
      return;
    }

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
      "position:fixed;width:2px;background:var(--text-primary);border-radius:1px;pointer-events:none;z-index:100;display:none;will-change:left;";

    const onMouseMove = (ev: MouseEvent) => {
      ev.preventDefault();
      if (!dragStartRef.current) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;

      if (
        !reordering &&
        (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)
      ) {
        if (Math.abs(dy) > Math.abs(dx) * 1.5 || Math.abs(dy) > 15) {
          startDrag(
            groupId,
            dragStartRef.current.paneId,
            ev.clientX,
            ev.clientY,
          );
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
        if (
          ev.clientY < barRect.top - TAB_ESCAPE_MARGIN ||
          ev.clientY > barRect.bottom + TAB_ESCAPE_MARGIN
        ) {
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
        const gapX =
          i < tabEls.length
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
      const gapX =
        dropGap < tabEls.length
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
      dropPaneOnGroup(
        workspaceId,
        state.groupId,
        state.paneId,
        groupId,
        position,
      );
      endDrag();
    },
    [workspaceId, groupId, dropPaneOnGroup],
  );

  const handleFileDrop = useCallback(
    (position: DropPosition, filePaths: string[]) => {
      dropFileOnGroup(workspaceId, groupId, filePaths, position);
      endDrag();
    },
    [workspaceId, groupId, dropFileOnGroup],
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
    <div
      style={styles.container}
      onMouseDown={focusGroup}
      data-group-id={groupId}
    >
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
                onClick={() => {
                  setActivePane(workspaceId, groupId, pane.id);
                  if (bottomCollapsed) toggleBottomPanel(workspaceId);
                }}
                onDoubleClick={() => {
                  if (
                    pane.type === "terminal" ||
                    pane.type === "claude" ||
                    pane.type === "claude-launcher"
                  ) {
                    startRename(pane);
                  } else if (pane.type === "editor" && pane.filePath) {
                    revealFileInExplorer(pane.filePath);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const items: Parameters<typeof showContextMenu>[0] = [];
                  // Copy Path — available for any pane with a file path or cwd
                  const copyablePath = pane.filePath || pane.cwd;
                  if (copyablePath) {
                    items.push({
                      label: "Copy Path",
                      action: () => navigator.clipboard.writeText(copyablePath),
                    });
                  }
                  if (pane.type === "editor" && pane.filePath) {
                    items.push({
                      label: "Reveal in Finder",
                      action: () => api.revealInFinder(pane.filePath!),
                    });
                    items.push({
                      label: "Open in New Window",
                      action: () => openInNewWindow(pane.filePath!, pane.title),
                    });
                  }
                  if (pane.type === "webview" && pane.webviewUrl) {
                    items.push({
                      label: "Open in New Window",
                      action: () => openInNewWindow(pane.webviewUrl!, pane.title),
                    });
                  }
                  if (
                    items.length > 0 &&
                    (pane.type === "terminal" ||
                      pane.type === "claude" ||
                      pane.type === "claude-launcher" ||
                      (pane.type === "editor" && pane.filePath))
                  ) {
                    items.push("separator");
                  }
                  if (
                    pane.type === "terminal" ||
                    pane.type === "claude" ||
                    pane.type === "claude-launcher"
                  ) {
                    items.push({
                      label: "Rename Tab",
                      action: () => startRename(pane),
                    });
                    if (pane.customTitle) {
                      items.push({
                        label: "Reset Tab Name",
                        action: () =>
                          transformPane(workspaceId, groupId, pane.id, {
                            customTitle: undefined,
                          }),
                      });
                    }
                    items.push("separator");
                  }
                  {/* Detected ports — open in webview or new window */}
                  const panePorts = pane.ptyId
                    ? detectedPorts.filter((p) => p.source.type === "pane" && p.source.ptyId === pane.ptyId)
                    : [];
                  if (panePorts.length > 0) {
                    for (const dp of panePorts) {
                      items.push({
                        label: `Open :${dp.port} in Pane`,
                        action: () => openWebView(workspaceId, dp.url),
                      });
                      items.push({
                        label: `Open :${dp.port} in New Window`,
                        action: () => openInNewWindow(dp.url, `localhost:${dp.port}`),
                      });
                    }
                    items.push("separator");
                  }
                  items.push({
                    label: "Close Tab",
                    action: () => handleClosePane(pane.id),
                  });
                  showContextMenu(items);
                }}
                title={paneTooltip(pane)}
              >
                <PaneTabIcon
                  type={pane.type}
                  fileName={pane.title || pane.filePath?.split("/").pop()}
                  terminalTitle={
                    pane.type === "terminal" ? pane.title : undefined
                  }
                />
                {renamingPaneId === pane.id ? (
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename(pane.id);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelRename();
                      }
                      e.stopPropagation();
                    }}
                    onBlur={() => commitRename(pane.id)}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    size={Math.max(renameValue.length, 4)}
                    style={{
                      background: "var(--bg-hover)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: 3,
                      color: "var(--text-primary)",
                      outline: "none",
                      padding: "0 4px",
                      margin: "-1px 0",
                      fontSize: "inherit",
                      fontFamily: "inherit",
                      fontWeight: "inherit",
                      width: "auto",
                      minWidth: 40,
                      maxWidth: 160,
                    }}
                    autoFocus
                  />
                ) : (
                  <span style={styles.tabLabel}>
                    {paneLabel(pane, dirtyPanes.has(pane.id), workspacePath)}
                  </span>
                )}
                {/* Port pills for terminals with detected localhost servers */}
                {pane.ptyId && detectedPorts
                  .filter((p) => p.source.type === "pane" && p.source.ptyId === pane.ptyId)
                  .map((p) => (
                    <span
                      key={p.port}
                      onClick={(e) => {
                        e.stopPropagation();
                        openWebView(workspaceId, p.url);
                      }}
                      title={`Open ${p.url}`}
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        color: "var(--status-green)",
                        cursor: "pointer",
                        marginLeft: 4,
                        flexShrink: 0,
                      }}
                    >
                      :{p.port}
                    </span>
                  ))}
                <div style={styles.tabActions}>
                  {isActive &&
                    pane.type === "editor" &&
                    pane.filePath?.toLowerCase().endsWith(".md") &&
                    (() => {
                      const mode = pane.editorViewMode ?? "raw";
                      return (
                        <>
                          <button
                            data-close
                            className="tab-close tab-close-active"
                            style={{
                              ...styles.mdTabBtn,
                              ...styles.tabActionActive,
                              marginLeft: 2,
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditorViewMode(
                                workspaceId,
                                groupId,
                                pane.id,
                                mode === "raw" ? "preview" : "raw",
                              );
                            }}
                            title={mode === "raw" ? "Preview" : "Raw editor"}
                          >
                            {mode === "raw" ? (
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 16 16"
                                fill="none"
                              >
                                <path
                                  d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"
                                  stroke="currentColor"
                                  strokeWidth="1.3"
                                  strokeLinejoin="round"
                                />
                                <circle
                                  cx="8"
                                  cy="8"
                                  r="2"
                                  stroke="currentColor"
                                  strokeWidth="1.3"
                                />
                              </svg>
                            ) : (
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 16 16"
                                fill="none"
                              >
                                <path
                                  d="M5.5 3L1.5 8l4 5M10.5 3l4 5-4 5"
                                  stroke="currentColor"
                                  strokeWidth="1.3"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            )}
                          </button>
                          <button
                            data-close
                            className="tab-close tab-close-active"
                            style={{
                              ...styles.mdTabBtn,
                              ...styles.tabActionActive,
                              ...(mode === "split"
                                ? { color: "var(--text-primary)" }
                                : {}),
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditorViewMode(
                                workspaceId,
                                groupId,
                                pane.id,
                                mode === "split" ? "raw" : "split",
                              );
                            }}
                            title={
                              mode === "split" ? "Exit split" : "Split view"
                            }
                          >
                            <svg
                              width="13"
                              height="13"
                              viewBox="0 0 16 16"
                              fill="none"
                            >
                              <path
                                fillRule="evenodd"
                                clipRule="evenodd"
                                d="M3 1h11l1 1v5.3a3.21 3.21 0 0 0-1-.3V2H9v10.88L7.88 14H3l-1-1V2l1-1zm0 12h5V2H3v11zm10.379-4.998a2.53 2.53 0 0 0-1.19.348h-.03a2.51 2.51 0 0 0-.799 3.53L9 14.23l.71.71 2.35-2.36c.325.22.7.358 1.09.4a2.47 2.47 0 0 0 1.14-.13 2.51 2.51 0 0 0 1-.63 2.46 2.46 0 0 0 .58-1 2.63 2.63 0 0 0 .07-1.15 2.53 2.53 0 0 0-1.35-1.81 2.53 2.53 0 0 0-1.211-.258zm.24 3.992a1.5 1.5 0 0 1-.979-.244 1.55 1.55 0 0 1-.56-.68 1.49 1.49 0 0 1-.08-.86 1.49 1.49 0 0 1 1.18-1.18 1.49 1.49 0 0 1 .86.08c.276.117.512.311.68.56a1.5 1.5 0 0 1-1.1 2.324z"
                                fill="currentColor"
                              />
                            </svg>
                          </button>
                        </>
                      );
                    })()}
                  <button
                    data-close
                    className={`tab-close${isActive ? " tab-close-active" : ""}`}
                    style={{
                      ...styles.tabClose,
                      ...(isActive ? styles.tabActionActive : {}),
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleClosePane(pane.id);
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
                      <path
                        d="M3 2.75l8 9.5M11 2.75l-8 9.5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div style={styles.actions}>
          {!bottomCollapsed && (
            <>
              <button
                className="tab-action"
                style={styles.actionBtn}
                onClick={() => handleAction("terminal")}
                title="New terminal tab"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path
                    d="M7 1v12M1 7h12"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <button
                className="tab-action"
                style={styles.actionBtn}
                onClick={() => handleAction("split-h")}
                title="Split right"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <rect
                    x="1"
                    y="1.5"
                    width="12"
                    height="10.5"
                    rx="1.5"
                    stroke="currentColor"
                    strokeWidth="1.3"
                  />
                  <line
                    x1="7"
                    y1="1.5"
                    x2="7"
                    y2="12"
                    stroke="currentColor"
                    strokeWidth="1.3"
                  />
                </svg>
              </button>
              <button
                className="tab-action"
                style={styles.actionBtn}
                onClick={() => handleAction("split-v")}
                title="Split down"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <rect
                    x="1"
                    y="1.5"
                    width="12"
                    height="10.5"
                    rx="1.5"
                    stroke="currentColor"
                    strokeWidth="1.3"
                  />
                  <line
                    x1="1"
                    y1="6.75"
                    x2="13"
                    y2="6.75"
                    stroke="currentColor"
                    strokeWidth="1.3"
                  />
                </svg>
              </button>
            </>
          )}
          {isBottomPanel && (
            <button
              className="tab-action"
              style={styles.actionBtn}
              onClick={() => toggleBottomPanel(workspaceId)}
              title={bottomCollapsed ? "Expand panel (Ctrl+`)" : "Collapse panel (Ctrl+`)"}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path
                  d={bottomCollapsed
                    ? "M3 9l4-4 4 4"
                    : "M3 5l4 4 4-4"
                  }
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Breadcrumb path bar — only for editor panes */}
      <BreadcrumbBar
        panes={group.panes}
        activePaneId={activePaneId}
        workspacePaths={paths}
      />

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
        onLaunchTerminalAt={(cwd?: string) =>
          executeAction("terminal", cwd || workspacePath)
        }
        onLaunchClaudeAt={(cwd?: string) =>
          executeAction("claude", cwd || workspacePath)
        }
        handleFileOpen={useCallback<OnFileOpen>(
          (path, line, col) => {
            useWorkspaceStore
              .getState()
              .openFile(workspaceId, path, { line, col });
          },
          [workspaceId],
        )}
      />

      {/* Drop zone target — always mounted, covers full container (incl. tab bar) for earlier activation */}
      <DropZoneTarget
        groupId={groupId}
        paneCount={group.panes.length}
        activeIsTerminal={(() => {
          const ap = group.panes.find((p) => p.id === activePaneId);
          return !!(
            ap?.ptyId &&
            (ap.type === "terminal" || ap.type === "claude")
          );
        })()}
        onDrop={handleDrop}
        onFileDrop={handleFileDrop}
      />
    </div>
  );
}

// --- Breadcrumb path bar ---

function BreadcrumbBar({
  panes,
  activePaneId,
  workspacePaths,
}: {
  panes: Pane[];
  activePaneId: string;
  workspacePaths: string[];
}) {
  const activePane = panes.find((p) => p.id === activePaneId);
  if (!activePane || activePane.type !== "editor" || !activePane.filePath)
    return null;

  const filePath = activePane.filePath;

  // Find which workspace root this file belongs to
  const matchingRoot = workspacePaths.find((p) => filePath.startsWith(p + "/"));
  if (!matchingRoot) return null;

  const rootName = matchingRoot.split("/").pop() ?? matchingRoot;
  const relativePath = filePath.slice(matchingRoot.length + 1);
  const segments = relativePath.split("/");

  const isFile = (i: number) => i === segments.length - 1;

  return (
    <div style={bcStyles.bar}>
      <svg
        width="18"
        height="13"
        viewBox="0 0 18 14"
        fill="none"
        style={{ flexShrink: 0, position: "relative", top: 1 }}
      >
        <path
          d="M1.5 3C1.5 2.17 2.17 1.5 3 1.5H6.5L8.5 3.5H14.5C15.33 3.5 16 4.17 16 5V11C16 11.83 15.33 12.5 14.5 12.5H3C2.17 12.5 1.5 11.83 1.5 11Z"
          stroke="var(--text-secondary)"
          strokeWidth="1.2"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
      <span style={bcStyles.segment}>{rootName}</span>
      {segments.map((seg, i) => (
        <React.Fragment key={i}>
          <svg
            style={bcStyles.chevron}
            width="16"
            height="16"
            viewBox="0 0 16 16"
          >
            <path
              d="M6 4l4 4-4 4"
              stroke="currentColor"
              strokeWidth="1.2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {isFile(i) && <FileIcon name={seg} isDir={false} />}
          <span
            style={{
              ...bcStyles.segment,
              ...(isFile(i) ? bcStyles.activeSegment : {}),
            }}
          >
            {seg}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

const bcStyles: Record<string, React.CSSProperties> = {
  bar: {
    display: "flex",
    alignItems: "center",
    gap: 3,
    height: 22,
    minHeight: 22,
    maxHeight: 22,
    padding: "0 8px",
    background: "var(--bg-app)",
    overflow: "hidden",
    flexShrink: 0,
  },
  segment: {
    fontSize: 13,
    fontWeight: 560,
    color: "var(--text-secondary)",
    whiteSpace: "nowrap" as const,
    cursor: "default",
  },
  activeSegment: {},
  chevron: {
    color: "var(--text-dim)",
    flexShrink: 0,
    margin: "0 1px",
  },
};

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
  onLaunchTerminalAt,
  onLaunchClaudeAt,
  handleFileOpen,
}: {
  panes: Pane[];
  activePaneId: string;
  workspacePath: string;
  paths: string[];
  workspaceId: string;
  groupId: string;
  transformPane: (
    wsId: string,
    gId: string,
    pId: string,
    updates: Partial<Pane>,
  ) => void;
  handleLaunchClaude: (paneId: string, cwd?: string) => void;
  handleLaunchTerminal: (paneId: string, cwd?: string) => void;
  onLaunchTerminalAt: (cwd?: string) => void;
  onLaunchClaudeAt: (cwd?: string) => void;
  handleFileOpen: OnFileOpen;
}) {
  const recentPaneIds = useRef<string[]>([]);
  const contentRef = useRef<HTMLDivElement>(null);
  const prevPaneCountRef = useRef(panes.length);

  // Track LRU order — active pane is always most recent
  useEffect(() => {
    recentPaneIds.current = [
      activePaneId,
      ...recentPaneIds.current.filter((id) => id !== activePaneId),
    ].slice(0, MAX_CACHED_PANES);
  }, [activePaneId]);

  // Auto-focus the active terminal when a pane is closed within this group
  useEffect(() => {
    const prevCount = prevPaneCountRef.current;
    prevPaneCountRef.current = panes.length;
    if (panes.length < prevCount && activePaneId && contentRef.current) {
      requestAnimationFrame(() => {
        const textarea = contentRef.current?.querySelector(
          "textarea.xterm-helper-textarea",
        ) as HTMLTextAreaElement | null;
        textarea?.focus();
      });
    }
  }, [panes.length, activePaneId]);

  // Auto-focus when a sibling group is closed and this group survives
  useEffect(() => {
    function handleFocusGroup(e: Event) {
      const targetId = (e as CustomEvent).detail;
      if (targetId === groupId && contentRef.current) {
        requestAnimationFrame(() => {
          const textarea = contentRef.current?.querySelector(
            "textarea.xterm-helper-textarea",
          ) as HTMLTextAreaElement | null;
          textarea?.focus();
        });
      }
    }
    window.addEventListener("rally-focus-group", handleFocusGroup);
    return () =>
      window.removeEventListener("rally-focus-group", handleFocusGroup);
  }, [groupId]);

  // Determine which panes to mount: active + LRU cache, filtered to existing panes
  const existingPaneIds = new Set(panes.map((p) => p.id));
  const mountedPaneIds = new Set(
    recentPaneIds.current.filter((id) => existingPaneIds.has(id)),
  );
  // Always include active pane
  mountedPaneIds.add(activePaneId);

  return (
    <div ref={contentRef} style={styles.content}>
      {panes.length === 0 && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            display: "flex",
          }}
        >
          <TerminalLauncher
            workspacePath={workspacePath}
            workspacePaths={paths}
            onLaunch={onLaunchTerminalAt}
            onLaunchClaude={onLaunchClaudeAt}
          />
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
                contain: "layout paint",
              }}
            >
              {pane.type === "webview" && pane.webviewUrl ? (
                <WebViewPane url={pane.webviewUrl} paneId={pane.id} />
              ) : pane.type === "editor" && pane.filePath ? (
                <EditorPane filePath={pane.filePath} paneId={pane.id} workspaceId={workspaceId} groupId={groupId} />
              ) : pane.type === "claude-launcher" ? (
                <ClaudeLauncher
                  workspacePath={paneCwd}
                  workspacePaths={paths}
                  onLaunch={(cwd) => handleLaunchClaude(pane.id, cwd)}
                  onLaunchTerminal={(cwd) => handleLaunchTerminal(pane.id, cwd)}
                />
              ) : pane.type === "claude" ? (
                <ClaudeTerminalWrapper
                  cwd={paneCwd}
                  command={pane.command}
                  initialInput={pane.initialInput}
                  ptyId={pane.ptyId}
                  workspaceId={workspaceId}
                  onPtySpawned={(id) =>
                    transformPane(workspaceId, groupId, pane.id, { ptyId: id })
                  }
                  onCwdChanged={(newCwd) =>
                    transformPane(workspaceId, groupId, pane.id, {
                      cwd: newCwd,
                    })
                  }
                  onFileOpen={handleFileOpen}
                />
              ) : (
                <Terminal
                  cwd={paneCwd}
                  command={pane.command}
                  initialInput={pane.initialInput}
                  ptyId={pane.ptyId}
                  scriptBufferKey={pane.scriptBufferKey}
                  workspaceId={workspaceId}
                  onPtySpawned={(id) =>
                    transformPane(workspaceId, groupId, pane.id, { ptyId: id })
                  }
                  onCwdChanged={(newCwd) =>
                    transformPane(workspaceId, groupId, pane.id, {
                      cwd: newCwd,
                    })
                  }
                  onTitleChange={(title) =>
                    transformPane(workspaceId, groupId, pane.id, {
                      title,
                    })
                  }
                  onFileOpen={handleFileOpen}
                />
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
    background: "var(--bg-surface)",
    minHeight: 29,
    maxHeight: 29,
    overflow: "hidden",
    flexShrink: 0,
  },
  tabs: {
    display: "flex",
    flex: 1,
    overflow: "hidden",
    boxShadow: "inset 0 -1px 0 var(--bg-elevated)",
  },
  tab: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    padding: "0 2px 0 6px",
    fontSize: 14,
    fontWeight: 500,
    color: "var(--text-dim)",
    cursor: "pointer",
    background: "var(--bg-surface)",
    borderTop: "1px solid transparent",
    borderBottom: "none",
    borderLeft: "none",
    borderRight: "1px solid var(--bg-elevated)",
    boxShadow: "inset 0 -1px 0 var(--bg-elevated)",
    whiteSpace: "nowrap" as const,
    userSelect: "none" as const,
    minWidth: 0,
    transition: "background 0.1s, color 0.1s",
  },
  tabActive: {
    color: "var(--text-primary)",
    background: "var(--bg-app)",
    borderTop: "1px solid var(--tab-indicator)",
    boxShadow: "none",
    marginBottom: -1,
    paddingBottom: 1,
  },
  tabLabel: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontWeight: 600,
  },
  tabActions: {
    display: "flex",
    alignItems: "center",
    gap: 0,
    flexShrink: 0,
    marginLeft: -3,
  },
  tabClose: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 24,
    background: "none",
    border: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
    borderRadius: 4,
    flexShrink: 0,
    marginLeft: -1,
    padding: 0,
    transition: "background 0.06s, color 0.06s",
  },
  mdTabBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 21,
    height: 21,
    background: "none",
    border: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
    borderRadius: 4,
    flexShrink: 0,
    marginRight: -1,
    padding: 0,
    transition: "background 0.06s, color 0.06s",
  },
  tabActionActive: {
    color: "var(--text-primary)",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: 0,
    padding: "0 4px",
    flexShrink: 0,
    boxShadow: "inset 0 -1px 0 var(--bg-elevated)",
  },
  actionBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 26,
    background: "none",
    border: "none",
    color: "var(--text-dim)",
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
};
