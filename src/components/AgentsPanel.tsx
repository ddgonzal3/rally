import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useCheckoutStore } from "../stores/checkoutStore";
import { folderName } from "../lib/prepare";
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
 * working (amber) or needing input (plain status), failed preparation, open PRs.
 * Expanded, every checkout is a row, so nothing open is unreachable.
 * Clicking a project starts a task there (⌘K with the project chosen);
 * clicking a row reveals its panel, or starts a task when it has none.
 * Hide, Stop, Clear and Reset live in the row's context menu.
 */
export function AgentsPanel() {
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const projects = useSidebarModel(workspaceId);
  const [focusedPod, setFocusedPod] = useState<string | null>(null);
  useEffect(() => {
    setFocusedPod(null);
    const onFocus = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId: string; podId: string }>).detail;
      if (detail.workspaceId === workspaceId) setFocusedPod(detail.podId);
    };
    const onPointer = (event: Event) => {
      const element = (event.target as Element)?.closest?.("[data-flight-pod]");
      if (element) setFocusedPod(element.getAttribute("data-flight-pod"));
    };
    window.addEventListener("flight-focus-pod", onFocus);
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("focusin", onPointer, true);
    return () => {
      window.removeEventListener("flight-focus-pod", onFocus);
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("focusin", onPointer, true);
    };
  }, [workspaceId]);

  return (
    <div className="no-select" style={styles.panel}>
      <CheckoutLabelEditor />
      <div style={styles.body}>
        {!workspaceId && <div style={styles.emptyText}>No workspace selected.</div>}
        {workspaceId && projects.length === 0 && <div style={styles.emptyText}>Add a project to this workspace.</div>}
        {workspaceId && projects.map((p) => <ProjectGroup key={p.project} workspaceId={workspaceId} project={p} focusedPod={focusedPod} />)}
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

function checkoutMenu(cwd: string): MenuAction[] {
  const note = useCheckoutStore.getState().notes[cwd];
  return [
    { label: note?.busy ? "Clear busy mark" : "Mark as busy outside Rally", action: () => useCheckoutStore.getState().setBusy(cwd, !note?.busy) },
    { label: note?.label ? "Edit work label…" : "Add work label…", action: () => document.dispatchEvent(new CustomEvent("rally:edit-checkout-label", { detail: cwd })) },
    ...(note?.label ? [{ label: "Remove work label", action: () => useCheckoutStore.getState().setLabel(cwd, "") }] : []),
  ];
}

function CheckoutLabelEditor() {
  const [cwd, setCwd] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  useEffect(() => {
    const edit = (event: Event) => {
      const path = (event as CustomEvent<string>).detail;
      setLabel(useCheckoutStore.getState().notes[path]?.label ?? "");
      setCwd(path);
    };
    document.addEventListener("rally:edit-checkout-label", edit);
    return () => document.removeEventListener("rally:edit-checkout-label", edit);
  }, []);
  if (!cwd) return null;
  return createPortal(
    <form role="dialog" aria-modal="false" aria-label={`Work label for ${folderName(cwd)}`} style={styles.labelEditor}
      onSubmit={(e) => { e.preventDefault(); useCheckoutStore.getState().setLabel(cwd, label); setCwd(null); }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); setCwd(null); } }}>
      <label htmlFor="checkout-work-label" style={{ fontSize: 13, fontWeight: 500 }}>Work label for {folderName(cwd)}</label>
      <input id="checkout-work-label" key={cwd} autoFocus maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="What are you working on?" style={styles.labelInput} />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" style={styles.labelButton} onClick={() => setCwd(null)}>Cancel</button>
        <button type="submit" style={styles.labelButton}>Save</button>
      </div>
    </form>, document.body,
  );
}

function projectMenu(project: ProjectEntry) {
  showContextMenu([
    { label: `New task in ${project.project}…`, action: () => openLauncher({ project: project.project }) },
    "separator",
    ...project.checkouts.map((c) => ({ label: c.name, children: checkoutMenu(c.cwd) })),
    "separator",
    revealInFinderItem(project.checkouts),
  ]);
}

// --- Project group -------------------------------------------------------------

