import React, { useState } from "react";
import { create } from "zustand";
import { useWorkspaceStore, getPodMainPtyIds } from "../stores/workspaceStore";
import { showContextMenu, type MenuAction, type SubMenuAction } from "../lib/contextMenu";
import { useSidebarModel } from "../lib/useSidebarModel";
import type { AgentEntry, ProjectEntry } from "../lib/sidebarModel";
import type { PrStatus } from "../lib/types";
import { markPtyInput } from "../lib/ptyActivity";
import { api, openUrl } from "../lib/tauri";
import { addToast } from "./ToastContainer";

/**
 * Agent sidebar. One row per project with a count of free checkouts and a
 * chevron. Collapsed, the project shows only rows that matter now: agents
 * working (amber) or needing you (blue), failed preparation, open PRs.
 * Expanded, every checkout is a row, so nothing open is unreachable.
 * Clicking a project starts a task there (⌘K with the project chosen);
 * clicking a row reveals its panel, or starts a task when it has none.
 * Hide, Stop, Clear and Reset live in the row's context menu.
 */
export function AgentsPanel() {
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const projects = useSidebarModel(workspaceId);
  const active = projects.reduce((n, p) => n + p.rows.filter((a) => a.dot !== null).length, 0);

  return (
    <div className="no-select" style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.title}>Agents</span>
        <span style={styles.count}>{workspaceId && active > 0 ? active : ""}</span>
      </div>
      <div style={styles.body}>
        {!workspaceId && <div style={styles.emptyText}>No workspace selected.</div>}
        {workspaceId && projects.length === 0 && <div style={styles.emptyText}>Add a project to this workspace.</div>}
        {workspaceId && projects.map((p) => <ProjectGroup key={p.project} workspaceId={workspaceId} project={p} />)}
      </div>
    </div>
  );
}

// --- Drawer state -----------------------------------------------------------------

const DRAWERS_KEY = "rally:agentDrawers";

interface DrawerState {
  open: Record<string, boolean>;
  toggle: (project: string) => void;
}

const useDrawers = create<DrawerState>((set) => ({
  open: (() => {
    try {
      return JSON.parse(localStorage.getItem(DRAWERS_KEY) ?? "{}") as Record<string, boolean>;
    } catch {
      return {};
    }
  })(),
  toggle: (project) =>
    set((s) => {
      const open = { ...s.open, [project]: !s.open[project] };
      try {
        localStorage.setItem(DRAWERS_KEY, JSON.stringify(open));
      } catch {}
      return { open };
    }),
}));

// --- Shared actions -----------------------------------------------------------

function openLauncher(detail: { podId?: string; project?: string; cwd?: string }) {
  document.dispatchEvent(new CustomEvent("rally:open-task-launcher", { detail }));
}

/** Show the pod and treat that as having seen its last bell. */
function revealPod(workspaceId: string, podId: string) {
  const store = useWorkspaceStore.getState();
  const pod = store.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId);
  if (!pod) return;
  const hidden = !!pod.stashed;
  if (hidden) store.unstashPod(workspaceId, podId);
  store.setWorkspaceMode(workspaceId, "flight");
  for (const id of getPodMainPtyIds(podId)) markPtyInput(id);
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent("flight-focus-pod", { detail: { workspaceId, podId } }));
  }, hidden ? 60 : 0);
}

function revealInFinderItem(cwds: { name: string; cwd: string }[]): MenuAction | SubMenuAction {
  if (cwds.length === 1) {
    const cwd = cwds[0].cwd;
    return { label: "Reveal in Finder", action: () => void api.revealInFinder(cwd) };
  }
  return {
    label: "Reveal in Finder",
    children: cwds.map((c) => ({ label: c.name, action: () => void api.revealInFinder(c.cwd) })),
  };
}

function projectMenu(project: ProjectEntry) {
  showContextMenu([
    { label: `New task in ${project.project}…`, action: () => openLauncher({ project: project.project }) },
    "separator",
    revealInFinderItem(project.checkouts),
  ]);
}

// --- Project group -------------------------------------------------------------

function ProjectGroup({ workspaceId, project }: { workspaceId: string; project: ProjectEntry }) {
  const open = useDrawers((s) => !!s.open[project.project]);
  if (project.merged) {
    return (
      <div style={styles.group}>
        <AgentRow workspaceId={workspaceId} entry={project.rows[0]} project={project} indent={false} />
      </div>
    );
  }
  return (
    <div style={styles.group}>
      <ProjectRow project={project} open={open} />
      {(open ? project.rows : project.active).map((a) => (
        <AgentRow key={a.podId ?? `cwd:${a.cwd}`} workspaceId={workspaceId} entry={a} project={project} indent />
      ))}
    </div>
  );
}

