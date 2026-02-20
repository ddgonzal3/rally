import React, { useState } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { AddWorkspaceModal } from "./AddWorkspaceModal";
import { SettingsPanel } from "./SettingsPanel";
import { api } from "../lib/tauri";
import { showContextMenu } from "../lib/contextMenu";
export function Sidebar() {
  const { workspaces, activeWorkspaceId, setActive, removeWorkspace } =
    useWorkspaceStore();
  const [showAddModal, setShowAddModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  return (
    <>
      <div style={styles.sidebar}>
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
                  ...(!isActive && isHovered ? styles.itemHover : {}),
                }}
                onClick={() => setActive(ws.id)}
                onMouseEnter={() => setHoveredId(ws.id)}
                onMouseLeave={() => setHoveredId(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  showContextMenu([
                    { label: "Reveal in Finder", action: () => api.revealInFinder(ws.paths[0]) },
                    "separator",
                    { label: "Remove Workspace", action: () => removeWorkspace(ws.id) },
                  ]);
                }}
              >
                <div style={styles.itemName}>{ws.name}</div>
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
    overflow: "hidden",
    height: "100%",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 20px 8px 16px",
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
    padding: "10px 20px 10px 16px",
    background: "none",
    color: "#ccc",
    cursor: "pointer",
    textAlign: "left" as const,
    fontSize: 13,
  },
  itemActive: {
    background: "#2a2a2a",
    color: "#fff",
  },
  itemHover: {
    background: "#222",
  },
  itemName: {
    fontWeight: 600,
  },
  bottomBtns: {
    borderTop: "1px solid #333",
  },
  addBtn: {
    width: "100%",
    padding: "8px 20px 8px 16px",
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
    padding: "8px 20px 8px 16px",
    background: "none",
    border: "none",
    color: "#888",
    cursor: "pointer",
    fontSize: 12,
    textAlign: "left" as const,
    fontWeight: 500,
  },
};
