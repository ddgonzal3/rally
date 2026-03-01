import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { api } from "../lib/tauri";
import { addToast } from "./ToastContainer";
import type { BranchInfo } from "../lib/types";

interface BranchSwitcherProps {
  rootPath: string;
  branchName: string;
  mainBranch: string;
  onBranchChanged: () => void;
  /** Style variant: "pill" for git panel header, "inline" for product view info bar */
  variant?: "pill" | "inline";
}

export function BranchSwitcher({
  rootPath,
  branchName,
  mainBranch,
  onBranchChanged,
  variant = "pill",
}: BranchSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [filter, setFilter] = useState("");
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [switching, setSwitching] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [forceDeleteMode, setForceDeleteMode] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const openDropdown = useCallback(async () => {
    setOpen(true);
    setFilter("");
    setCreatingBranch(false);
    setNewBranchName("");
    setConfirmingDelete(null);
    setForceDeleteMode(false);
    try {
      const list = await api.gitListBranches(rootPath);
      setBranches(list);
    } catch {
      setBranches([]);
    }
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [rootPath]);

  const handleCheckout = useCallback(
    async (branch: string) => {
      if (switching) return;
      setSwitching(true);
      try {
        await api.gitCheckoutBranch(rootPath, branch);
        addToast({ type: "success", title: "Branch switched", message: branch });
        setOpen(false);
        onBranchChanged();
      } catch (e) {
        addToast({ type: "warning", title: "Checkout failed", message: String(e) });
      } finally {
        setSwitching(false);
      }
    },
    [rootPath, switching, onBranchChanged],
  );

  const handleCreate = useCallback(async () => {
    if (!newBranchName.trim() || switching) return;
    setSwitching(true);
    try {
      await api.gitCreateBranch(rootPath, newBranchName.trim());
      addToast({ type: "success", title: "Branch created", message: newBranchName.trim() });
      setOpen(false);
      onBranchChanged();
    } catch (e) {
      addToast({ type: "warning", title: "Create branch failed", message: String(e) });
    } finally {
      setSwitching(false);
    }
  }, [rootPath, newBranchName, switching, onBranchChanged]);

  const handleDelete = useCallback(
    async (branch: string, force = false) => {
      if (switching) return;
      setSwitching(true);
      try {
        await api.gitDeleteBranch(rootPath, branch, force);
        addToast({ type: "success", title: force ? "Branch force deleted" : "Branch deleted", message: branch });
        setConfirmingDelete(null);
        setForceDeleteMode(false);
        const list = await api.gitListBranches(rootPath);
        setBranches(list);
      } catch (e) {
        const msg = String(e);
        if (!force && msg.includes("not fully merged")) {
          // Show force-delete confirmation instead of auto-escalating
          setForceDeleteMode(true);
        } else {
          addToast({ type: "warning", title: "Delete failed", message: msg });
          setConfirmingDelete(null);
          setForceDeleteMode(false);
        }
      } finally {
        setSwitching(false);
      }
    },
    [rootPath, switching],
  );

  // Click-outside to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Escape key
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        if (confirmingDelete) {
          setConfirmingDelete(null);
          setForceDeleteMode(false);
        } else if (creatingBranch) {
          setCreatingBranch(false);
        } else {
          setOpen(false);
        }
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open, creatingBranch, confirmingDelete]);

  const filtered = useMemo(
    () => branches.filter((b) => b.name.toLowerCase().includes(filter.toLowerCase())),
    [branches, filter],
  );

  const isPill = variant === "pill";

  return (
    <div ref={dropdownRef} style={{ position: "relative" }}>
      <button
        onClick={() => (open ? setOpen(false) : openDropdown())}
        style={
          isPill
            ? {
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                fontSize: 13,
                color: "#e6edf3",
                fontWeight: 600,
                cursor: "pointer",
                border: "none",
                borderRadius: 6,
                padding: "2px 8px",
                lineHeight: "16px",
                minWidth: 0,
                overflow: "hidden",
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
                background: open ? "rgba(255,255,255,0.12)" : "none",
              }
            : {
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                fontSize: 11,
                color: "#bbb",
                fontWeight: 400,
                cursor: "pointer",
                border: "none",
                borderRadius: 4,
                padding: "1px 4px",
                background: open ? "rgba(255,255,255,0.08)" : "none",
                marginLeft: 8,
              }
        }
        onMouseEnter={(e) => {
          if (!open)
            (e.currentTarget as HTMLElement).style.background =
              isPill ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.06)";
        }}
        onMouseLeave={(e) => {
          if (!open)
            (e.currentTarget as HTMLElement).style.background = "none";
        }}
      >
        {isPill && (
          <svg
            width="15"
            height="15"
            viewBox="0 0 16 16"
            fill="none"
            stroke="#e6edf3"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="5" cy="4" r="1.5" />
            <circle cx="5" cy="12" r="1.5" />
            <circle cx="12" cy="8" r="1.5" />
            <path d="M5 5.5v5M12 6.5c0-2-1.5-2.5-3.5-2.5" />
          </svg>
        )}
        {!isPill && (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, position: "relative", top: 1, left: 1 }}>
            <path
              d="M5 3v6.5a2.5 2.5 0 005 0V3"
              stroke="#bbb"
              strokeWidth="1.1"
              strokeLinecap="round"
            />
            <circle cx="5" cy="3" r="1.3" stroke="#bbb" strokeWidth="1.0" />
            <circle cx="10" cy="3" r="1.3" stroke="#bbb" strokeWidth="1.0" />
            <circle cx="10" cy="12" r="1.3" stroke="#bbb" strokeWidth="1.0" />
          </svg>
        )}
        {branchName}
        <svg
          width={isPill ? 10 : 8}
          height={isPill ? 10 : 8}
          viewBox="0 0 10 10"
          fill="none"
          stroke={isPill ? "#999" : "#888"}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ marginLeft: isPill ? 2 : 0, flexShrink: 0 }}
        >
          <path d="M2.5 4L5 6.5L7.5 4" />
        </svg>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            ...(isPill ? { right: 0 } : { left: 0 }),
            minWidth: 240,
            maxWidth: 360,
            background: "rgba(36, 36, 36, 0.78)",
            backdropFilter: "blur(20px) saturate(180%)",
            WebkitBackdropFilter: "blur(20px) saturate(180%)",
            border: "1px solid rgba(255, 255, 255, 0.12)",
            borderRadius: 8,
            boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
            zIndex: 1000,
            display: "flex",
            flexDirection: "column" as const,
            overflow: "hidden",
          }}
        >
          {/* Search input */}
          <div style={{ padding: "8px 8px 4px" }}>
            <input
              ref={searchRef}
              type="text"
              placeholder="Filter branches..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && filtered.length > 0) {
                  const first = filtered.find((b) => !b.is_current);
                  if (first) handleCheckout(first.name);
                }
              }}
              style={{
                width: "100%",
                padding: "5px 8px",
                fontSize: 13,
                color: "#e0e0e0",
                background: "rgba(255,255,255,0.08)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 5,
                outline: "none",
                boxSizing: "border-box" as const,
              }}
            />
          </div>

          {/* Branch list */}
          <div style={{ maxHeight: 300, overflowY: "auto", padding: "4px 0" }}>
            {filtered.length === 0 && (
              <div style={{ padding: "8px 12px", fontSize: 12, color: "#999" }}>
                No branches found
              </div>
            )}
            {filtered.map((b) => (
              <div
                key={b.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  position: "relative",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background =
                    "rgba(255,255,255,0.08)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = "none";
                }}
              >
                {/* Confirm delete inline */}
                {confirmingDelete === b.name ? (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      width: "100%",
                      padding: "5px 12px",
                      fontSize: 12,
                    }}
                  >
                    <span style={{ color: forceDeleteMode ? "#e8a838" : "#e0e0e0", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {forceDeleteMode
                        ? <>Unmerged commits will be lost!</>
                        : <>Delete <strong>{b.name}</strong>?</>}
                    </span>
                    <button
                      onClick={() => handleDelete(b.name, forceDeleteMode)}
                      disabled={switching}
                      style={{
                        padding: "2px 8px",
                        fontSize: 11,
                        color: "#ff6b6b",
                        background: "rgba(255,107,107,0.12)",
                        border: "1px solid rgba(255,107,107,0.25)",
                        borderRadius: 4,
                        cursor: "pointer",
                        flexShrink: 0,
                      }}
                    >
                      {forceDeleteMode ? "Force Delete" : "Delete"}
                    </button>
                    <button
                      onClick={() => { setConfirmingDelete(null); setForceDeleteMode(false); }}
                      style={{
                        padding: "2px 8px",
                        fontSize: 11,
                        color: "#e0e0e0",
                        background: "rgba(255,255,255,0.08)",
                        border: "1px solid rgba(255,255,255,0.12)",
                        borderRadius: 4,
                        cursor: "pointer",
                        flexShrink: 0,
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      onClick={() => {
                        if (!b.is_current) handleCheckout(b.name);
                      }}
                      disabled={switching}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        flex: 1,
                        padding: "5px 12px",
                        fontSize: 13,
                        color: b.is_current ? "#fff" : "#e0e0e0",
                        fontWeight: b.is_current ? 600 : 400,
                        background: "none",
                        border: "none",
                        cursor: b.is_current ? "default" : "pointer",
                        textAlign: "left" as const,
                        opacity: switching ? 0.5 : 1,
                        minWidth: 0,
                      }}
                    >
                      <span
                        style={{
                          width: 14,
                          flexShrink: 0,
                          textAlign: "center" as const,
                          fontSize: 11,
                        }}
                      >
                        {b.is_current ? "✓" : ""}
                      </span>
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          minWidth: 0,
                        }}
                      >
                        {b.name}
                      </span>
                    </button>
                    {/* Delete button — hidden for current branch and main branch */}
                    {!b.is_current && b.name !== mainBranch && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmingDelete(b.name);
                        }}
                        title={`Delete ${b.name}`}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 22,
                          height: 22,
                          marginRight: 8,
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          borderRadius: 4,
                          opacity: 0.4,
                          flexShrink: 0,
                        }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLElement).style.opacity = "1";
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLElement).style.opacity = "0.4";
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                          <path
                            d="M4.5 3V2.5a1 1 0 011-1h5a1 1 0 011 1V3M3 3.5h10M6 6.5v4M10 6.5v4M3.5 3.5l.5 9a1 1 0 001 1h6a1 1 0 001-1l.5-9"
                            stroke="#999"
                            strokeWidth="1.1"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>

          {/* Divider + Create branch */}
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", padding: "4px 0" }}>
            {!creatingBranch ? (
              <button
                onClick={() => {
                  setCreatingBranch(true);
                  setNewBranchName("");
                  requestAnimationFrame(() => {
                    const inp = dropdownRef.current?.querySelector<HTMLInputElement>(
                      "input[data-create-branch]",
                    );
                    inp?.focus();
                  });
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  padding: "5px 12px",
                  fontSize: 13,
                  color: "#e0e0e0",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  textAlign: "left" as const,
                }}
                onMouseEnter={(e) =>
                  ((e.currentTarget as HTMLElement).style.background =
                    "rgba(255,255,255,0.08)")
                }
                onMouseLeave={(e) =>
                  ((e.currentTarget as HTMLElement).style.background = "none")
                }
              >
                <span style={{ width: 14, flexShrink: 0, textAlign: "center" as const, fontSize: 13 }}>+</span>
                <span>Create branch</span>
              </button>
            ) : (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 8px",
                }}
              >
                <input
                  data-create-branch=""
                  type="text"
                  placeholder="new-branch-name"
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleCreate();
                    }
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setCreatingBranch(false);
                    }
                  }}
                  disabled={switching}
                  style={{
                    flex: 1,
                    padding: "4px 8px",
                    fontSize: 13,
                    color: "#e0e0e0",
                    background: "rgba(255,255,255,0.08)",
                    border: "1px solid rgba(255,255,255,0.12)",
                    borderRadius: 5,
                    outline: "none",
                    minWidth: 0,
                  }}
                />
                <button
                  onClick={handleCreate}
                  disabled={!newBranchName.trim() || switching}
                  style={{
                    padding: "4px 10px",
                    fontSize: 12,
                    color: "#e0e0e0",
                    background: "rgba(255,255,255,0.1)",
                    border: "1px solid rgba(255,255,255,0.12)",
                    borderRadius: 5,
                    cursor:
                      newBranchName.trim() && !switching ? "pointer" : "default",
                    opacity: newBranchName.trim() && !switching ? 1 : 0.4,
                    flexShrink: 0,
                  }}
                >
                  Create
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
