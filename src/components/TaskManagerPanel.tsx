import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/tauri";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { collectReferencedPtyIds } from "../lib/orphanPtys";
import type {
  ProcessInventory,
  PtyInventoryEntry,
} from "../lib/types";

const POLL_INTERVAL_MS = 2000;

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function formatBytes(kb: number): string {
  if (kb < 1024) return `${kb} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh === 0 ? `${d}d` : `${d}d ${rh}h`;
}

export function TaskManagerPanel() {
  const [inventory, setInventory] = useState<ProcessInventory | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [killing, setKilling] = useState(false);
  const cancelledRef = useRef(false);

  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const layouts = useWorkspaceStore((s) => s.layouts);
  const flightLayouts = useWorkspaceStore((s) => s.flightLayouts);
  const scriptRuns = useWorkspaceStore((s) => s.scriptRuns);
  const shellPanels = useWorkspaceStore((s) => s.shellPanels);
  const autoReleaseEnabled = useWorkspaceStore((s) => s.autoReleaseIdleShells);
  const setAutoReleaseEnabled = useWorkspaceStore((s) => s.setAutoReleaseIdleShells);

  const referencedPtyIds = useMemo(() => {
    return collectReferencedPtyIds({
      workspaces,
      layouts,
      flightLayouts,
      scriptRuns,
      shellPanels,
    });
  }, [workspaces, layouts, flightLayouts, scriptRuns, shellPanels]);

  const refresh = useCallback(async () => {
    try {
      const inv = await api.getProcessInventory();
      if (!cancelledRef.current) {
        setInventory(inv);
        setLoadError(null);
      }
    } catch (err) {
      if (!cancelledRef.current) {
        setLoadError(String(err));
      }
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    void refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, [refresh]);

  const { orphans, visible, totalRss } = useMemo(() => {
    const ptys = inventory?.ptys ?? [];
    const orphans: PtyInventoryEntry[] = [];
    const visible: PtyInventoryEntry[] = [];
    let totalRss = 0;
    for (const p of ptys) {
      totalRss += p.rss_kb;
      if (!referencedPtyIds.has(p.id)) orphans.push(p);
      else visible.push(p);
    }
    return { orphans, visible, totalRss };
  }, [inventory, referencedPtyIds]);

  const killOne = useCallback(
    async (ptyId: string) => {
      try {
        await api.killPty(ptyId);
        await refresh();
      } catch (err) {
        console.error("killPty failed:", err);
      }
    },
    [refresh],
  );

  const killAllOrphans = useCallback(async () => {
    const ids = orphans.map((p) => p.id);
    if (ids.length === 0) return;
    setKilling(true);
    try {
      await api.killPtys(ids);
      await refresh();
    } catch (err) {
      console.error("killPtys failed:", err);
    } finally {
      setKilling(false);
      setConfirmOpen(false);
    }
  }, [orphans, refresh]);

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.title}>Process Manager</span>
        <button
          className="sidebar-btn"
          style={styles.refreshBtn}
          onClick={() => void refresh()}
          title="Refresh"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M10 6A4 4 0 1 1 8.5 3M10 2v2.5H7.5"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
        </button>
      </div>

      <div style={styles.body}>
        {loadError && <div style={styles.error}>{loadError}</div>}

        {inventory && (
          <>
            <section style={styles.section}>
              <div style={styles.sectionLabel}>Rally</div>
              <div style={styles.statGrid}>
                <Stat label="Memory" value={formatBytes(inventory.rally.rss_kb)} />
                <Stat label="Threads" value={String(inventory.rally.threads)} />
                <Stat label="Open fds" value={String(inventory.rally.fds)} />
                <Stat label="Uptime" value={formatDuration(inventory.rally.uptime_s)} />
              </div>
            </section>

            <section style={styles.section}>
              <div style={styles.sectionLabel}>PTY processes</div>
              <div style={styles.statGrid}>
                <Stat label="Total" value={String(inventory.ptys.length)} />
                <Stat label="Idle" value={String(orphans.length)} />
                <Stat label="Tracked" value={String(visible.length)} />
                <Stat label="Total RSS" value={formatBytes(totalRss)} />
              </div>
            </section>

            <div style={styles.actionRow}>
              <button
                className="sidebar-btn"
                style={{
                  ...styles.killBtn,
                  opacity: orphans.length === 0 ? 0.4 : 1,
                  cursor: orphans.length === 0 ? "default" : "pointer",
                }}
                disabled={orphans.length === 0 || killing}
                onClick={() => setConfirmOpen(true)}
                title={
                  orphans.length === 0
                    ? "No idle shells"
                    : `Release ${orphans.length} idle shell${orphans.length === 1 ? "" : "s"}`
                }
              >
                Release idle shells ({orphans.length})
              </button>
            </div>

            <label style={styles.autoRow} title="Automatically release idle shells every 10 minutes">
              <input
                type="checkbox"
                checked={autoReleaseEnabled}
                onChange={(e) => setAutoReleaseEnabled(e.target.checked)}
                style={styles.autoCheckbox}
              />
              <span style={styles.autoLabel}>Auto-release idle shells every 10 min</span>
            </label>

            {orphans.length > 0 && (
              <PtySection
                label="Idle (no pane attached)"
                entries={orphans}
                onKill={killOne}
                emphasize
              />
            )}
            <PtySection
              label="Tracked"
              entries={visible}
              onKill={killOne}
              emphasize={false}
            />
          </>
        )}
      </div>

      {confirmOpen && (
        <ConfirmPopover
          count={orphans.length}
          busy={killing}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => void killAllOrphans()}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.stat}>
      <div style={styles.statLabel}>{label}</div>
      <div style={styles.statValue}>{value}</div>
    </div>
  );
}

function PtySection({
  label,
  entries,
  onKill,
  emphasize,
}: {
  label: string;
  entries: PtyInventoryEntry[];
  onKill: (id: string) => void;
  emphasize: boolean;
}) {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => b.rss_kb - a.rss_kb);
  return (
    <section style={styles.section}>
      <div style={styles.sectionLabel}>
        {label} <span style={styles.sectionCount}>{entries.length}</span>
      </div>
      <div style={styles.list}>
        {sorted.map((entry) => (
          <PtyRow
            key={entry.id}
            entry={entry}
            onKill={onKill}
            emphasize={emphasize}
          />
        ))}
      </div>
    </section>
  );
}

function PtyRow({
  entry,
  onKill,
  emphasize,
}: {
  entry: PtyInventoryEntry;
  onKill: (id: string) => void;
  emphasize: boolean;
}) {
  const cwdLabel = basename(entry.cwd) || entry.cwd || "~";
  const foreground = entry.foreground ?? "shell";
  return (
    <div style={{ ...styles.row, ...(emphasize ? styles.rowOrphan : {}) }}>
      <div style={styles.rowPrimary}>
        <div style={styles.rowTitle} title={entry.cwd}>
          {cwdLabel}
        </div>
        <div style={styles.rowSub} title={entry.command ?? undefined}>
          {foreground}
          {entry.descendant_count > 0 ? ` · ${entry.descendant_count} child` : ""}
          {entry.shell_pid != null ? ` · pid ${entry.shell_pid}` : ""}
        </div>
      </div>
      <div style={styles.rowStats}>
        <span style={styles.rowStat}>{formatBytes(entry.rss_kb)}</span>
        <span style={styles.rowStat}>{formatDuration(entry.uptime_s)}</span>
      </div>
      <button
        className="sidebar-btn"
        style={styles.rowKill}
        title="Release shell"
        onClick={() => onKill(entry.id)}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path
            d="M3 3l6 6M9 3l-6 6"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}

function ConfirmPopover({
  count,
  busy,
  onCancel,
  onConfirm,
}: {
  count: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div style={styles.popoverHost} onMouseDown={onCancel}>
      <div style={styles.popover} onMouseDown={(e) => e.stopPropagation()}>
        <div style={styles.popoverTitle}>Release {count} idle shell{count === 1 ? "" : "s"}?</div>
        <div style={styles.popoverBody}>
          These shells aren't tied to any visible pane or tab. Releasing
          them frees memory and tidies up their child processes.
        </div>
        <div style={styles.popoverActions}>
          <button
            className="sidebar-btn"
            style={styles.popoverCancel}
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="sidebar-btn"
            style={styles.popoverConfirm}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Releasing…" : "Release shells"}
          </button>
        </div>
      </div>
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
    position: "relative",
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
  refreshBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 22,
    background: "none",
    border: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
    borderRadius: 4,
    padding: 0,
  },
  body: {
    flex: 1,
    minHeight: 0,
    overflow: "auto",
    padding: "8px 0",
  },
  error: {
    padding: "6px 12px",
    color: "var(--text-secondary)",
    fontSize: 12,
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
    marginBottom: 6,
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  sectionCount: {
    fontWeight: 500,
    fontSize: 10,
    color: "var(--text-secondary)",
    opacity: 0.7,
  },
  statGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 4,
  },
  stat: {
    padding: "5px 8px",
    background: "var(--bg-input)",
    borderRadius: 4,
  },
  statLabel: {
    fontSize: 10,
    color: "var(--text-secondary)",
    marginBottom: 1,
  },
  statValue: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-primary)",
    fontVariantNumeric: "tabular-nums",
  },
  actionRow: {
    padding: "0 12px 8px",
  },
  autoRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "0 12px 10px",
    cursor: "pointer",
    userSelect: "none" as const,
  },
  autoCheckbox: {
    cursor: "pointer",
    margin: 0,
  },
  autoLabel: {
    fontSize: 11,
    color: "var(--text-secondary)",
  },
  killBtn: {
    width: "100%",
    padding: "6px 10px",
    background: "var(--bg-input)",
    border: "1px solid var(--border)",
    borderRadius: 4,
    color: "var(--text-primary)",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 8px",
    borderRadius: 4,
    background: "var(--bg-input)",
  },
  rowOrphan: {
    background: "var(--bg-input)",
    outline: "1px solid rgba(255, 255, 255, 0.06)",
  },
  rowPrimary: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 1,
  },
  rowTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-primary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  rowSub: {
    fontSize: 10,
    color: "var(--text-secondary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  rowStats: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 1,
    flexShrink: 0,
  },
  rowStat: {
    fontSize: 10,
    color: "var(--text-secondary)",
    fontVariantNumeric: "tabular-nums",
  },
  rowKill: {
    width: 20,
    height: 20,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "none",
    border: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
    borderRadius: 4,
    padding: 0,
    flexShrink: 0,
  },
  popoverHost: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    zIndex: 10,
  },
  popover: {
    background: "rgba(36, 36, 36, 0.78)",
    backdropFilter: "blur(20px) saturate(180%)",
    WebkitBackdropFilter: "blur(20px) saturate(180%)",
    border: "1px solid rgba(255, 255, 255, 0.12)",
    borderRadius: 10,
    padding: 14,
    maxWidth: 260,
    boxShadow: "0 18px 40px var(--shadow)",
  },
  popoverTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
    marginBottom: 6,
  },
  popoverBody: {
    fontSize: 12,
    color: "var(--text-secondary)",
    lineHeight: 1.4,
    marginBottom: 12,
  },
  popoverActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 6,
  },
  popoverCancel: {
    padding: "5px 12px",
    background: "transparent",
    border: "1px solid rgba(255, 255, 255, 0.18)",
    borderRadius: 4,
    color: "var(--text-primary)",
    fontSize: 12,
    cursor: "pointer",
  },
  popoverConfirm: {
    padding: "5px 12px",
    background: "rgba(255, 255, 255, 0.12)",
    border: "1px solid rgba(255, 255, 255, 0.18)",
    borderRadius: 4,
    color: "var(--text-primary)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  },
};
