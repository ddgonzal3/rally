import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { PrStatus, ShipStatus } from "../lib/types";

function openUrl(url: string) {
  invoke("plugin:shell|open", { path: url }).catch(() => {
    window.open(url, "_blank");
  });
}

function PrStatusBar({ pr }: { pr?: PrStatus | null }) {
  if (!pr || pr.state !== "OPEN") return null;

  const mergeColor =
    pr.mergeable === "MERGEABLE" ? "#7ddf7d" :
    pr.mergeable === "CONFLICTING" ? "#df7d7d" : "#aaa";

  const reviewColor =
    pr.review_decision === "APPROVED" ? "#7ddf7d" :
    pr.review_decision === "CHANGES_REQUESTED" ? "#df7d7d" :
    "#dfc97d";

  const checksColor =
    pr.checks_status === "pass" ? "#7ddf7d" :
    pr.checks_status === "fail" ? "#df7d7d" :
    pr.checks_status === "pending" ? "#dfc97d" : "#666";

  return (
    <div style={styles.prBar}>
      <span
        style={{ ...styles.prTitle, cursor: "pointer", textDecoration: "underline", textDecorationColor: "#555" }}
        onClick={() => pr.url && openUrl(pr.url)}
        title={pr.url}
      >
        PR #{pr.number}{pr.is_draft ? " (draft)" : ""}
      </span>
      <span style={{ ...styles.prTag, color: mergeColor }}>
        {pr.mergeable === "MERGEABLE" ? "Mergeable" :
         pr.mergeable === "CONFLICTING" ? "Conflicts" : "Unknown"}
      </span>
      <span style={{ ...styles.prTag, color: reviewColor }}>
        {pr.review_decision === "APPROVED" ? "Approved" :
         pr.review_decision === "CHANGES_REQUESTED" ? "Changes Req" :
         "Review Needed"}
      </span>
      {pr.checks_status && (
        <span style={{ ...styles.prTag, color: checksColor }}>
          Checks {pr.checks_status}
        </span>
      )}
    </div>
  );
}

