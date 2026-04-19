import React from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";

/**
 * Rally-level settings panel rendered in the activity bar sidebar.
 * Sections:
 *   - Git — minimal-mode toggle disables full status polling + fs watcher.
 */
export function RallySettingsPanel() {
  const gitMinimalMode = useWorkspaceStore((s) => s.gitMinimalMode);
  const setGitMinimalMode = useWorkspaceStore((s) => s.setGitMinimalMode);

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.title}>Rally</span>
      </div>

      <div style={styles.body}>
        <section style={styles.section}>
          <div style={styles.sectionLabel}>Git</div>
          <ToggleRow
            label="Minimal git mode"
            description="Disables git status polling, fetch, and the repo file watcher. Keeps branch name and PR status working. Recommended when working in very large repos where Rally's git scans cause lag."
            enabled={gitMinimalMode}
            onChange={setGitMinimalMode}
          />
        </section>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  enabled,
  onChange,
}: {
  label: string;
  description: string;
  enabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div style={styles.toggleRow}>
      <div style={styles.toggleText}>
        <div style={styles.toggleLabel}>{label}</div>
        <div style={styles.toggleDesc}>{description}</div>
      </div>
      <button
        className="sidebar-btn"
        style={{
          ...styles.toggleSwitch,
          background: enabled
            ? "rgba(120, 180, 255, 0.35)"
            : "rgba(255, 255, 255, 0.08)",
          borderColor: enabled
            ? "rgba(120, 180, 255, 0.45)"
            : "rgba(255, 255, 255, 0.15)",
        }}
        role="switch"
        aria-checked={enabled}
        onClick={() => onChange(!enabled)}
        title={enabled ? "Disable" : "Enable"}
      >
        <span
          style={{
            ...styles.toggleThumb,
            transform: enabled ? "translateX(14px)" : "translateX(0)",
          }}
        />
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: "var(--bg-app)",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 8px 0 12px",
    minHeight: 29,
    maxHeight: 29,
    borderBottom: "1px solid var(--border)",
    flexShrink: 0,
  },
  title: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "var(--text-primary)",
  },
  body: {
    flex: 1,
    minHeight: 0,
    overflow: "auto",
    padding: "8px 0",
    display: "flex",
    flexDirection: "column",
  },
  section: {
    padding: "6px 12px 10px",
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "var(--text-secondary)",
    marginBottom: 8,
  },
  toggleRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "8px 10px",
    background: "var(--bg-input)",
    borderRadius: 6,
  },
  toggleText: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 3,
  },
  toggleLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-primary)",
  },
  toggleDesc: {
    fontSize: 11,
    color: "var(--text-secondary)",
    lineHeight: 1.4,
  },
  toggleSwitch: {
    flexShrink: 0,
    width: 32,
    height: 18,
    borderRadius: 9,
    border: "1px solid rgba(255, 255, 255, 0.15)",
    padding: 1,
    position: "relative",
    cursor: "pointer",
    transition: "background 160ms ease, border-color 160ms ease",
    display: "flex",
    alignItems: "center",
  },
  toggleThumb: {
    width: 14,
    height: 14,
    borderRadius: "50%",
    background: "#fff",
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.3)",
    transition: "transform 160ms ease",
    display: "block",
  },
};
