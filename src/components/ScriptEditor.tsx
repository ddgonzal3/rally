import React, { useEffect, useState } from "react";
import { api } from "../lib/tauri";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { RallyScriptInfo } from "../lib/types";

export function ScriptEditor() {
  const [scripts, setScripts] = useState<RallyScriptInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const openFile = useWorkspaceStore((s) => s.openFile);

  const refresh = async () => {
    try {
      const result = await api.listRallyScripts();
      setScripts(result);
    } catch (e) {
      console.error("Failed to list rally scripts:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleOpen = (script: RallyScriptInfo) => {
    if (!activeWorkspaceId) return;
    openFile(activeWorkspaceId, script.path);
  };

  const handleRestore = async (script: RallyScriptInfo) => {
    try {
      await api.restoreRallyScript(script.name);
      await refresh();
    } catch (e) {
      console.error("Failed to restore script:", e);
    }
  };

  const cliScripts = scripts.filter((s) => s.category === "script");
  const commands = scripts.filter((s) => s.category === "command");

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.headerTitle}>Rally Scripts</span>
      </div>

      <div style={styles.content}>
        {loading ? (
          <div style={styles.loading}>Loading...</div>
        ) : (
          <>
            <Section title="CLI Scripts" subtitle="~/.rally/bin/">
              {cliScripts.map((s) => (
                <ScriptRow
                  key={s.name}
                  script={s}
                  onOpen={handleOpen}
                  onRestore={handleRestore}
                />
              ))}
            </Section>

            <Section title="Claude Commands" subtitle="~/.rally/commands/">
              {commands.map((s) => (
                <ScriptRow
                  key={s.name}
                  script={s}
                  onOpen={handleOpen}
                  onRestore={handleRestore}
                />
              ))}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

function Section({ title, subtitle, children }: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>{title}</span>
        <span style={styles.sectionSubtitle}>{subtitle}</span>
      </div>
      {children}
    </div>
  );
}

function ScriptRow({ script, onOpen, onRestore }: {
  script: RallyScriptInfo;
  onOpen: (s: RallyScriptInfo) => void;
  onRestore: (s: RallyScriptInfo) => void;
}) {
  return (
    <div
      className="sidebar-item"
      style={styles.row}
      onClick={() => onOpen(script)}
    >
      <div style={styles.rowMain}>
        <div style={styles.rowName}>
          <span style={styles.scriptIcon}>
            {script.category === "command" ? "◇" : "$"}
          </span>
          {script.name}
          {script.is_modified && (
            <span style={styles.modifiedBadge}>modified</span>
          )}
        </div>
        <div style={styles.rowDesc}>{script.description}</div>
      </div>
      {script.is_modified && (
        <button
          style={styles.restoreBtn}
          onClick={(e) => {
            e.stopPropagation();
            onRestore(script);
          }}
          title="Restore to default"
        >
          ↺
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: "var(--bg-surface)",
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
  headerTitle: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    color: "var(--text-primary)",
  },
  content: {
    flex: 1,
    overflow: "auto",
    padding: "4px 0",
  },
  loading: {
    padding: "12px 16px",
    fontSize: 12,
    color: "var(--text-dim)",
  },
  section: {
    marginBottom: 8,
  },
  sectionHeader: {
    display: "flex",
    alignItems: "baseline",
    gap: 6,
    padding: "8px 12px 4px",
  },
  sectionTitle: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    color: "var(--text-dim)",
  },
  sectionSubtitle: {
    fontSize: 10,
    color: "var(--text-dim)",
    fontFamily: "monospace",
  },
  row: {
    display: "flex",
    alignItems: "center",
    padding: "6px 12px",
    cursor: "pointer",
    gap: 6,
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
  },
  rowName: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-primary)",
    display: "flex",
    alignItems: "center",
    gap: 5,
  },
  scriptIcon: {
    fontSize: 10,
    color: "var(--text-dim)",
    width: 12,
    textAlign: "center" as const,
    flexShrink: 0,
  },
  modifiedBadge: {
    fontSize: 9,
    color: "#f59e0b",
    background: "rgba(245, 158, 11, 0.12)",
    padding: "1px 5px",
    borderRadius: 3,
    fontWeight: 500,
  },
  rowDesc: {
    fontSize: 11,
    color: "var(--text-dim)",
    marginTop: 1,
    paddingLeft: 17,
  },
  restoreBtn: {
    background: "var(--border)",
    border: "1px solid var(--bg-hover)",
    color: "var(--text-secondary)",
    fontSize: 13,
    padding: "2px 6px",
    borderRadius: 4,
    cursor: "pointer",
    flexShrink: 0,
    lineHeight: 1,
  },
};