function ProjectRow({ project, open }: { project: ProjectEntry; open: boolean }) {
  const toggle = useDrawers((s) => s.toggle);
  const [hovered, setHovered] = useState(false);
  return (
    <div
      className="sidebar-item"
      style={{ ...styles.projectRow, background: hovered ? "var(--bg-hover)" : "transparent" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => openLauncher({ project: project.project })}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        projectMenu(project);
      }}
    >
      <span style={styles.projectName}>{project.project}</span>
      <span style={{ ...styles.available, color: project.available > 0 ? "var(--text-secondary)" : "transparent" }}>{project.available}</span>
      <button
        className="sidebar-btn"
        style={styles.chevronBtn}
        onClick={(e) => {
          e.stopPropagation();
          toggle(project.project);
        }}
        title={open ? "Show active only" : "Show all checkouts"}
      >
        <Chevron open={open} />
      </button>
    </div>
  );
}

// --- Agent row -------------------------------------------------------------------

function AgentRow({ workspaceId, entry, project, indent }: { workspaceId: string; entry: AgentEntry; project: ProjectEntry; indent: boolean }) {
  const stashPod = useWorkspaceStore((s) => s.stashPod);
  const removeFlightPod = useWorkspaceStore((s) => s.removeFlightPod);
  const setPodTask = useWorkspaceStore((s) => s.setPodTask);
  const stopPodSession = useWorkspaceStore((s) => s.stopPodSession);
  const retryTaskPrep = useWorkspaceStore((s) => s.retryTaskPrep);
  const skipPrepStep = useWorkspaceStore((s) => s.skipPrepStep);
  const resetCheckout = useWorkspaceStore((s) => s.resetCheckout);
  const openStatusBarDrawer = useWorkspaceStore((s) => s.openStatusBarDrawer);
  const [hovered, setHovered] = useState(false);

  const podId = entry.podId;
  const open = () => {
    if (podId) revealPod(workspaceId, podId);
    else if (entry.available) openLauncher({ cwd: entry.cwd });
    else if (entry.pr) openUrl(entry.pr.url);
  };

  const menu = () => {
    const items: (MenuAction | SubMenuAction | "separator")[] = [];
    if (podId) {
      const pod = useWorkspaceStore.getState().flightLayouts[workspaceId]?.pods.find((p) => p.id === podId);
      const prep = pod?.task?.prep;
      const failedStep = prep?.steps.find((s) => s.status === "failed");
      items.push(entry.hidden ? { label: "Reveal", action: open } : { label: "Hide", action: () => stashPod(workspaceId, podId) });
      items.push({ label: "Message…", action: () => openLauncher({ podId }) });
      if (prep && failedStep && prep.status !== "running") {
        items.push("separator");
        items.push({ label: `Retry ${failedStep.label.toLowerCase()}`, action: () => void retryTaskPrep(workspaceId, podId) });
        if (failedStep.kind !== "deliver") {
          items.push({ label: `Skip ${failedStep.label.toLowerCase()}`, action: () => void skipPrepStep(workspaceId, podId, failedStep.id) });
        }
        if (failedStep.scriptName && pod) {
          const scriptName = failedStep.scriptName;
          items.push({ label: "Show output", action: () => openStatusBarDrawer(pod.cwd, scriptName) });
        }
      }
      items.push("separator");
      items.push({
        label: "Reset checkout",
        action: () => {
          resetCheckout(workspaceId, podId).catch((e) => {
            addToast({ type: "warning", title: `${entry.name}: reset refused`, message: String(e), duration: 8000 });
          });
        },
        disabled: entry.dot !== null || entry.preparing,
      });
      items.push({ label: "Stop Claude session", action: () => void stopPodSession(workspaceId, podId), disabled: entry.dot === null && !entry.preparing });
      items.push({ label: "Clear task", action: () => setPodTask(workspaceId, podId, undefined), disabled: !pod?.task });
      items.push("separator");
      items.push({ label: "Remove panel", action: () => removeFlightPod(workspaceId, podId) });
    }
    if (!podId) {
      items.push({ label: `New task in ${entry.name}…`, action: () => openLauncher({ cwd: entry.cwd }), disabled: !entry.available });
    }
    if (entry.pr) {
      if (items.length > 0) items.push("separator");
      items.push({ label: `Open PR #${entry.pr.number}`, action: () => openUrl(entry.pr!.url) });
    }
    if (project.merged) {
      items.push("separator");
      items.push({ label: `New task in ${project.project}…`, action: () => openLauncher({ project: project.project }) });
    }
    items.push("separator");
    items.push({ label: "Reveal in Finder", action: () => void api.revealInFinder(entry.cwd) });
    showContextMenu(items);
  };

  return (
    <div
      className="sidebar-item"
      style={{
        ...styles.row,
        paddingLeft: indent ? 12 : 4,
        background: hovered ? "var(--bg-hover)" : "transparent",
        opacity: entry.hidden ? 0.5 : 1,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={open}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        menu();
      }}
    >
      <div style={styles.rowMain}>
        <div style={styles.nameLine}>
          <span style={styles.name}>{entry.name}</span>
          <span style={styles.right}>
            {podId && (
              <button
                className="sidebar-btn"
                style={{ ...styles.iconBtn, opacity: hovered ? 1 : 0, pointerEvents: hovered ? "auto" : "none" }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (entry.hidden) revealPod(workspaceId, podId);
                  else stashPod(workspaceId, podId);
                }}
                title={entry.hidden ? "Reveal panel" : "Hide panel (session keeps running)"}
              >
                {entry.hidden ? <EyeIcon /> : <EyeOffIcon />}
              </button>
            )}
            {entry.problem && (
              <span style={styles.problem} title={entry.problem.detail}>
                !
              </span>
            )}
            {entry.dot && <span style={{ ...styles.dot, background: entry.dot === "waiting" ? "var(--status-blue)" : "var(--status-amber)" }} />}
            {entry.pr && <PrPill pr={entry.pr} />}
          </span>
        </div>
        <div style={styles.secondary}>{entry.secondary}</div>
      </div>
    </div>
  );
}

