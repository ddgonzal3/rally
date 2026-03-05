import React, { useState, useEffect, useRef, useCallback } from "react";

interface SyncConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  branch: string;
  mainBranch: string;
  behind: number;
  anchorRef?: React.RefObject<HTMLButtonElement | null>;
}

export function SyncConfirmModal({
  open,
  onClose,
  onConfirm,
  branch,
  mainBranch,
  behind,
  anchorRef,
}: SyncConfirmModalProps) {
  const [running, setRunning] = useState(false);
  const [visible, setVisible] = useState(false);
  const [cardPos, setCardPos] = useState<{ top: number; right: number } | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Animate in + compute anchor position
  useEffect(() => {
    if (open) {
      setRunning(false);
      requestAnimationFrame(() => {
        if (anchorRef?.current && backdropRef.current) {
          const btnRect = anchorRef.current.getBoundingClientRect();
          const bgRect = backdropRef.current.getBoundingClientRect();
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

  const handleConfirm = useCallback(async () => {
    if (running) return;
    setRunning(true);
    try {
      await onConfirm();
      onClose();
    } catch {
      // Toast is handled by the caller
    } finally {
      setRunning(false);
    }
  }, [running, onConfirm, onClose]);

  if (!open) return null;

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
            <path
              d="M2.5 8a5.5 5.5 0 0 1 9.3-3.95L10 6h5V1l-1.8 1.8A7.5 7.5 0 0 0 .5 8h2zm11 0a5.5 5.5 0 0 1-9.3 3.95L6 10H1v5l1.8-1.8A7.5 7.5 0 0 0 15.5 8h-2z"
              fill="currentColor"
            />
          </svg>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={st.closeBtn}>
            <svg width="14" height="14" viewBox="0 0 18 18" fill="none">
              <path d="M5 5l8 8M13 5l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Title */}
        <div style={st.title}>Sync branch</div>

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
            <span style={st.infoLabel}>Behind</span>
            <span style={st.infoValue}>
              {behind} commit{behind !== 1 ? "s" : ""} behind {mainBranch}
            </span>
          </div>
        </div>

        {/* Description */}
        <div style={st.description}>
          This will rebase <strong>{branch}</strong> onto <strong>{mainBranch}</strong> to incorporate the latest changes.
        </div>

        {/* Confirm button */}
        <div style={st.btnContainer}>
          <button
            onClick={handleConfirm}
            disabled={running}
            style={{
              ...st.confirmBtn,
              opacity: running ? 0.4 : 1,
            }}
          >
            {running ? "Syncing..." : "Sync"}
          </button>
        </div>
      </div>
    </div>
  );
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
    width: 340,
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
  description: {
    fontSize: 13,
    fontWeight: 400,
    color: "var(--text-secondary)",
    padding: "14px 16px 0",
    lineHeight: "1.5",
    letterSpacing: "-0.01em",
  },
  btnContainer: {
    padding: "14px 16px 16px",
  },
  confirmBtn: {
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