function ShipStatusBar({ shipStatus }: { shipStatus?: ShipStatus }) {
  if (!shipStatus || shipStatus.phase === "idle") return null;

  if (shipStatus.phase === "merging") {
    return (
      <div style={styles.shipBar}>
        <span style={styles.shipSpinner}>⟳</span>
        <span style={styles.shipText}>
          Merging PR #{shipStatus.pr_number}...
        </span>
      </div>
    );
  }

  if (shipStatus.phase === "syncing") {
    return (
      <div style={styles.shipBar}>
        <span style={styles.shipSpinner}>⟳</span>
        <span style={styles.shipText}>Syncing...</span>
      </div>
    );
  }

  if (shipStatus.phase === "awaiting_review") {
    return (
      <div style={styles.shipBarReview}>
        <span style={styles.shipReviewIcon}>◆</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={styles.shipReviewTitle}>Review Needed</span>
          {shipStatus.signal?.summary && (
            <div style={styles.shipReviewSummary}>{shipStatus.signal.summary}</div>
          )}
          {shipStatus.signal?.flagged_items && shipStatus.signal.flagged_items.length > 0 && (
            <div style={styles.shipReviewCount}>
              {shipStatus.signal.flagged_items.length} flagged item{shipStatus.signal.flagged_items.length !== 1 ? "s" : ""}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (shipStatus.phase === "shipping") {
    return (
      <div style={styles.shipBar}>
        <span style={styles.shipSpinner}>⟳</span>
        <span style={styles.shipText}>Shipping...</span>
      </div>
    );
  }

  return null;
}

export function GitActions() {
  const {
    activeWorkspaceId,
    workspaces,
    gitStatuses,
    prStatuses,
    syncNeeded,
    shipStatuses,
    getActivePath,
    syncPath,
    syncAndPushPath,
    rebasePath,
    commitPath,
    pushPath,
    createPrForPath,
    mergePrForPath,
    refreshGitStatusForPath,
    refreshPrStatusForPath,
  } = useWorkspaceStore();

  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [showCommitInput, setShowCommitInput] = useState(false);

  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  const activePath = activeWorkspaceId ? getActivePath(activeWorkspaceId) : null;
  const status = activePath ? gitStatuses[activePath] : null;
  const pr = activePath ? prStatuses[activePath] : null;
  const needsSync = activePath ? syncNeeded[activePath] : false;
  const shipStatus = activePath ? shipStatuses[activePath] : undefined;
  const branch = status?.branch ?? ws?.branch ?? "";
  const mainBranch = ws?.main_branch ?? "main";

  if (!ws || !activePath) return null;

  async function runAction(name: string, fn: () => Promise<unknown>) {
    setRunning(name);
    setError(null);
    try {
      await fn();
    } catch (e: any) {
      setError(String(e));
    } finally {
      setRunning(null);
    }
  }

  const canMerge = pr?.state === "OPEN" && pr?.mergeable === "MERGEABLE";

  return (
    <div style={styles.container}>
      <div style={styles.statusBar}>
        <span style={styles.branch}>{branch}</span>
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

      <PrStatusBar pr={pr} />
      <ShipStatusBar shipStatus={shipStatus} />

      <div style={styles.actions}>
        <button
          onClick={() => runAction("refresh", async () => {
            await refreshGitStatusForPath(activePath, mainBranch);
            await refreshPrStatusForPath(activePath);
          })}
          disabled={running !== null}
          style={{ ...styles.btn, ...(running === "refresh" ? styles.btnActive : {}) }}
        >
          <span style={styles.btnIcon}>↻</span> Refresh
        </button>

        <button
          onClick={() => runAction("sync", () =>
            needsSync
              ? syncAndPushPath(activePath, branch, mainBranch)
              : syncPath(activePath, branch, mainBranch)
          )}
          disabled={running !== null}
          title={needsSync
            ? "Sync needed! Rebase onto main + push to remote"
            : `Rebase ${branch} onto ${mainBranch}`}
          style={{
            ...styles.btn,
            ...(running === "sync" ? styles.btnActive : {}),
            ...(needsSync ? styles.btnSyncNeeded : {}),
            position: "relative" as const,
          }}
        >
          <span style={styles.btnIcon}>⇄</span> Sync
          {needsSync && <span className="pulse-dot" style={styles.syncDot} />}
        </button>

        <button
          onClick={() => runAction("rebase", () => rebasePath(activePath, branch, mainBranch))}
          disabled={running !== null}
          title="Safe rebase with stash"
          style={{ ...styles.btn, ...(running === "rebase" ? styles.btnActive : {}) }}
        >
          <span style={styles.btnIcon}>↕</span> Rebase
        </button>

        <button
          onClick={() => setShowCommitInput(true)}
          disabled={running !== null}
          style={styles.btn}
        >
          <span style={styles.btnIcon}>✓</span> Commit
        </button>

        <button
          onClick={() => runAction("push", () => pushPath(activePath))}
          disabled={running !== null}
          title="Smart push — auto force-with-lease if needed"
          style={{ ...styles.btn, ...(running === "push" ? styles.btnActive : {}) }}
        >
          <span style={styles.btnIcon}>↑</span> Push
        </button>

        <button
          onClick={() => runAction("pr", () => createPrForPath(activePath))}
          disabled={running !== null}
          style={{ ...styles.btn, ...(running === "pr" ? styles.btnActive : {}) }}
        >
          <span style={styles.btnIcon}>⎇</span> PR
        </button>

        {canMerge && (
          <button
            onClick={() => runAction("merge", () => mergePrForPath(activePath, "squash"))}
            disabled={running !== null}
            title="Squash merge PR"
            style={{
              ...styles.btn,
              ...styles.btnMerge,
              ...(running === "merge" ? styles.btnActive : {}),
            }}
          >
            <span style={styles.btnIcon}>⤵</span> Merge
          </button>
        )}
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
                runAction("commit", () => commitPath(activePath, commitMsg));
                setCommitMsg("");
                setShowCommitInput(false);
              }
              if (e.key === "Escape") setShowCommitInput(false);
            }}
          />
        </div>
      )}

      {error && (
        <div style={styles.errorBar}>
          <span>{error}</span>
          <button style={styles.errorDismiss} onClick={() => setError(null)}>×</button>
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
    marginBottom: 4,
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
  prBar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 6,
    padding: "4px 0",
  },
  prTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: "#bbb",
  },
  prTag: {
    fontSize: 10,
    fontWeight: 600,
  },
  actions: {
    display: "flex",
    gap: 4,
    flexWrap: "wrap",
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
  btnMerge: {
    background: "#1a3a1a",
    borderColor: "#2d5a2d",
    color: "#7ddf7d",
  },
  btnSyncNeeded: {
    borderColor: "#e8b930",
    color: "#e8b930",
  },
  syncDot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "#e8b930",
    position: "absolute" as const,
    top: -2,
    right: -2,
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
  errorBar: {
    marginTop: 8,
    padding: "6px 10px",
    borderRadius: 4,
    border: "1px solid #5a2d2d",
    background: "#2a1a1a",
    color: "#df7d7d",
    fontSize: 11,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  errorDismiss: {
    background: "none",
    border: "none",
    color: "#df7d7d",
    cursor: "pointer",
    fontSize: 14,
    padding: "0 4px",
    flexShrink: 0,
  },
  shipBar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 8px",
    marginBottom: 6,
    borderRadius: 4,
    background: "#1a2a3a",
    border: "1px solid #2a4a6a",
  },
  shipSpinner: {
    fontSize: 14,
    color: "#7db8df",
    animation: "spin 1s linear infinite",
  },
  shipText: {
    fontSize: 12,
    color: "#7db8df",
    fontWeight: 600,
  },
  shipBarReview: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    padding: "8px 10px",
    marginBottom: 6,
    borderRadius: 4,
    background: "#2a2510",
    border: "1px solid #5a4a1a",
  },
  shipReviewIcon: {
    fontSize: 14,
    color: "#e8b930",
    flexShrink: 0,
    marginTop: 1,
  },
  shipReviewTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: "#e8b930",
  },
  shipReviewSummary: {
    fontSize: 11,
    color: "#bba850",
    marginTop: 2,
    lineHeight: 1.4,
  },
  shipReviewCount: {
    fontSize: 10,
    color: "#998830",
    marginTop: 4,
  },
};
