import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useAgentStore } from "../stores/agentStore";
import { findFreeCheckout, listProjects } from "../lib/taskPrep";
import { folderName, shortDescription } from "../lib/prepare";
import { api } from "../lib/tauri";
import { showContextMenu } from "../lib/contextMenu";
import type { CheckoutPick } from "../lib/prepare";
import type { ClaudeModel } from "../lib/types";

/**
 * ⌘K launcher. Prompt first, then the project. Rally picks a free checkout
 * of that project (no live Claude, clean, no open PR) and starts the agent
 * there. Also used to message an existing agent (`rally:open-task-launcher`
 * with a podId) — that path never syncs or touches watchers.
 */

const LAST_PROJECT_KEY = "rally:lastProject";
const LAST_MODEL_KEY = "rally:lastModel";
const MODEL_LABELS: Record<ClaudeModel, string> = { fable: "Fable", opus: "Opus" };

function lastModel(): ClaudeModel {
  const v = localStorage.getItem(LAST_MODEL_KEY);
  return v === "opus" ? "opus" : "fable";
}
const EASING = "cubic-bezier(0.2, 0, 0, 1)";

/** A pasted image, saved to disk, with a preview for the card. */
interface Attachment {
  path: string;
  preview: string;
}

interface OpenDetail {
  /** Message an existing agent. */
  podId?: string;
  /** Preselect a project; Rally still picks the free checkout. */
  project?: string;
  /** Start in exactly this checkout. */
  cwd?: string;
}

