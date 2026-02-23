import React, { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { AddWorkspaceModal } from "./AddWorkspaceModal";
import { api } from "../lib/tauri";
import { showContextMenu } from "../lib/contextMenu";

export function Sidebar() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
  const [showAddModal, setShowAddModal] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const openAddWorkspace = () => {
      setShowAddModal(true);
    };
    document.addEventListener("rally-open-add-workspace", openAddWorkspace);
    return () => {
      document.removeEventListener("rally-open-add-workspace", openAddWorkspace);
    };
  }, []);

  // Auto-focus and select text when entering rename mode
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const commitRename = useCallback(() => {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== workspaces.find((w) => w.id === renamingId)?.name) {
      renameWorkspace(renamingId, trimmed);
    }
    setRenamingId(null);
  }, [renamingId, renameValue, workspaces, renameWorkspace]);

  const startRename = useCallback((id: string, currentName: string) => {
    setRenamingId(id);
    setRenameValue(currentName);
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
            const isRenaming = renamingId === ws.id;
            return (
              <div
                key={ws.id}
                className={`sidebar-item${isActive ? " sidebar-item-active" : ""}`}
                style={{
                  ...styles.item,
                  ...(isActive ? styles.itemActive : {}),
                }}
                onClick={() => {
                  if (!isRenaming) setActive(ws.id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  showContextMenu([
                    {
                      label: "Rename",
                      action: () => startRename(ws.id, ws.name),
                    },
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
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    style={styles.renameInput}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename();
                      } else if (e.key === "Escape") {
                        setRenamingId(null);
                      }
                    }}
                  />
                ) : (
                  <div style={styles.itemName}>{ws.name}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {showAddModal && (
        <AddWorkspaceModal onClose={() => setShowAddModal(false)} />
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
    padding: "0 8px 0 12px",
    minHeight: 29,
    maxHeight: 29,
    borderBottom: "1px solid #333",
    flexShrink: 0,
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
    minHeight: 0,
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
  renameInput: {
    width: "100%",
    background: "#333",
    border: "1px solid #555",
    borderRadius: 3,
    color: "#eee",
    fontSize: 13,
    fontWeight: 600,
    fontFamily: "inherit",
    padding: "1px 4px",
    outline: "none",
    boxSizing: "border-box" as const,
  },
};
