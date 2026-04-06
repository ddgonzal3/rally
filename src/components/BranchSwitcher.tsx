import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/tauri";
import { addToast } from "./ToastContainer";
import type { BranchInfo } from "../lib/types";

interface BranchSwitcherProps {
  rootPath: string;
  branchName: string;
  mainBranch: string;
  onBranchChanged: () => void;
  /** Style variant: "pill" for git panel header, "inline" for product view info bar, "footer" for pod footer */
  variant?: "pill" | "inline" | "footer";
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
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("rally:branchFavorites");
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { return new Set(); }
  });
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [switching, setSwitching] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [forceDeleteMode, setForceDeleteMode] = useState(false);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; right: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const openDropdown = useCallback(async () => {
    // Calculate position from button before opening
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const zoom = parseFloat(localStorage.getItem("rally:zoomLevel") || "1");
      if (variant === "footer") {
        // Open upward from footer — account for CSS zoom on coordinates
        setDropdownPos({
          top: rect.top * zoom,
          left: rect.left * zoom,
          right: (window.innerWidth - rect.right) * zoom,
        });
      } else {
        setDropdownPos({
          top: rect.bottom + 4,
          left: rect.left,
          right: window.innerWidth - rect.right,
        });
      }
    }
    setOpen(true);
    // Restore saved filter prefix (e.g. "danny/")
    const saved = localStorage.getItem("rally:branchFilter") ?? "";
    setFilter(saved);
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
    requestAnimationFrame(() => {
      searchRef.current?.focus();
      // Select all so typing replaces the saved filter
      searchRef.current?.select();
    });
  }, [rootPath, variant]);

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

  // Click-outside to close — check both button and portal dropdown
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        buttonRef.current && !buttonRef.current.contains(target) &&
        dropdownRef.current && !dropdownRef.current.contains(target)
      ) {
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

  const toggleFavorite = useCallback((name: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      localStorage.setItem("rally:branchFavorites", JSON.stringify([...next]));
      return next;
    });
  }, []);

  const filtered = useMemo(() => {
    const matched = branches.filter((b) => b.name.toLowerCase().includes(filter.toLowerCase()));
    // Sort: current first, then favorites, then the rest
    return matched.sort((a, b) => {
      if (a.is_current !== b.is_current) return a.is_current ? -1 : 1;
      const aFav = favorites.has(a.name);
      const bFav = favorites.has(b.name);
      if (aFav !== bFav) return aFav ? -1 : 1;
      return 0;
    });
  }, [branches, filter, favorites]);

  const isPill = variant === "pill";
  const isFooter = variant === "footer";

  const buttonStyle: React.CSSProperties = isPill
    ? {
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 13,
        color: "var(--text-primary)",
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
        background: open ? "var(--bg-active)" : "none",
      }
    : isFooter
      ? {
          display: "inline-flex",
          alignItems: "center",
          gap: 3,
          fontSize: 12,
          color: "var(--text-primary)",
          opacity: open ? 1 : 0.7,
          cursor: "pointer",
          border: "none",
          borderRadius: 4,
          padding: "1px 4px",
          lineHeight: 1,
          whiteSpace: "nowrap",
          background: open ? "var(--bg-hover)" : "none",
          flexShrink: 0,
        }
      : {
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontSize: 12,
          color: "var(--text-secondary)",
          fontWeight: 600,
          cursor: "pointer",
          border: "none",
          borderRadius: 4,
          padding: "1px 4px",
          background: open ? "var(--bg-hover)" : "none",
        };

  return (
    <>
      <button
        ref={buttonRef}
        onClick={(e) => { e.stopPropagation(); open ? setOpen(false) : openDropdown(); }}
        style={buttonStyle}
        onMouseEnter={(e) => {
          if (!open) {
            (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)";
            if (isFooter) (e.currentTarget as HTMLElement).style.opacity = "1";
          }
        }}
        onMouseLeave={(e) => {
          if (!open) {
            (e.currentTarget as HTMLElement).style.background = "none";
            if (isFooter) (e.currentTarget as HTMLElement).style.opacity = "0.7";
          }
        }}
      >
        {isPill && (
          <svg
            width="15"
            height="15"
            viewBox="0 0 16 16"
            fill="none"
            stroke="var(--text-primary)"
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
        {!isPill && !isFooter && (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, position: "relative", top: 1, left: 1 }}>
            <path
              d="M5 3v6.5a2.5 2.5 0 005 0V3"
              stroke="var(--text-secondary)"
              strokeWidth="1.1"
              strokeLinecap="round"
            />
            <circle cx="5" cy="3" r="1.3" stroke="var(--text-secondary)" strokeWidth="1.0" />
            <circle cx="10" cy="3" r="1.3" stroke="var(--text-secondary)" strokeWidth="1.0" />
            <circle cx="10" cy="12" r="1.3" stroke="var(--text-secondary)" strokeWidth="1.0" />
          </svg>
        )}
        {branchName}
        {!isFooter && (
          <svg
            width={isPill ? 10 : 8}
            height={isPill ? 10 : 8}
            viewBox="0 0 10 10"
            fill="none"
            stroke="var(--text-dim)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ marginLeft: isPill ? 2 : 0, flexShrink: 0 }}
          >
            <path d="M2.5 4L5 6.5L7.5 4" />
          </svg>
        )}
      </button>

      {open && dropdownPos && createPortal(
        <div
          ref={dropdownRef}
          style={{
            position: "fixed",
            ...(variant === "footer"
              ? { bottom: window.innerHeight - dropdownPos.top + 4, left: dropdownPos.left }
              : { top: dropdownPos.top, right: dropdownPos.right }),
            minWidth: 240,
            maxWidth: 360,
            background: "var(--frosted-bg)",
            backdropFilter: "blur(20px) saturate(180%)",
            WebkitBackdropFilter: "blur(20px) saturate(180%)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 8,
            boxShadow: "0 8px 32px var(--shadow)",
            zIndex: 10000,
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
              onChange={(e) => {
                setFilter(e.target.value);
                localStorage.setItem("rally:branchFilter", e.target.value);
              }}
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
                color: "var(--text-primary)",
                background: "var(--bg-hover)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 5,
                outline: "none",
                boxSizing: "border-box" as const,
              }}
            />
          </div>

          {/* Branch list */}
          <div style={{ maxHeight: 300, overflowY: "auto", padding: "4px 0" }}>
            {filtered.length === 0 && (
              <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--text-dim)" }}>
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
                    "var(--bg-hover)";
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
                    <span style={{ color: forceDeleteMode ? "#e8a838" : "var(--text-primary)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
                        color: "var(--text-primary)",
                        background: "var(--bg-hover)",
                        border: "1px solid var(--border-subtle)",
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
                        color: "var(--text-primary)",
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
                    {/* Fixed-width action buttons so alignment is consistent */}
                    <div style={{ display: "flex", alignItems: "center", flexShrink: 0, width: 56, justifyContent: "flex-end", marginRight: 8 }}>
                    {/* Favorite toggle */}
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleFavorite(b.name); }}
                      title={favorites.has(b.name) ? "Remove from favorites" : "Add to favorites"}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 24,
                        height: 24,
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        borderRadius: 4,
                        opacity: favorites.has(b.name) ? 0.9 : 0.3,
                        flexShrink: 0,
                        padding: 0,
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = favorites.has(b.name) ? "0.9" : "0.3"; }}
                    >
                      <svg width="13" height="13" viewBox="0 0 16 16" fill={favorites.has(b.name) ? "var(--text-secondary)" : "none"}>
                        <path
                          d="M8 1.5l2 4.1 4.5.6-3.25 3.2.77 4.5L8 11.7l-4.02 2.2.77-4.5L1.5 6.2l4.5-.6z"
                          stroke="var(--text-secondary)"
                          strokeWidth="1.1"
                          strokeLinejoin="round"
                        />
                      </svg>
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
                          width: 24,
                          height: 24,
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          borderRadius: 4,
                          opacity: 0.6,
                        }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLElement).style.opacity = "1";
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLElement).style.opacity = "0.6";
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                          <path
                            d="M4.5 3V2.5a1 1 0 011-1h5a1 1 0 011 1V3M3 3.5h10M6 6.5v4M10 6.5v4M3.5 3.5l.5 9a1 1 0 001 1h6a1 1 0 001-1l.5-9"
                            stroke="var(--text-secondary)"
                            strokeWidth="1.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    )}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>

          {/* Divider + Create branch */}
          <div style={{ borderTop: "1px solid var(--bg-hover)", padding: "4px 0" }}>
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
                  color: "var(--text-primary)",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  textAlign: "left" as const,
                }}
                onMouseEnter={(e) =>
                  ((e.currentTarget as HTMLElement).style.background =
                    "var(--bg-hover)")
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
                    color: "var(--text-primary)",
                    background: "var(--bg-hover)",
                    border: "1px solid var(--border-subtle)",
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
                    color: "var(--text-primary)",
                    background: "var(--bg-active)",
                    border: "1px solid var(--border-subtle)",
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
        </div>,
        document.body,
      )}
    </>
  );
}
