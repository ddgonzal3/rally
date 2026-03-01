import React, { useEffect, useState } from "react";
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

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <div style={styles.titleWrap}>
            <span style={styles.title}>New Workspace</span>
            <span style={styles.subtitle}>Create a workspace from one or more folders.</span>
          </div>
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
            {paths.length === 0 && (
              <div style={styles.emptyDirectories}>
                No directories selected yet.
              </div>
            )}
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

        <div style={styles.footer}>
          <button style={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            style={{
              ...styles.submitBtn,
              ...(canSubmit ? undefined : styles.submitBtnDisabled),
            }}
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {loading ? "Adding..." : "Create Workspace"}
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
    alignItems: "flex-start",
    justifyContent: "center",
    paddingTop: 325,
    zIndex: 1000,
  },
  modal: {
    width: 420,
    maxWidth: "calc(100vw - 28px)",
    maxHeight: "calc(100vh - 110px)",
    background:
      "linear-gradient(180deg, rgba(37,39,44,0.95) 0%, rgba(30,33,38,0.96) 100%)",
    borderRadius: 10,
    border: "1px solid var(--border)",
    boxShadow: "0 24px 60px var(--shadow), 0 0 0 1px rgba(255,255,255,0.03)",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    padding: "11px 14px 9px",
    borderBottom: "1px solid var(--border)",
  },
  titleWrap: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 2,
  },
  title: {
    fontSize: 18,
    fontWeight: 620,
    lineHeight: 1.2,
    color: "var(--text-primary)",
  },
  subtitle: {
    fontSize: 11,
    fontWeight: 500,
    color: "var(--text-secondary)",
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "var(--text-dim)",
    cursor: "pointer",
    padding: 5,
    marginTop: -1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
  },
  body: {
    padding: "10px 14px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  label: {
    fontSize: 11,
    fontWeight: 700,
    color: "var(--text-dim)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    display: "block",
    marginBottom: 5,
  },
  hint: {
    fontSize: 12,
    color: "#f39797",
    marginTop: 4,
  },
  input: {
    width: "100%",
    minHeight: 34,
    padding: "7px 10px",
    background: "var(--bg-surface)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    color: "var(--text-primary)",
    fontSize: 13,
    fontWeight: 520,
    outline: "none",
    boxSizing: "border-box" as const,
  },
  emptyDirectories: {
    marginBottom: 6,
    padding: "7px 9px",
    borderRadius: 7,
    border: "1px dashed var(--border)",
    color: "var(--text-dim)",
    fontSize: 11.5,
    background: "rgba(16, 19, 25, 0.45)",
  },
  pathList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
    marginBottom: 6,
    maxHeight: 128,
    overflowY: "auto",
  },
  pathItem: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 8px",
    background: "var(--bg-surface)",
    border: "1px solid var(--border)",
    borderRadius: 7,
  },
  pathText: {
    flex: 1,
    fontSize: 12,
    color: "var(--text-primary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  removeBtn: {
    background: "none",
    border: "none",
    color: "var(--text-dim)",
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
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    borderRadius: 7,
    color: "var(--text-primary)",
    cursor: "pointer",
    fontSize: 11.5,
    fontWeight: 600,
    width: "fit-content",
  },
  error: {
    padding: "7px 9px",
    borderRadius: 7,
    background: "rgba(220, 80, 80, 0.12)",
    border: "1px solid rgba(240, 117, 117, 0.35)",
    color: "#f29b9b",
    fontSize: 11.5,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "9px 14px 11px",
    borderTop: "1px solid var(--border)",
    background: "rgba(16, 19, 24, 0.36)",
  },
  cancelBtn: {
    padding: "6px 10px",
    background: "none",
    border: "none",
    borderRadius: 7,
    color: "var(--text-secondary)",
    cursor: "pointer",
    fontSize: 11.5,
    fontWeight: 550,
  },
  submitBtn: {
    padding: "6px 12px",
    background: "linear-gradient(180deg, #e9edf5 0%, #d9dee8 100%)",
    border: "none",
    borderRadius: 6,
    color: "#1f2630",
    cursor: "pointer",
    fontSize: 11.5,
    fontWeight: 700,
    minWidth: 118,
  },
  submitBtnDisabled: {
    opacity: 0.45,
    cursor: "default",
  },
};
