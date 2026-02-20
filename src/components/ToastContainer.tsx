import React, { useEffect, useState, useCallback } from "react";
import { create } from "zustand";

// --- Toast Store ---

export interface Toast {
  id: string;
  type: "info" | "success" | "warning";
  title: string;
  message: string;
  actions?: { label: string; onClick: () => void }[];
  duration?: number; // ms, default 8000. 0 = persistent until dismissed
}

interface ToastState {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, "id">) => string;
  dismissToast: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (toast) => {
    const id = crypto.randomUUID();
    set((s) => {
      // Keep max 5 in the store, auto-dismiss oldest if over limit
      const updated = [{ ...toast, id }, ...s.toasts];
      return { toasts: updated.slice(0, 5) };
    });
    return id;
  },
  dismissToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

/** Convenience: add a toast from anywhere (no hook needed) */
export const addToast = useToastStore.getState().addToast;

// --- Individual Toast ---

const TYPE_COLORS: Record<Toast["type"], string> = {
  info: "#3b82f6",
  success: "#22c55e",
  warning: "#f59e0b",
};

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [closing, setClosing] = useState(false);

  const dismiss = useCallback(() => {
    setClosing(true);
    setTimeout(onDismiss, 200); // match animation duration
  }, [onDismiss]);

  useEffect(() => {
    const duration = toast.duration ?? 8000;
    if (duration === 0) return; // persistent
    const timer = setTimeout(dismiss, duration);
    return () => clearTimeout(timer);
  }, [toast.duration, dismiss]);

  const accentColor = TYPE_COLORS[toast.type];

  return (
    <div
      style={{
        ...cardStyles.card,
        opacity: closing ? 0 : 1,
        transform: closing ? "translateX(-20px)" : "translateX(0)",
        transition: "opacity 0.2s ease, transform 0.2s ease",
      }}
    >
      <div style={{ ...cardStyles.accent, background: accentColor }} />
      <div style={cardStyles.content}>
        <div style={cardStyles.header}>
          <span style={cardStyles.title}>{toast.title}</span>
          <button style={cardStyles.closeBtn} onClick={dismiss} title="Dismiss">
            ×
          </button>
        </div>
        <div style={cardStyles.message}>{toast.message}</div>
        {toast.actions && toast.actions.length > 0 && (
          <div style={cardStyles.actions}>
            {toast.actions.map((action, i) => (
              <button
                key={i}
                style={cardStyles.actionBtn}
                onClick={() => {
                  action.onClick();
                  // Only auto-dismiss non-persistent toasts on action click
                  if (toast.duration !== 0) dismiss();
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const cardStyles: Record<string, React.CSSProperties> = {
  card: {
    background: "#2a2a2a",
    borderRadius: 6,
    minWidth: 280,
    maxWidth: 360,
    boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
    pointerEvents: "auto",
    overflow: "hidden",
    display: "flex",
  },
  accent: {
    width: 3,
    flexShrink: 0,
  },
  content: {
    flex: 1,
    padding: "10px 12px",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 8,
  },
  title: {
    fontSize: 12,
    fontWeight: 600,
    color: "#e0e0e0",
    lineHeight: "1.3",
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "#888",
    fontSize: 16,
    cursor: "pointer",
    padding: "0 2px",
    lineHeight: "1",
    flexShrink: 0,
  },
  message: {
    fontSize: 11,
    color: "#999",
    marginTop: 4,
    lineHeight: "1.4",
  },
  actions: {
    display: "flex",
    gap: 6,
    marginTop: 8,
  },
  actionBtn: {
    background: "#3a3a3a",
    border: "1px solid #4a4a4a",
    color: "#ccc",
    fontSize: 11,
    padding: "3px 10px",
    borderRadius: 4,
    cursor: "pointer",
  },
};

// --- Toast Container ---

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const dismissToast = useToastStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div style={containerStyles.container}>
      {toasts.map((toast) => (
        <ToastCard
          key={toast.id}
          toast={toast}
          onDismiss={() => dismissToast(toast.id)}
        />
      ))}
    </div>
  );
}

const containerStyles: Record<string, React.CSSProperties> = {
  container: {
    position: "fixed",
    bottom: 40,
    left: 12,
    zIndex: 1000,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    pointerEvents: "none",
  },
};