function PrPill({ pr }: { pr: PrStatus }) {
  const checks = pr.checks_status === "pass" ? "✓" : pr.checks_status === "fail" ? "✕" : pr.checks_status === "pending" ? "●" : "";
  const checksColor = pr.checks_status === "fail" ? "var(--status-red)" : pr.checks_status === "pass" ? "var(--status-green)" : "var(--status-amber)";
  return (
    <button
      className="sidebar-btn"
      onClick={(e) => {
        e.stopPropagation();
        openUrl(pr.url);
      }}
      style={styles.prPill}
    >
      #{pr.number}
      {checks && <span style={{ color: checksColor, marginLeft: 3 }}>{checks}</span>}
    </button>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      style={{ display: "block", transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms ease" }}
    >
      <path d="M3.5 2l3 3-3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ display: "block" }}>
      <path d="M1 6s2-3.5 5-3.5S11 6 11 6s-2 3.5-5 3.5S1 6 1 6z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <circle cx="6" cy="6" r="1.5" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ display: "block" }}>
      <path d="M1 6s2-3.5 5-3.5S11 6 11 6s-2 3.5-5 3.5S1 6 1 6z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M2 10L10 2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

const PROJECT_ROW_H = 28;
const ROW_H = 44;

const styles: Record<string, React.CSSProperties> = {
  panel: { display: "flex", flexDirection: "column", height: "100%", background: "var(--bg-surface)", overflow: "hidden" },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 12px",
    minHeight: 29,
    maxHeight: 29,
    borderBottom: "1px solid var(--border)",
    flexShrink: 0,
  },
  title: { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-primary)" },
  count: { fontSize: 11, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" },
  body: { flex: 1, minHeight: 0, overflow: "auto", padding: "6px 4px 12px", display: "flex", flexDirection: "column" },
  group: { display: "flex", flexDirection: "column", marginBottom: 6 },
  projectRow: {
    height: PROJECT_ROW_H,
    minHeight: PROJECT_ROW_H,
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "0 4px",
    borderRadius: 6,
    cursor: "pointer",
    transition: "background 100ms ease",
  },
  projectName: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
    lineHeight: 1.1,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  available: { flexShrink: 0, fontSize: 11, fontWeight: 600, fontVariantNumeric: "tabular-nums", lineHeight: 1 },
  chevronBtn: {
    flexShrink: 0,
    width: 18,
    height: 18,
    padding: 0,
    border: "1px solid transparent",
    borderRadius: 4,
    background: "transparent",
    color: "var(--text-dim)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
  },
  row: {
    height: ROW_H,
    minHeight: ROW_H,
    display: "flex",
    alignItems: "center",
    padding: "0 4px",
    borderRadius: 6,
    cursor: "pointer",
    transition: "background 100ms ease, opacity 150ms ease",
  },
  rowMain: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 },
  nameLine: { height: 16, display: "flex", alignItems: "center", gap: 6, minWidth: 0 },
  name: {
    flex: 1,
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
    lineHeight: 1.1,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
  secondary: {
    height: 14,
    fontSize: 12,
    fontWeight: 500,
    color: "var(--text-dim)",
    lineHeight: 1.15,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  right: { display: "flex", alignItems: "center", gap: 6, flexShrink: 0 },
  dot: { width: 6, height: 6, borderRadius: "50%", flexShrink: 0 },
  prPill: {
    flexShrink: 0,
    height: 16,
    padding: "0 5px",
    border: "1px solid rgba(255, 255, 255, 0.25)",
    borderRadius: 3,
    background: "none",
    color: "var(--text-secondary)",
    fontSize: 11,
    fontWeight: 700,
    lineHeight: 1,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
  },
  problem: {
    width: 14,
    height: 14,
    borderRadius: "50%",
    border: "1px solid var(--status-amber)",
    color: "var(--status-amber)",
    fontSize: 10,
    fontWeight: 700,
    lineHeight: "12px",
    textAlign: "center",
    flexShrink: 0,
    cursor: "default",
  },
  iconBtn: {
    flexShrink: 0,
    width: 18,
    height: 18,
    borderRadius: 4,
    border: "1px solid transparent",
    background: "transparent",
    color: "var(--text-secondary)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    transition: "opacity 120ms ease",
  },
  emptyText: { padding: "12px", fontSize: 11, color: "var(--text-secondary)" },
};