export function TaskLauncher() {
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const startTask = useWorkspaceStore((s) => s.startTask);
  const sendToPod = useWorkspaceStore((s) => s.sendToPod);
  const healthVersion = useAgentStore((s) => Object.keys(s.health).length);

  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const [targetPodId, setTargetPodId] = useState<string | null>(null);
  const [fixedCwd, setFixedCwd] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [project, setProject] = useState<string | null>(null);
  const [question, setQuestion] = useState(false);
  const [model, setModel] = useState<ClaudeModel>(lastModel);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pick, setPick] = useState<CheckoutPick | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const targetPod = useWorkspaceStore((s) =>
    workspaceId && targetPodId ? s.flightLayouts[workspaceId]?.pods.find((p) => p.id === targetPodId) : undefined,
  );

  // Alphabetical, so the dropdown reads the same every time.
  const projects = useMemo(
    () => (workspaceId ? [...listProjects(workspaceId)].sort((a, b) => a.project.localeCompare(b.project)) : []),
    [workspaceId, healthVersion, open],
  );
  const projectBtnRef = useRef<HTMLButtonElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);

  const pickModel = useCallback(() => {
    const rect = modelBtnRef.current?.getBoundingClientRect();
    showContextMenu(
      (["fable", "opus"] as ClaudeModel[]).map((m) => ({ label: MODEL_LABELS[m], action: () => setModel(m) })),
      rect ? { x: rect.left, y: rect.bottom + 2 } : undefined,
    );
  }, []);

  // Default: the project you last started, else the one with the most
  // checkouts (your main project). Deliberately not the focused panel —
  // that changed under you.
  const defaultProject = useCallback((): string | null => {
    if (projects.length === 0) return null;
    const last = localStorage.getItem(LAST_PROJECT_KEY);
    if (last && projects.some((p) => p.project === last)) return last;
    return [...projects].sort((a, b) => b.cwds.length - a.cwds.length)[0].project;
  }, [projects]);

  const pickProject = useCallback(() => {
    const rect = projectBtnRef.current?.getBoundingClientRect();
    showContextMenu(
      projects.map((p) => ({
        label: p.cwds.length > 1 ? `${p.project}    ${p.cwds.length} checkouts` : p.project,
        action: () => setProject(p.project),
      })),
      rect ? { x: rect.left, y: rect.bottom + 2 } : undefined,
    );
  }, [projects]);

  const openLauncher = useCallback(
    (detail?: OpenDetail) => {
      if (!workspaceId) return;
      setTargetPodId(detail?.podId ?? null);
      setFixedCwd(detail?.cwd ?? null);
      setError(null);
      setBusy(false);
      setQuestion(false);
      setModel(lastModel());
      const live = listProjects(workspaceId);
      const forCwd = detail?.cwd ? live.find((p) => p.cwds.includes(detail.cwd!))?.project : undefined;
      const wanted = forCwd ?? detail?.project;
      setProject(wanted && live.some((p) => p.project === wanted) ? wanted : defaultProject());
      setOpen(true);
      requestAnimationFrame(() => {
        setVisible(true);
        textRef.current?.focus();
      });
    },
    [workspaceId, defaultProject],
  );

  const close = useCallback(() => {
    setVisible(false);
    setTimeout(() => {
      setOpen(false);
      setText("");
      setTargetPodId(null);
      setFixedCwd(null);
      setPick(null);
      setAttachments([]);
    }, 140);
  }, []);

  // ⌘K + external open requests.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        if (open) close();
        else openLauncher();
      }
    };
    const onOpen = (e: Event) => openLauncher((e as CustomEvent<OpenDetail>).detail);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("rally:open-task-launcher", onOpen);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("rally:open-task-launcher", onOpen);
    };
  }, [open, openLauncher, close]);

  // Click outside closes; Escape closes.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, close]);

  // Preview which checkout would be used.
  useEffect(() => {
    if (!open || targetPodId || !workspaceId || !project) return;
    if (fixedCwd) {
      setPick({ cwd: fixedCwd, reasons: [] });
      return;
    }
    let cancelled = false;
    setPick(null);
    findFreeCheckout(workspaceId, project).then((p) => {
      if (!cancelled) setPick(p);
    });
    return () => {
      cancelled = true;
    };
  }, [open, targetPodId, workspaceId, project, fixedCwd]);

  // Pasted images are saved to disk and listed in the prompt by path;
  // Claude opens them with its Read tool. Text pastes stay native.
  const onPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(e.clipboardData.items).filter((i) => i.type.startsWith("image/"));
    if (images.length === 0) return;
    e.preventDefault();
    for (const item of images) {
      const blob = item.getAsFile();
      if (!blob) continue;
      const mimeType = item.type;
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(",")[1];
        if (!base64) return;
        try {
          const path = await api.saveClipboardImage(base64, mimeType);
          setAttachments((prev) => [...prev, { path, preview: dataUrl }]);
        } catch (err) {
          setError(`Could not save image: ${String(err)}`);
        }
      };
      reader.readAsDataURL(blob);
    }
  }, []);

  const submit = useCallback(async () => {
    const description = text.trim();
    if ((!description && attachments.length === 0) || busy || !workspaceId) return;
    setBusy(true);
    setError(null);
    try {
      const paths = attachments.map((a) => a.path);
      if (targetPodId) {
        await sendToPod(workspaceId, targetPodId, description, paths);
      } else {
        if (!project) throw new Error("Pick a project");
        const fresh = fixedCwd ? { cwd: fixedCwd, reasons: [] } : await findFreeCheckout(workspaceId, project);
        if (!fresh.cwd) {
          setPick(fresh);
          throw new Error(`No free ${project} checkout`);
        }
        localStorage.setItem(LAST_PROJECT_KEY, project);
        localStorage.setItem(LAST_MODEL_KEY, model);
        await startTask({ workspaceId, cwd: fresh.cwd, description, kind: question ? "question" : "work", model, attachments: paths });
      }
      close();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }, [text, busy, workspaceId, targetPodId, fixedCwd, sendToPod, project, startTask, question, model, attachments, close]);

  if (!open) return null;

  const canSubmit = (text.trim().length > 0 || attachments.length > 0) && !busy && (targetPodId ? true : !!pick?.cwd);
  const previewText = targetPodId
    ? null
    : pick === null
      ? "Finding a free checkout…"
      : pick.cwd
        ? `→ ${folderName(pick.cwd)}`
        : `No free ${project} checkout`;

  return ReactDOM.createPortal(
    <div
      ref={cardRef}
      className="inline-edit-input"
      style={{
        ...styles.card,
        opacity: visible ? 1 : 0,
        transform: visible ? "translate(-50%, 0)" : "translate(-50%, -6px)",
      }}
    >
      <textarea
        ref={textRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
          e.stopPropagation();
        }}
        onPaste={onPaste}
        placeholder={targetPod ? `Message ${targetPod.label ?? folderName(targetPod.cwd)}…` : question ? "What do you want to know?" : "What should the agent do?"}
        rows={3}
        style={styles.textarea}
      />

      {attachments.length > 0 && (
        <div style={styles.attachments}>
          {attachments.map((a) => (
            <div key={a.path} style={styles.thumbWrap} title={a.path}>
              <img src={a.preview} alt="" style={styles.thumb} />
              <button
                className="sidebar-btn"
                style={styles.thumbRemove}
                onClick={() => setAttachments((prev) => prev.filter((x) => x.path !== a.path))}
                title="Remove"
              >
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true" style={{ display: "block" }}>
                  <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={styles.row}>
        {targetPod ? (
          <span style={styles.target}>
            → {targetPod.label ?? folderName(targetPod.cwd)}
            {targetPod.task?.description && <span style={styles.targetTask}>{shortDescription(targetPod.task.description, 48)}</span>}
          </span>
        ) : (
          <button
            ref={projectBtnRef}
            className="sidebar-btn"
            onClick={fixedCwd ? undefined : pickProject}
            style={{ ...styles.projectBtn, cursor: fixedCwd ? "default" : "pointer" }}
            title={fixedCwd ? `Starting in ${folderName(fixedCwd)}` : "Project"}
          >
            <span>{project ?? "Project"}</span>
            {project && (projects.find((p) => p.project === project)?.cwds.length ?? 0) > 1 && (
              <span style={styles.pillCount}>{projects.find((p) => p.project === project)?.cwds.length}</span>
            )}
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true" style={{ display: "block", visibility: fixedCwd ? "hidden" : "visible" }}>
              <path d="M1.5 3l2.5 2.5L6.5 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        {!targetPod && (
          <button ref={modelBtnRef} className="sidebar-btn" onClick={pickModel} style={styles.projectBtn} title="Model">
            <span>{MODEL_LABELS[model]}</span>
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true" style={{ display: "block" }}>
              <path d="M1.5 3l2.5 2.5L6.5 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        {!targetPod && (
          <button
            className="sidebar-btn"
            onClick={() => setQuestion((q) => !q)}
            title="Read-only question: no sync, no watcher, no branch, no PR"
            style={{
              ...styles.pill,
              marginLeft: "auto",
              color: question ? "var(--text-primary)" : "var(--text-dim)",
              background: question ? "rgba(255, 255, 255, 0.06)" : "transparent",
              borderColor: question ? "rgba(255, 255, 255, 0.1)" : "transparent",
            }}
          >
            Read-only question
          </button>
        )}
      </div>

      <div style={styles.footer}>
        <span style={{ ...styles.preview, color: error ? "var(--status-amber)" : pick && !pick.cwd && !targetPodId ? "var(--status-amber)" : "var(--text-secondary)" }}>
          {error ?? previewText}
          {pick && !pick.cwd && !targetPodId && pick.reasons.length > 0 && (
            <span style={styles.reasons}>
              {pick.reasons.map((r) => (
                <span key={r.cwd} style={styles.reason}>
                  {folderName(r.cwd)}: {r.reason}
                </span>
              ))}
            </span>
          )}
        </span>
        <span style={styles.hint}>
          <span>
            <kbd style={styles.kbd}>↩</kbd> {targetPod ? "send" : "start"}
          </span>
          <span>
            <kbd style={styles.kbd}>⇧↩</kbd> newline
          </span>
        </span>
        <button className="sidebar-btn" disabled={!canSubmit} onClick={() => void submit()} style={{ ...styles.startBtn, opacity: canSubmit ? 1 : 0.45 }}>
          {targetPod ? "Send" : "Start"}
        </button>
      </div>
    </div>,
    document.body,
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    position: "fixed",
    top: "16%",
    left: "50%",
    width: 640,
    maxWidth: "calc(100vw - 48px)",
    zIndex: 99999,
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: "14px 14px 12px",
    background: "#1b1b1b",
    border: "1px solid rgba(255, 255, 255, 0.08)",
    borderRadius: 12,
    boxShadow: "0 0 0 1px rgba(0, 0, 0, 0.6), 0 28px 80px rgba(0, 0, 0, 0.7)",
    transition: `opacity 140ms ${EASING}, transform 160ms ${EASING}`,
    userSelect: "none",
  },
  textarea: {
    width: "100%",
    resize: "none",
    minHeight: 84,
    background: "transparent",
    border: "none",
    color: "var(--text-primary)",
    fontSize: 15,
    fontFamily: "inherit",
    lineHeight: 1.5,
    padding: "2px 2px 0",
    outline: "none",
    boxSizing: "border-box",
  },
  attachments: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    padding: "0 2px",
  },
  thumbWrap: {
    position: "relative",
    width: 64,
    height: 48,
    borderRadius: 6,
    overflow: "hidden",
    border: "1px solid rgba(255, 255, 255, 0.1)",
    background: "rgba(255, 255, 255, 0.04)",
    flexShrink: 0,
  },
  thumb: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
  },
  thumbRemove: {
    position: "absolute",
    top: 3,
    right: 3,
    width: 16,
    height: 16,
    padding: 0,
    border: "none",
    borderRadius: 4,
    background: "rgba(0, 0, 0, 0.7)",
    color: "#ddd",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
  },
  projectBtn: {
    height: 24,
    padding: "0 10px",
    border: "1px solid rgba(255, 255, 255, 0.1)",
    borderRadius: 6,
    background: "rgba(255, 255, 255, 0.06)",
    color: "var(--text-primary)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 6,
    whiteSpace: "nowrap",
  },
  pill: {
    height: 24,
    padding: "0 10px",
    border: "1px solid transparent",
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 5,
    whiteSpace: "nowrap",
  },
  pillCount: {
    fontSize: 10,
    fontWeight: 600,
    opacity: 0.6,
  },
  target: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-primary)",
    padding: "0 6px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
  targetTask: {
    fontWeight: 500,
    color: "var(--text-dim)",
    marginLeft: 8,
  },
  footer: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 0 0",
    borderTop: "1px solid rgba(255, 255, 255, 0.07)",
    minWidth: 0,
  },
  preview: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    fontWeight: 600,
    lineHeight: 1.35,
    display: "-webkit-box",
    WebkitLineClamp: 3,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },
  reasons: {
    display: "block",
    fontWeight: 500,
    opacity: 0.8,
  },
  reason: {
    display: "block",
  },
  hint: {
    fontSize: 11,
    color: "var(--text-dim)",
    whiteSpace: "nowrap",
    flexShrink: 0,
    display: "flex",
    gap: 10,
  },
  kbd: {
    fontFamily: "inherit",
    fontSize: 10.5,
    padding: "1px 5px",
    background: "rgba(255, 255, 255, 0.07)",
    border: "1px solid rgba(255, 255, 255, 0.08)",
    borderRadius: 4,
    color: "var(--text-secondary)",
  },
  startBtn: {
    height: 26,
    padding: "0 14px",
    background: "#e8e8e8",
    border: "1px solid transparent",
    borderRadius: 6,
    color: "#111",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    flexShrink: 0,
  },
};
