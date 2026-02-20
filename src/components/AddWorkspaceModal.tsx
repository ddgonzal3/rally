import React, { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useWorkspaceStore } from "../stores/workspaceStore";

interface AddWorkspaceModalProps {
  onClose: () => void;
}

export function AddWorkspaceModal({ onClose }: AddWorkspaceModalProps) {
  const { addWorkspace } = useWorkspaceStore();
  const [name, setName] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

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

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>Add Workspace</span>
          <button style={styles.closeBtn} onClick={onClose}>x</button>
        </div>

        <div style={styles.body}>
          <label style={styles.label}>Name</label>
          <input
            style={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., playground-dev"
            autoFocus
          />

          <label style={styles.label}>Directories</label>
          {paths.length > 0 && (
            <div style={styles.pathList}>
              {paths.map((p, i) => (
                <div key={p} style={styles.pathItem}>
                  <span style={styles.pathText}>{p}</span>
                  <button
                    style={styles.removeBtn}
                    onClick={() => handleRemovePath(i)}
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <button style={styles.browseBtn} onClick={handleAddDirectory}>
            + Add Directory
          </button>
          {error && <div style={styles.error}>{error}</div>}
        </div>

        <div style={styles.footer}>
          <button style={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            style={styles.submitBtn}
            onClick={handleSubmit}
            disabled={loading}
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
    background: "rgba(0, 0, 0, 0.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  modal: {
    width: 480,
    background: "#252525",
    borderRadius: 8,
    border: "1px solid #3a3a3a",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    borderBottom: "1px solid #333",
  },
  title: {
    fontSize: 14,
    fontWeight: 600,
    color: "#e0e0e0",
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "#888",
    fontSize: 16,
    cursor: "pointer",
    padding: "0 4px",
  },
  body: {
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  label: {
    fontSize: 11,
    fontWeight: 500,
    color: "#999",
    marginTop: 4,
  },
  input: {
    padding: "7px 10px",
    background: "#1a1a1a",
    border: "1px solid #3a3a3a",
    borderRadius: 4,
    color: "#e0e0e0",
    fontSize: 13,
    outline: "none",
  },
  pathRow: {
    display: "flex",
    gap: 6,
  },
  pathList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
  },
  pathItem: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 10px",
    background: "#1a1a1a",
    border: "1px solid #3a3a3a",
    borderRadius: 4,
  },
  pathText: {
    flex: 1,
    fontSize: 12,
    color: "#ccc",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  removeBtn: {
    background: "none",
    border: "none",
    color: "#888",
    fontSize: 16,
    cursor: "pointer",
    padding: "0 2px",
    lineHeight: 1,
  },
  browseBtn: {
    padding: "7px 14px",
    background: "#333",
    border: "1px solid #444",
    borderRadius: 4,
    color: "#ccc",
    cursor: "pointer",
    fontSize: 12,
    whiteSpace: "nowrap" as const,
    alignSelf: "flex-start" as const,
  },
  hint: {
    fontSize: 10,
    color: "#666",
    marginTop: -2,
  },
  error: {
    marginTop: 8,
    padding: "6px 10px",
    borderRadius: 4,
    border: "1px solid #5a2d2d",
    color: "#df7d7d",
    fontSize: 12,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "12px 16px",
    borderTop: "1px solid #333",
  },
  cancelBtn: {
    padding: "7px 16px",
    background: "none",
    border: "1px solid #3a3a3a",
    borderRadius: 4,
    color: "#999",
    cursor: "pointer",
    fontSize: 13,
  },
  submitBtn: {
    padding: "7px 16px",
    background: "#7c6ef5",
    border: "none",
    borderRadius: 4,
    color: "#fff",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
  },
};
