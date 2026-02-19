import React, { useMemo } from "react";
import { Terminal } from "./Terminal";
import { FileExplorer } from "./FileExplorer";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { createDefaultPanes } from "../lib/types";
import type { Pane } from "../lib/types";

export function PaneLayout() {
  const { activeWorkspaceId, workspaces, panes, addPane, removePane } =
    useWorkspaceStore();
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);

  // Get or initialize panes for this workspace
  const currentPanes = useMemo(() => {
    if (!ws) return [];
    const existing = panes[ws.id];
    if (existing && existing.length > 0) return existing;
    return createDefaultPanes(ws.name);
  }, [ws, panes]);

  if (!ws) {
    return (
      <div style={styles.empty}>
        <div style={styles.emptyText}>
          No workspace selected.
          <br />
          Add a workspace from the sidebar to get started.
        </div>
      </div>
    );
  }

  function handleClosePane(paneId: string) {
    if (currentPanes.length <= 1) return; // keep at least one
    removePane(ws!.id, paneId);
  }

  function handleAddTerminal() {
    const newPane: Pane = {
      id: crypto.randomUUID(),
      type: "terminal",
      title: `Terminal — ${ws!.name}`,
    };
    addPane(ws!.id, newPane);
  }

  // Split panes into two rows
  const mid = Math.ceil(currentPanes.length / 2);
  const topRow = currentPanes.slice(0, mid);
  const bottomRow = currentPanes.slice(mid);

  return (
    <div style={styles.container}>
      <div style={styles.row}>
        <div style={styles.explorerPane}>
          <FileExplorer />
        </div>
        {topRow.map((pane) => (
          <div key={pane.id} style={styles.pane}>
            <Terminal
              title={pane.title}
              cwd={ws.path}
              command={pane.command}
              onClose={
                currentPanes.length > 1
                  ? () => handleClosePane(pane.id)
                  : undefined
              }
            />
          </div>
        ))}
      </div>

      {bottomRow.length > 0 && (
        <div style={styles.row}>
          {bottomRow.map((pane) => (
            <div key={pane.id} style={styles.pane}>
              <Terminal
                title={pane.title}
                cwd={ws.path}
                command={pane.command}
                onClose={
                  currentPanes.length > 1
                    ? () => handleClosePane(pane.id)
                    : undefined
                }
              />
            </div>
          ))}
        </div>
      )}

      <button style={styles.addPaneBtn} onClick={handleAddTerminal}>
        + Terminal
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: 4,
    minWidth: 0,
    minHeight: 0,
    position: "relative",
  },
  row: {
    flex: 1,
    display: "flex",
    gap: 4,
    minHeight: 0,
  },
  pane: {
    flex: 1,
    display: "flex",
    minWidth: 0,
    minHeight: 0,
  },
  explorerPane: {
    flex: "0 0 220px",
    display: "flex",
    minWidth: 0,
    minHeight: 0,
  },
  empty: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    textAlign: "center" as const,
    color: "#666",
    fontSize: 14,
    lineHeight: 1.6,
  },
  addPaneBtn: {
    position: "absolute",
    bottom: 8,
    right: 8,
    padding: "4px 10px",
    background: "#2a2a2a",
    border: "1px solid #3a3a3a",
    borderRadius: 4,
    color: "#7c6ef5",
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 500,
    zIndex: 10,
  },
};
