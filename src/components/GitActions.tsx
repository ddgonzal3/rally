import React, { useState } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";

type ActionResult = { type: "success" | "error"; message: string } | null;

export function GitActions() {
  const {
    activeWorkspaceId,
    workspaces,
    gitStatuses,
    syncWorkspace,
    rebaseWorkspace,
    commitWorkspace,
    pushWorkspace,
    createPr,
    refreshGitStatus,
  } = useWorkspaceStore();

  const [result, setResult] = useState<ActionResult>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [showCommitInput, setShowCommitInput] = useState(false);

  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  const status = activeWorkspaceId ? gitStatuses[activeWorkspaceId] : null;

  if (!ws) return null;

  async function runAction(name: string, fn: () => Promise<string>) {
    setRunning(name);
    setResult(null);
    try {
      const msg = await fn();
      setResult({ type: "success", message: msg });
    } catch (e: any) {
      setResult({ type: "error", message: String(e) });
    } finally {
      setRunning(null);
    }
  }

  const actions = [
    {
      label: "Refresh",
      icon: "↻",
      action: () =>
        runAction("refresh", async () => {
          await refreshGitStatus(ws.id);
          return "Status refreshed";
        }),
    },
    {
      label: "Sync",
      icon: "⇄",
      description: `Rebase ${ws.branch} onto ${ws.main_branch}`,
      action: () => runAction("sync", () => syncWorkspace(ws.id)),
    },
    {
      label: "Rebase",
      icon: "↕",
      description: "Safe rebase with stash",
      action: () => runAction("rebase", () => rebaseWorkspace(ws.id)),
    },
    {
      label: "Commit",
      icon: "✓",
      action: () => setShowCommitInput(true),
    },
    {
      label: "Push",
      icon: "↑",
      action: () => runAction("push", () => pushWorkspace(ws.id)),
    },
    {
      label: "PR",
      icon: "⎇",
      action: () => runAction("pr", () => createPr(ws.id)),
    },
  ];

  return (
    <div style={styles.container}>
      <div style={styles.statusBar}>
        <span style={styles.branch}>{status?.branch ?? ws.branch}</span>
        {status && (
          <>
            {status.dirty && (
              <span style={styles.tag}>
                {status.modified_files.length + status.untracked_files.length} changed
              </span>
            )}
            {status.ahead > 0 && <span style={styles.tag}>↑{status.ahead}</span>}
            {status.behind > 0 && <span style={styles.tag}>↓{status.behind}</span>}
          </>
        )}
      </div>

      <div style={styles.actions}>
        {actions.map((a) => (
          <button
            key={a.label}
            onClick={a.action}
            disabled={running !== null}
            title={a.description}
            style={{
              ...styles.btn,
              ...(running === a.label.toLowerCase() ? styles.btnActive : {}),
            }}
          >
            <span style={styles.btnIcon}>{a.icon}</span>
            {a.label}
          </button>
        ))}
      </div>

      {showCommitInput && (
        <div style={styles.commitRow}>
          <input
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder="Commit message..."
            style={styles.commitInput}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && commitMsg.trim()) {
                runAction("commit", () => commitWorkspace(ws.id, commitMsg));
                setCommitMsg("");
                setShowCommitInput(false);
              }
              if (e.key === "Escape") setShowCommitInput(false);
            }}
          />
        </div>
      )}

      {result && (
        <div
          style={{
            ...styles.result,
            borderColor: result.type === "success" ? "#2d5a2d" : "#5a2d2d",
            color: result.type === "success" ? "#7ddf7d" : "#df7d7d",
          }}
        >
          {result.message}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    borderTop: "1px solid #333",
    background: "#1e1e1e",
    padding: "8px 12px",
  },
  statusBar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  branch: {
    fontSize: 12,
    fontWeight: 600,
    color: "#e0e0e0",
  },
  tag: {
    fontSize: 10,
    padding: "1px 6px",
    borderRadius: 3,
    background: "#333",
    color: "#aaa",
  },
  actions: {
    display: "flex",
    gap: 4,
  },
  btn: {
    padding: "5px 10px",
    background: "#2a2a2a",
    border: "1px solid #3a3a3a",
    borderRadius: 4,
    color: "#ccc",
    cursor: "pointer",
    fontSize: 12,
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  btnActive: {
    background: "#333",
    color: "#fff",
  },
  btnIcon: {
    fontSize: 14,
  },
  commitRow: {
    marginTop: 8,
  },
  commitInput: {
    width: "100%",
    padding: "6px 10px",
    background: "#2a2a2a",
    border: "1px solid #3a3a3a",
    borderRadius: 4,
    color: "#e0e0e0",
    fontSize: 12,
    outline: "none",
  },
  result: {
    marginTop: 8,
    padding: "6px 10px",
    borderRadius: 4,
    border: "1px solid",
    fontSize: 11,
    whiteSpace: "pre-wrap" as const,
    maxHeight: 80,
    overflow: "auto",
  },
};
