import React, { useState } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { AddWorkspaceModal } from "./AddWorkspaceModal";
import { SettingsPanel } from "./SettingsPanel";
import { api } from "../lib/tauri";
import { showContextMenu } from "../lib/contextMenu";
export function Sidebar({ width }: { width: number }) {
  const { workspaces, activeWorkspaceId, setActive, removeWorkspace } =
    useWorkspaceStore();
  const [showAddModal, setShowAddModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  function handleDelete(e: React.MouseEvent, wsId: string) {
    e.stopPropagation();
    removeWorkspace(wsId);
  }

  return (
    <>
      <div style={{ ...styles.sidebar, width, minWidth: width }}>
        <div style={styles.header}>
          <span style={styles.title}>Workspaces</span>
        </div>

        <div style={styles.list}>
          {workspaces.map((ws) => {
            const isActive = ws.id === activeWorkspaceId;
            const isHovered = ws.id === hoveredId;

            return (
              <div
                key={ws.id}
                style={{
                  ...styles.item,
                  ...(isActive ? styles.itemActive : {}),
                }}
                onClick={() => setActive(ws.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  showContextMenu([
                    { label: "Reveal in Finder", action: () => api.revealInFinder(ws.paths[0]) },
                  ]);
                }}
                onMouseEnter={() => setHoveredId(ws.id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <div style={styles.itemRow}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={styles.itemName}>{ws.name}</div>
                  </div>
                  {isHovered && (
                    <button
                      style={styles.deleteBtn}
                      onClick={(e) => handleDelete(e, ws.id)}
                      title="Remove workspace"
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div style={styles.bottomBtns}>
          <button style={styles.addBtn} onClick={() => setShowAddModal(true)}>
            + Add Workspace
          </button>
          <button style={styles.settingsBtn} onClick={() => setShowSettings(true)}>
            Settings
          </button>
        </div>
      </div>

      {showAddModal && (
        <AddWorkspaceModal onClose={() => setShowAddModal(false)} />
      )}
      {showSettings && (
        <SettingsPanel onClose={() => setShowSettings(false)} />
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  sidebar: {
    background: "#1a1a1a",
    display: "flex",
    flexDirection: "column",
    paddingTop: 0,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px 8px",
    borderBottom: "1px solid #333",
  },
  title: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    color: "#999",
  },
  list: {
    flex: 1,
    overflow: "auto",
    padding: "4px 0",
  },
  item: {
    width: "100%",
    padding: "10px 16px",
    background: "none",
    borderLeft: "3px solid transparent",
    color: "#ccc",
    cursor: "pointer",
    textAlign: "left" as const,
    fontSize: 13,
  },
  itemActive: {
    background: "#2a2a2a",
    borderLeftColor: "#bbb",
    color: "#fff",
  },
  itemRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  itemName: {
    fontWeight: 600,
  },
  deleteBtn: {
    background: "none",
    border: "none",
    color: "#666",
    cursor: "pointer",
    fontSize: 16,
    lineHeight: 1,
    padding: "2px 4px",
    borderRadius: 3,
    flexShrink: 0,
  },
  bottomBtns: {
    borderTop: "1px solid #333",
  },
  addBtn: {
    width: "100%",
    padding: "8px 16px",
    background: "none",
    border: "none",
    borderBottom: "1px solid #2a2a2a",
    color: "#ccc",
    cursor: "pointer",
    fontSize: 13,
    textAlign: "left" as const,
    fontWeight: 600,
  },
  settingsBtn: {
    width: "100%",
    padding: "8px 16px",
    background: "none",
    border: "none",
    color: "#888",
    cursor: "pointer",
    fontSize: 12,
    textAlign: "left" as const,
    fontWeight: 500,
  },
};
