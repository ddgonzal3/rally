import React, { useState, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useWorkspaceStore } from "../stores/workspaceStore";

interface RepoSwitcherProps {
  workspaceId: string;
  rootPath: string;
}

export function RepoSwitcher({ workspaceId, rootPath }: RepoSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const setActivePathIndex = useWorkspaceStore((s) => s.setActivePathIndex);
  const refreshGitStatusForPath = useWorkspaceStore((s) => s.refreshGitStatusForPath);

  const paths = workspace?.paths ?? [];
  const mainBranch = workspace?.main_branch ?? "main";
  const currentBasename = rootPath.split("/").pop() || rootPath;

  const openDropdown = useCallback(() => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom + 4, left: rect.left });
    }
    setOpen(true);
  }, []);

  const handleSelect = useCallback((index: number, path: string) => {
    setActivePathIndex(workspaceId, index);
    setOpen(false);
    refreshGitStatusForPath(path, mainBranch).catch(() => {});
  }, [workspaceId, mainBranch, setActivePathIndex, refreshGitStatusForPath]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  // Don't render for single-repo workspaces
  if (paths.length <= 1) return null;

  return (
    <>
      <button
        ref={buttonRef}
        onClick={openDropdown}
        style={btnStyle}
        title="Switch repository"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
          <path
            d="M2 4.5A1.5 1.5 0 013.5 3H6l1 1.5h5.5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z"
            stroke="var(--text-secondary)"
            strokeWidth="1.1"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
        <span style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 600 }}>{currentBasename}</span>
        <svg width="8" height="8" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginLeft: -1 }}>
          <path d="M4 6l4 4 4-4" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && dropdownPos && createPortal(
        <div ref={dropdownRef} style={{ ...dropdownStyle, top: dropdownPos.top, left: dropdownPos.left }}>
          {paths.map((p, i) => {
            const basename = p.split("/").pop() || p;
            const isActive = p === rootPath;
            return (
              <div
                key={p}
                onClick={() => handleSelect(i, p)}
                style={{
                  ...itemStyle,
                  background: isActive ? "var(--bg-active)" : "transparent",
                }}
                onMouseEnter={(e) => {
                  if (!isActive) (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  if (!isActive) (e.currentTarget as HTMLElement).style.background = "transparent";
                }}
              >
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                  <path
                    d="M2 4.5A1.5 1.5 0 013.5 3H6l1 1.5h5.5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z"
                    stroke="var(--text-secondary)"
                    strokeWidth="1.1"
                    strokeLinejoin="round"
                    fill="none"
                  />
                </svg>
                <span style={{ fontSize: 12, color: "var(--text-primary)", fontWeight: 400 }}>{basename}</span>
                {isActive && (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ marginLeft: "auto", flexShrink: 0 }}>
                    <path d="M3 8l3.5 3.5L13 5" stroke="var(--text-secondary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
            );
          })}
        </div>,
        document.body
      )}
    </>
  );
}

const btnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  background: "none",
  border: "none",
  cursor: "pointer",
  padding: "0 2px",
  borderRadius: 4,
};

const dropdownStyle: React.CSSProperties = {
  position: "fixed",
  zIndex: 99999,
  minWidth: 180,
  maxWidth: 300,
  background: "var(--frosted-bg)",
  backdropFilter: "blur(20px) saturate(180%)",
  WebkitBackdropFilter: "blur(20px) saturate(180%)",
  border: "1px solid var(--border-subtle)",
  borderRadius: 8,
  padding: 4,
  boxShadow: "0 8px 32px var(--shadow)",
};

const itemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 8px",
  borderRadius: 5,
  cursor: "pointer",
};
