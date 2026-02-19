import React, { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { api } from "../lib/tauri";

interface AddWorkspaceModalProps {
  onClose: () => void;
}

export function AddWorkspaceModal({ onClose }: AddWorkspaceModalProps) {
  const { addWorkspace } = useWorkspaceStore();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [mainBranch, setMainBranch] = useState("main");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleBrowse() {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      setPath(selected as string);
      // Auto-detect git info
      try {
        const info = await api.detectGitInfo(selected as string);
        if (info.repo_url) setRepoUrl(info.repo_url);
        if (info.branch) setBranch(info.branch);
        if (info.name && !name) setName(info.name);
      } catch {
        // Not a git repo, that's fine
      }
    }
  }

  async function handleSubmit() {
    if (!name.trim() || !path.trim()) {
      setError("Name and path are required");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await addWorkspace({
        name: name.trim(),
        path: path.trim(),
        repoUrl: repoUrl.trim(),
        branch: branch.trim() || "main",
        mainBranch: mainBranch.trim() || "main",
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

          <label style={styles.label}>Path</label>
          <div style={styles.pathRow}>
            <input
              style={{ ...styles.input, flex: 1 }}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/Users/you/repos/project"
            />
            <button style={styles.browseBtn} onClick={handleBrowse}>
              Browse
            </button>
          </div>
          <span style={styles.hint}>
            Select an existing repo folder — git info will be detected automatically
          </span>

          <label style={styles.label}>Repo URL</label>
          <input
            style={styles.input}
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="git@github.com:org/repo.git"
          />

          <label style={styles.label}>Branch</label>
          <input
            style={styles.input}
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="e.g., danny/dev"
          />

          <label style={styles.label}>Main Branch</label>
          <input
            style={styles.input}
            value={mainBranch}
            onChange={(e) => setMainBranch(e.target.value)}
            placeholder="main"
          />

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
  browseBtn: {
    padding: "7px 14px",
    background: "#333",
    border: "1px solid #444",
    borderRadius: 4,
    color: "#ccc",
    cursor: "pointer",
    fontSize: 12,
    whiteSpace: "nowrap" as const,
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
