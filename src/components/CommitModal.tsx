import React, { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../lib/tauri";
import { addToast } from "./ToastContainer";
import { useWorkspaceStore } from "../stores/workspaceStore";

type NextStep = "commit" | "commit-push" | "commit-pr";

interface CommitModalProps {
  open: boolean;
  onClose: () => void;
  rootPath: string;
  branch: string;
  stagedCount: number;
  unstagedCount: number;
  additions: number;
  deletions: number;
  onCommitted: () => void;
  anchorRef?: React.RefObject<HTMLButtonElement | null>;
  hasPr?: boolean;
}

export function CommitModal({
  open,
  onClose,
  rootPath,
  branch,
  stagedCount,
  unstagedCount,
  additions,
  deletions,
  onCommitted,
  anchorRef,
  hasPr,
}: CommitModalProps) {
  const [commitMsg, setCommitMsg] = useState("");
  const [nextStep, setNextStep] = useState<NextStep>("commit");
  const [includeUnstaged, setIncludeUnstaged] = useState(true);
  const [running, setRunning] = useState(false);
  const [visible, setVisible] = useState(false);
  const [cardPos, setCardPos] = useState<{ top: number; right: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Animate in + compute anchor position
  useEffect(() => {
    if (open) {
      setCommitMsg("");
      setNextStep("commit");
      setIncludeUnstaged(true);
      requestAnimationFrame(() => {
        if (anchorRef?.current && backdropRef.current) {
          const btnRect = anchorRef.current.getBoundingClientRect();
          const bgRect = backdropRef.current.getBoundingClientRect();
          // Account for CSS zoom on ancestor — coordinates from getBoundingClientRect
          // are in viewport space, but absolute positioning is in the zoomed local space
          const zoom = parseFloat(localStorage.getItem("rally:zoomLevel") || "1");
          setCardPos({
            top: (btnRect.bottom - bgRect.top + 6) / zoom,
            right: (bgRect.right - btnRect.right) / zoom,
          });
        } else {
          setCardPos(null);
        }
        requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      setCardPos(null);
    }
  }, [open, anchorRef]);

  // Focus textarea on open
  useEffect(() => {
    if (open && visible) {
      textareaRef.current?.focus();
    }
  }, [open, visible]);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open, onClose]);

  const totalFiles = stagedCount + (includeUnstaged ? unstagedCount : 0);

  const handleContinue = useCallback(async () => {
    if (!commitMsg.trim() || running) return;
    setRunning(true);
    try {
      // Stage unstaged + untracked files if requested
      if (includeUnstaged) {
        const changes = await api.gitChanges(rootPath);
        const filesToStage = [
          ...changes.unstaged.map((f) => f.path),
          ...changes.untracked,
        ];
        for (const f of filesToStage) {
          await api.gitStageFile(rootPath, f);
        }
      }

      // Commit what's staged
      await api.gitCommitStaged(rootPath, commitMsg.trim());

      // Post-commit actions
      if (nextStep === "commit-push" || nextStep === "commit-pr") {
        const pushResult = await api.gitPush(rootPath);
        addToast({ type: "success", title: "Pushed", message: pushResult.output });
      }

      if (nextStep === "commit-pr") {
        try {
          const prUrl = await api.gitCreatePr(rootPath);
          addToast({ type: "success", title: "PR Created", message: prUrl });
        } catch (e) {
          addToast({ type: "warning", title: "PR creation failed", message: String(e) });
        }
      }

      // Eagerly refresh PR status after push/PR creation so the badge appears immediately
      if (nextStep === "commit-push" || nextStep === "commit-pr") {
        useWorkspaceStore.getState().refreshPrStatusForPath(rootPath).catch(() => {});
      }

      addToast({ type: "success", title: "Committed!", message: "" });
      onCommitted();
      onClose();
    } catch (e) {
      addToast({ type: "warning", title: "Failed", message: String(e) });
    } finally {
      setRunning(false);
    }
  }, [commitMsg, nextStep, includeUnstaged, rootPath, running, onCommitted, onClose]);

  if (!open) return null;

  return renderModal();

  function renderModal() {

  const radioOptions: { value: NextStep; icon: React.ReactNode; label: string; sub?: string }[] = [
    {
      value: "commit",
      icon: (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.5"/>
          <line x1="0" y1="8" x2="5" y2="8" stroke="currentColor" strokeWidth="1.5"/>
          <line x1="11" y1="8" x2="16" y2="8" stroke="currentColor" strokeWidth="1.5"/>
        </svg>
      ),
      label: "Commit",
    },
    {
      value: "commit-push",
      icon: (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M8 12V4M5 7l3-3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      ),
      label: "Commit and push",
    },
    // Only show "Create PR" option when no PR exists yet
    ...(!hasPr ? [{
      value: "commit-pr" as NextStep,
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
        </svg>
      ),
      label: "Commit and create PR",
    }] : []),
  ];

  return (
    <div
      ref={backdropRef}
      style={{
        ...st.backdrop,
        opacity: visible ? 1 : 0,
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          ...st.card,
          transform: visible ? "translateY(0) scale(1)" : "translateY(8px) scale(0.98)",
          ...(cardPos ? {
            position: "absolute" as const,
            top: cardPos.top,
            right: cardPos.right,
          } : {}),
        }}
      >
        {/* Top row: icon + close */}
        <div style={st.topRow}>
          <svg width="20" height="20" viewBox="0 0 16 16" fill="none" style={{ color: "var(--text-primary)" }}>
            <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.5"/>
            <line x1="0" y1="8" x2="5" y2="8" stroke="currentColor" strokeWidth="1.5"/>
            <line x1="11" y1="8" x2="16" y2="8" stroke="currentColor" strokeWidth="1.5"/>
          </svg>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={st.closeBtn}>
            <svg width="14" height="14" viewBox="0 0 18 18" fill="none">
              <path d="M5 5l8 8M13 5l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Title */}
        <div style={st.title}>Commit your changes</div>

        {/* Info rows */}
        <div style={st.infoRows}>
          <div style={st.infoRow}>
            <span style={st.infoLabel}>Branch</span>
            <span style={st.infoValue}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style={{ opacity: 0.7 }}>
                <path d="M21.007 8.222A3.738 3.738 0 0 0 15.045 5.2a3.737 3.737 0 0 0 1.156 6.583 2.988 2.988 0 0 1-2.668 1.67h-2.99a4.456 4.456 0 0 0-2.989 1.165V7.4a3.737 3.737 0 1 0-1.494 0v9.117a3.776 3.776 0 1 0 1.816.099 2.99 2.99 0 0 1 2.668-1.667h2.99a4.484 4.484 0 0 0 4.223-3.039 3.736 3.736 0 0 0 3.25-3.687z" />
              </svg>
              {branch}
            </span>
          </div>
          <div style={st.infoRow}>
            <span style={st.infoLabel}>Changes</span>
            <span style={st.infoValue}>
              {totalFiles} file{totalFiles !== 1 ? "s" : ""}
              {(additions > 0 || deletions > 0) && (
                <>
                  {"  "}
                  <span style={{ color: "#3fb950", fontWeight: 500 }}>+{additions}</span>
                  {" "}
                  <span style={{ color: "#f85149", fontWeight: 500 }}>-{deletions}</span>
                </>
              )}
            </span>
          </div>
        </div>

        {/* Include unstaged toggle */}
        {unstagedCount > 0 && (
          <div style={st.toggleRow}>
            <button
              onClick={() => setIncludeUnstaged((v) => !v)}
              style={{
                ...st.toggle,
                background: includeUnstaged ? "#3b82f6" : "var(--border)",
                justifyContent: includeUnstaged ? "flex-end" : "flex-start",
              }}
            >
              <span style={st.toggleKnob} />
            </button>
            <span
              style={st.toggleLabel}
              onClick={() => setIncludeUnstaged((v) => !v)}
            >
              Include unstaged
            </span>
          </div>
        )}

        {/* Commit message */}
        <div style={st.section}>
          <span style={st.sectionLabel}>Commit message</span>
          <textarea
            ref={textareaRef}
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey) {
                e.preventDefault();
                handleContinue();
              }
            }}
            placeholder="Enter your commit message"
            style={st.textarea}
            rows={2}
          />
        </div>

        {/* Next steps */}
        <div style={st.section}>
          <span style={st.sectionLabel}>Next steps</span>
          <div style={st.radioGroup}>
            {radioOptions.map((opt, i) => (
              <React.Fragment key={opt.value}>
                <button
                  onClick={() => setNextStep(opt.value)}
                  style={st.radioBtn}
                >
                  <span style={st.radioIcon}>{opt.icon}</span>
                  <span style={st.radioContent}>
                    <span style={st.radioLabel}>{opt.label}</span>
                    {opt.sub && <span style={st.radioSub}>{opt.sub}</span>}
                  </span>
                  {nextStep === opt.value && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ marginLeft: "auto", color: "var(--text-primary)", flexShrink: 0 }}>
                      <path d="M5 13l5 5L20 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </button>
                {i < radioOptions.length - 1 && <div style={st.radioSeparator} />}
              </React.Fragment>
            ))}
          </div>
        </div>

        {/* Continue button */}
        <div style={st.btnContainer}>
          <button
            onClick={handleContinue}
            disabled={!commitMsg.trim() || running}
            style={{
              ...st.continueBtn,
              opacity: commitMsg.trim() && !running ? 1 : 0.4,
            }}
          >
            {running ? "Working..." : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
  } // end renderModal
}

