import React from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { openUrl } from "../lib/tauri";
import type { PrStatus } from "../lib/types";

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

export function GitActions() {
  const ws = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId)
  );
  const activePath = useWorkspaceStore((s) => {
    const wsId = s.activeWorkspaceId;
    return wsId ? s.getActivePath(wsId) : null;
  });
  const status = useWorkspaceStore((s) => {
    const wsId = s.activeWorkspaceId;
    const path = wsId ? s.getActivePath(wsId) : null;
    return path ? s.gitStatuses[path] : null;
  });
  const pr = useWorkspaceStore((s) => {
    const wsId = s.activeWorkspaceId;
    const path = wsId ? s.getActivePath(wsId) : null;
    return path ? s.prStatuses[path] : null;
  });

  const branch = status?.branch ?? ws?.branch ?? "";

  if (!ws || !activePath) return null;

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
};
