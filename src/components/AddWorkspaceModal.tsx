import React, { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useWorkspaceStore } from "../stores/workspaceStore";

interface AddWorkspaceModalProps {
  onClose: () => void;
}

export function AddWorkspaceModal({ onClose }: AddWorkspaceModalProps) {
  const { addWorkspace, workspaces } = useWorkspaceStore();
  const [name, setName] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const trimmedName = name.trim();
  const nameExists = trimmedName
    ? workspaces.some((ws) => ws.name.toLowerCase() === trimmedName.toLowerCase())
    : false;

  async function handleAddDirectory() {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      const dir = selected as string;
      if (paths.includes(dir)) return; // avoid duplicates
      setPaths((prev) => [...prev, dir]);
      // Auto-fill name from first folder
      if (!name) {
        const folderName = dir.split("/").pop();
        if (folderName) setName(folderName);
      }
    }
  }

  function handleRemovePath(index: number) {
    setPaths((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit() {
    if (!name.trim() || paths.length === 0) {
      setError("Name and at least one directory are required");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await addWorkspace({
        name: name.trim(),
        paths,
      });
      onClose();
    } catch (e: any) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const canSubmit = trimmedName && !nameExists && paths.length > 0 && !loading;

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.title}>New Workspace</span>
          <button
            style={styles.closeBtn}
            onClick={onClose}
            title="Close"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div style={styles.body}>
          <div>
            <label style={styles.label}>Name</label>
            <input
              style={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., my-project"
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter" && canSubmit) handleSubmit(); }}
            />
            {nameExists && (
              <div style={styles.hint}>A workspace with this name already exists</div>
            )}
          </div>

          <div>
            <label style={styles.label}>Directories</label>
            {paths.length > 0 && (
              <div style={styles.pathList}>
                {paths.map((p, i) => (
                  <div key={p} style={styles.pathItem}>
                    <span style={styles.pathText}>
                      {p.replace(/^\/Users\/[^/]+/, "~")}
                    </span>
                    <button
                      className="tab-action"
                      style={styles.removeBtn}
                      onClick={() => handleRemovePath(i)}
                      title="Remove"
                    >
                      <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
                        <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              className="sidebar-btn"
              style={styles.browseBtn}
              onClick={handleAddDirectory}
            >
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" style={{ marginRight: 5 }}>
                <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
              Add Directory
            </button>
          </div>

          {error && <div style={styles.error}>{error}</div>}
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <button style={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            style={{
              ...styles.submitBtn,
              opacity: canSubmit ? 1 : 0.4,
            }}
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {loading ? "Adding..." : "Add Workspace"}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "transparent",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  modal: {
    width: 380,
    background: "#222",
    borderRadius: 10,
    border: "1px solid #333",
    boxShadow: "0 8px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255,255,255,0.03)",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 16px 10px",
  },
  title: {
    fontSize: 13,
    fontWeight: 600,
    color: "#ddd",
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "#555",
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
  },
  body: {
    padding: "0 16px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  label: {
    fontSize: 11,
    fontWeight: 600,
    color: "#777",
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
    display: "block",
    marginBottom: 6,
  },
  hint: {
    fontSize: 11,
    color: "#df7d7d",
    marginTop: 4,
  },
  input: {
    width: "100%",
    padding: "8px 10px",
    background: "#1a1a1a",
    border: "1px solid #2e2e2e",
    borderRadius: 6,
    color: "#e0e0e0",
    fontSize: 13,
    outline: "none",
    boxSizing: "border-box" as const,
  },
  pathList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
    marginBottom: 6,
  },
  pathItem: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 8px",
    background: "#1a1a1a",
    border: "1px solid #2e2e2e",
    borderRadius: 6,
  },
  pathText: {
    flex: 1,
    fontSize: 12,
    color: "#aaa",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    direction: "rtl" as const,
    textAlign: "left" as const,
  },
  removeBtn: {
    background: "none",
    border: "none",
    color: "#555",
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
    flexShrink: 0,
  },
  browseBtn: {
    display: "flex",
    alignItems: "center",
    padding: "6px 10px",
    background: "none",
    border: "1px solid #333",
    borderRadius: 6,
    color: "#888",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 500,
    width: "fit-content",
  },
  error: {
    padding: "6px 10px",
    borderRadius: 6,
    background: "rgba(220, 80, 80, 0.08)",
    border: "1px solid rgba(220, 80, 80, 0.2)",
    color: "#df7d7d",
    fontSize: 12,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "10px 16px 14px",
  },
  cancelBtn: {
    padding: "6px 14px",
    background: "none",
    border: "none",
    borderRadius: 6,
    color: "#666",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 500,
  },
  submitBtn: {
    padding: "6px 14px",
    background: "#fff",
    border: "none",
    borderRadius: 6,
    color: "#111",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
  },
};