const st: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "absolute",
    inset: 0,
    zIndex: 10000,
    background: "transparent",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "opacity 100ms ease",
  },
  card: {
    width: 360,
    maxWidth: "90vw",
    background: "var(--bg-elevated)",
    borderRadius: 14,
    border: "0.5px solid var(--border-subtle)",
    display: "flex",
    flexDirection: "column",
    transition: "transform 100ms ease",
    overflow: "hidden",
    boxShadow: "0 8px 32px var(--shadow)",
  },
  topRow: {
    display: "flex",
    alignItems: "center",
    padding: "16px 16px 0 16px",
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "var(--text-dim)",
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    borderRadius: 6,
  },
  title: {
    fontSize: 17,
    fontWeight: 700,
    color: "var(--text-primary)",
    padding: "14px 16px 0 16px",
    letterSpacing: "-0.03em",
    lineHeight: "1.2",
  },
  infoRows: {
    padding: "14px 16px 0",
    display: "flex",
    flexDirection: "column",
    gap: 7,
  },
  infoRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  infoLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
    letterSpacing: "-0.01em",
  },
  infoValue: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
    display: "flex",
    alignItems: "center",
    gap: 5,
    fontFamily: "inherit",
  },
  toggleRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "12px 16px 0",
  },
  toggle: {
    width: 32,
    height: 18,
    borderRadius: 9,
    border: "none",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    padding: "0 2px",
    transition: "background 200ms, justify-content 200ms",
    flexShrink: 0,
  },
  toggleKnob: {
    width: 14,
    height: 14,
    borderRadius: "50%",
    background: "var(--bg-elevated)",
    display: "block",
    transition: "transform 200ms",
    boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
  },
  toggleLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
    cursor: "pointer",
    userSelect: "none" as const,
    letterSpacing: "-0.01em",
  },
  section: {
    padding: "14px 16px 0",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
    letterSpacing: "-0.01em",
  },
  textarea: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid var(--border-subtle)",
    background: "var(--bg-surface)",
    color: "var(--text-primary)",
    fontSize: 13,
    fontFamily: "inherit",
    outline: "none",
    resize: "none" as const,
    lineHeight: "1.5",
    boxSizing: "border-box" as const,
  },
  radioGroup: {
    display: "flex",
    flexDirection: "column",
    background: "var(--bg-surface)",
    borderRadius: 8,
    overflow: "hidden",
  },
  radioBtn: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 10px",
    border: "none",
    cursor: "pointer",
    transition: "background 150ms",
    background: "transparent",
    textAlign: "left" as const,
  },
  radioSeparator: {
    height: 1,
    background: "var(--bg-hover)",
    margin: "0 10px",
  },
  radioIcon: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 18,
    flexShrink: 0,
    color: "var(--text-primary)",
  },
  radioContent: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    flex: 1,
  },
  radioLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
    letterSpacing: "-0.01em",
  },
  radioSub: {
    fontSize: 11,
    color: "var(--text-dim)",
    fontWeight: 400,
  },
  btnContainer: {
    padding: "14px 16px 16px",
  },
  continueBtn: {
    width: "100%",
    padding: "9px 0",
    borderRadius: 8,
    border: "none",
    background: "var(--text-primary)",
    color: "var(--bg-app)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    transition: "opacity 150ms",
    letterSpacing: "-0.01em",
  },
};