function ProjectGroup({ workspaceId, project, focusedPod }: { workspaceId: string; project: ProjectEntry; focusedPod: string | null }) {
  const open = useDrawers((s) => !!s.open[project.project]);
  if (project.merged) {
    return (
      <div style={styles.group}>
        <AgentRow workspaceId={workspaceId} entry={project.rows[0]} project={project} selected={focusedPod === project.rows[0].podId && focusedPod !== null} indent={false} />
      </div>
    );
  }
  return (
    <div style={styles.group}>
      <ProjectRow project={project} open={open} />
      {(open ? project.rows : project.active).map((a) => (
        <AgentRow key={a.podId ?? `cwd:${a.cwd}`} workspaceId={workspaceId} entry={a} project={project} selected={focusedPod === a.podId && focusedPod !== null} indent />
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
      <FolderIcon />
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

function AgentRow({ workspaceId, entry, project, indent, selected }: { workspaceId: string; entry: AgentEntry; project: ProjectEntry; indent: boolean; selected: boolean }) {
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
    const items: (MenuAction | SubMenuAction | "separator")[] = [...checkoutMenu(entry.cwd), "separator"];
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
        disabled: entry.dot !== null || entry.preparing || entry.manualBusy,
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
        height: 28,
        minHeight: 28,
        paddingLeft: indent ? 20 : 12,
        background: selected && !entry.hidden ? "color-mix(in srgb, var(--text-primary) 9%, transparent)" : hovered ? "var(--bg-hover)" : "transparent",
        boxShadow: selected && !entry.hidden ? "inset 0 0 0 1px color-mix(in srgb, var(--text-primary) 4%, transparent)" : "none",
        opacity: entry.hidden && !entry.dot && !entry.manualBusy && !entry.label ? 0.65 : 1,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={[entry.cwd, entry.label, entry.manualBusy ? "Marked busy outside Rally" : "", entry.secondary, entry.topic, podId ? "Click to show · Shift-click to hide" : ""].filter(Boolean).join("\n")}
      onClick={(e) => {
        if (e.shiftKey) {
          if (podId && !entry.hidden) stashPod(workspaceId, podId);
          return;
        }
        open();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        menu();
      }}
    >
      <div style={styles.rowMain}>
        <div style={styles.nameLine}>
          {!indent && <FolderIcon />}
          <span style={styles.identity}>
            <span style={styles.name}>{entry.name}</span>
            {entry.label && <span style={styles.workLabel}>· {entry.label}</span>}
          </span>
          <span style={styles.right}>
            {entry.problem && (
              <span style={styles.problem} title={entry.problem.detail}>
                !
              </span>
            )}
            {entry.manualBusy && <span style={styles.busyLabel}>Busy</span>}
            {entry.pr && <PrPill pr={entry.pr} />}
            {entry.dot === "working" && <span style={styles.dot} title={entry.secondary || "Working"} />}
          </span>
        </div>
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
      title={`PR #${pr.number}: ${pr.title}`}
      style={styles.prPill}
    >
      #{pr.number}
      {checks && <span style={{ color: checksColor, marginLeft: 3 }}>{checks}</span>}
    </button>
  );
}

function FolderIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ display: "block", flexShrink: 0, color: "var(--text-secondary)" }}>
      <path d="M1.25 3.25c0-.55.45-1 1-1h2.2l1.1 1.2h4.2c.55 0 1 .45 1 1v4.3c0 .55-.45 1-1 1h-7.5c-.55 0-1-.45-1-1v-5.5Z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
    </svg>
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

const PROJECT_ROW_H = 28;

const styles: Record<string, React.CSSProperties> = {
  busyLabel: { fontSize: 11, fontWeight: 500, color: "var(--text-secondary)", flexShrink: 0 },
  labelEditor: { position: "fixed", top: "25%", left: "50%", transform: "translateX(-50%)", width: 320, maxWidth: "calc(100vw - 32px)", zIndex: 10000, display: "flex", flexDirection: "column", gap: 12, padding: 16, borderRadius: 10, background: "rgba(36, 36, 36, 0.78)", backdropFilter: "blur(20px) saturate(180%)", border: "1px solid rgba(255, 255, 255, 0.12)", color: "#ddd", boxShadow: "0 8px 30px rgba(0,0,0,0.25)" },
  labelInput: { width: "100%", boxSizing: "border-box", fontFamily: "inherit", fontSize: 13, fontWeight: 500, padding: "7px 8px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.06)", color: "#ddd", outline: "none" },
  labelButton: { fontFamily: "inherit", fontSize: 12, fontWeight: 500, padding: "5px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.06)", color: "#ddd", cursor: "pointer" },
  panel: { display: "flex", flexDirection: "column", height: "100%", background: "transparent", overflow: "hidden" },
  body: { flex: 1, minHeight: 0, overflow: "auto", padding: "6px 10px 16px", display: "flex", flexDirection: "column" },
  group: { display: "flex", flexDirection: "column", marginBottom: 3 },
  projectRow: {
    height: PROJECT_ROW_H,
    minHeight: PROJECT_ROW_H,
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "0 12px",
    borderRadius: 9,
    cursor: "pointer",
    transition: "background 100ms ease",
  },
  projectName: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    fontWeight: 500,
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
    display: "flex",
    alignItems: "center",
    padding: "0 6px 0 12px",
    borderRadius: 9,
    cursor: "pointer",
    transition: "background 100ms ease, opacity 150ms ease",
  },
  rowMain: { flex: 1, minWidth: 0 },
  identity: { flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 5 },
  nameLine: { height: 16, display: "flex", alignItems: "center", gap: 6, minWidth: 0 },
  name: {
    flex: "0 0 auto",
    maxWidth: "100%",
    fontSize: 13,
    fontWeight: 500,
    color: "var(--text-primary)",
    lineHeight: 1.1,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
  workLabel: {
    minWidth: 0,
    fontSize: 13,
    fontWeight: 500,
    color: "var(--text-dim)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  right: { display: "flex", alignItems: "center", gap: 4, flexShrink: 0 },
  dot: { width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: "var(--status-amber)" },
  prPill: {
    flexShrink: 0,
    height: 19,
    padding: "0 6px",
    border: "1px solid var(--border)",
    borderRadius: 5,
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
  emptyText: { padding: "12px", fontSize: 11, color: "var(--text-secondary)" },
};
