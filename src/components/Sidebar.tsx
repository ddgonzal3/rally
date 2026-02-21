import React, { useEffect, useState } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { AddWorkspaceModal } from "./AddWorkspaceModal";
import { SettingsPanel } from "./SettingsPanel";
import { api } from "../lib/tauri";
import { showContextMenu } from "../lib/contextMenu";
export function Sidebar() {
  // Individual selectors — avoids re-rendering on unrelated store changes
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    const openAddWorkspace = () => {
      setShowAddModal(true);
    };
    document.addEventListener("rally-open-add-workspace", openAddWorkspace);

    return () => {
      document.removeEventListener("rally-open-add-workspace", openAddWorkspace);
    };
  }, []);

  return (
    <>
      <div style={styles.sidebar}>
        <div style={styles.header}>
          <span style={styles.title}>Workspaces</span>
          <button
            className="sidebar-btn"
            style={styles.headerAddBtn}
            onClick={() => setShowAddModal(true)}
            title="Add workspace"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path
                d="M6 2v8M2 6h8"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div style={styles.list}>
          {workspaces.map((ws) => {
            const isActive = ws.id === activeWorkspaceId;

            return (
              <div
                key={ws.id}
                className={`sidebar-item${isActive ? " sidebar-item-active" : ""}`}
                style={{
                  ...styles.item,
                  ...(isActive ? styles.itemActive : {}),
                }}
                onClick={() => setActive(ws.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  showContextMenu([
                    {
                      label: "Reveal in Finder",
                      action: () => api.revealInFinder(ws.paths[0]),
                    },
                    "separator",
                    {
                      label: "Remove Workspace",
                      action: () => removeWorkspace(ws.id),
                    },
                  ]);
                }}
              >
                <div style={styles.itemName}>{ws.name}</div>
              </div>
            );
          })}
        </div>

        <div style={styles.bottomBtns}>
          <button
            className="sidebar-btn"
            style={styles.settingsBtn}
            onClick={() => setShowSettings(true)}
          >
            Settings
          </button>
        </div>
      </div>

      {showAddModal && (
        <AddWorkspaceModal onClose={() => setShowAddModal(false)} />
      )}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
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
    padding: "0 8px 0 12px",
    minHeight: 34,
    borderBottom: "1px solid #333",
  },
  title: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    color: "#fff",
  },
  headerAddBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 22,
    background: "none",
    border: "none",
    color: "#aaa",
    cursor: "pointer",
    borderRadius: 4,
    padding: 0,
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
    color: "#ddd",
    textAlign: "left" as const,
    fontSize: 13,
  },
  itemActive: {
    background: "#2a2a2a",
    color: "#eee",
  },
  itemName: {
    fontWeight: 600,
  },
  bottomBtns: {
    borderTop: "1px solid #333",
  },
  settingsBtn: {
    width: "100%",
    padding: "8px 20px 8px 16px",
    background: "none",
    border: "none",
    color: "#aaa",
    fontSize: 12,
    textAlign: "left" as const,
    fontWeight: 500,
  },
};
