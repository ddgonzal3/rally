# Agent Config Redesign: Global Config Popover — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the heavy Agent Config modal with a lightweight global-config-only popover anchored to a gear icon in the sidebar footer.

**Architecture:** Rewrite `SettingsPanel.tsx` into a slim `GlobalConfigPopover` component that resolves `~/.claude/` paths, checks existence, and renders a compact upward-anchored popover. Update `Sidebar.tsx` to replace the text button with a gear icon and manage popover open/close state. No Rust backend changes needed.

**Tech Stack:** React, Tauri invoke API, inline styles (matching existing codebase pattern)

---

### Task 1: Rewrite SettingsPanel.tsx as GlobalConfigPopover

**Files:**
- Modify: `src/components/SettingsPanel.tsx` (full rewrite, rename export)

**Context for implementer:** The current `SettingsPanel.tsx` is a 598-line modal with Global/Repo scope toggle, repo picker chips, and full-screen overlay. We're replacing ALL of it with a ~150-line popover component that only handles global `~/.claude/` config. The component receives an `anchorRect` (the bounding rect of the gear icon) and positions itself above it.

**Step 1: Rewrite the component**

Replace the entire contents of `SettingsPanel.tsx` with:

```tsx
import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { api } from "../lib/tauri";
import { addToast } from "./ToastContainer";

interface ConfigFile {
  name: string;
  path: string;
  file_type: string;
}

interface PathStatus {
  exists: boolean;
  is_dir: boolean;
}

interface GlobalConfigPopoverProps {
  anchorRect: DOMRect;
  onClose: () => void;
}

interface ConfigTarget {
  label: string;
  path: string;
  kind: "file" | "dir";
}

function joinPath(base: string, ...parts: string[]): string {
  let out = base.replace(/\/+$/, "");
  for (const part of parts) {
    out += "/" + part.replace(/^\/+/, "").replace(/\/+$/, "");
  }
  return out;
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : "/";
}

export function GlobalConfigPopover({ anchorRect, onClose }: GlobalConfigPopoverProps) {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const openFile = useWorkspaceStore((s) => s.openFile);

  const [claudeDir, setClaudeDir] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [statusByPath, setStatusByPath] = useState<Record<string, PathStatus>>({});
  const [busyPath, setBusyPath] = useState<string | null>(null);

  // Resolve ~/.claude/ directory path on mount
  useEffect(() => {
    let cancelled = false;
    invoke<ConfigFile[]>("list_claude_configs", { workspacePath: null })
      .then((files) => {
        if (cancelled) return;
        const global = files.find(
          (f) => f.file_type === "claude-md" && f.path.endsWith("/.claude/CLAUDE.md"),
        );
        setClaudeDir(global ? dirname(global.path) : null);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const targets = useMemo<ConfigTarget[]>(() => {
    if (!claudeDir) return [];
    return [
      { label: "CLAUDE.md", path: joinPath(claudeDir, "CLAUDE.md"), kind: "file" },
      { label: "commands/", path: joinPath(claudeDir, "commands"), kind: "dir" },
      { label: "skills/", path: joinPath(claudeDir, "skills"), kind: "dir" },
      { label: ".claude/", path: claudeDir, kind: "dir" },
    ];
  }, [claudeDir]);

  // Check existence of each target path
  useEffect(() => {
    if (targets.length === 0) return;
    let cancelled = false;
    Promise.all(
      targets.map(async (t) => ({ path: t.path, status: await api.pathStatus(t.path) })),
    ).then((rows) => {
      if (cancelled) return;
      const next: Record<string, PathStatus> = {};
      for (const r of rows) next[r.path] = r.status;
      setStatusByPath(next);
    });
    return () => { cancelled = true; };
  }, [targets]);

  // Dismiss on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Dismiss on click outside
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest("[data-global-config-popover]");
      if (!el) onClose();
    };
    // Delay listener so the opening click doesn't immediately close
    const timer = setTimeout(() => document.addEventListener("mousedown", onClick), 0);
    return () => { clearTimeout(timer); document.removeEventListener("mousedown", onClick); };
  }, [onClose]);

  const handleClick = async (target: ConfigTarget) => {
    const status = statusByPath[target.path];
    const exists = status?.exists === true;

    setBusyPath(target.path);
    try {
      // Create if missing
      if (!exists) {
        if (target.kind === "file") {
          await api.writeFileContent(target.path, "# CLAUDE.md\n");
        } else {
          await api.createDirectory(target.path);
        }
        const newStatus = await api.pathStatus(target.path);
        setStatusByPath((prev) => ({ ...prev, [target.path]: newStatus }));
        addToast({ type: "success", title: "Created", message: `${target.label} is ready.` });
      }

      // Open
      if (target.kind === "file" && activeWorkspaceId) {
        openFile(activeWorkspaceId, target.path);
      } else {
        await api.revealInFinder(target.path);
      }
      onClose();
    } catch {
      addToast({ type: "warning", title: "Failed", message: `Could not open ${target.label}` });
    } finally {
      setBusyPath(null);
    }
  };

  // Position: above the anchor, left-aligned
  const popoverStyle: React.CSSProperties = {
    position: "fixed",
    left: anchorRect.left,
    bottom: window.innerHeight - anchorRect.top + 6,
    zIndex: 1000,
    background: "#1e1e1e",
    border: "1px solid #3a3a3a",
    borderRadius: 8,
    boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
    padding: "4px 0",
    minWidth: 180,
  };

  return (
    <div data-global-config-popover style={popoverStyle}>
      {!loaded ? (
        <div style={styles.status}>Loading...</div>
      ) : !claudeDir ? (
        <div style={styles.status}>Could not resolve ~/.claude</div>
      ) : (
        targets.map((target) => {
          const status = statusByPath[target.path];
          const exists = status?.exists === true;
          const missing = status?.exists === false;
          const isBusy = busyPath === target.path;

          return (
            <button
              key={target.path}
              style={{
                ...styles.item,
                ...(missing ? styles.itemMissing : {}),
              }}
              onClick={() => void handleClick(target)}
              disabled={isBusy}
            >
              <span>{isBusy ? "..." : target.label}</span>
              {missing && <span style={styles.createHint}>create</span>}
            </button>
          );
        })
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  status: {
    padding: "10px 14px",
    color: "#888",
    fontSize: 12,
  },
  item: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    padding: "8px 14px",
    background: "none",
    border: "none",
    color: "#ddd",
    fontSize: 13,
    cursor: "pointer",
    textAlign: "left" as const,
  },
  itemMissing: {
    color: "#777",
  },
  createHint: {
    fontSize: 11,
    color: "#666",
    marginLeft: 8,
  },
};
```

**Key differences from old code:**
- No `Scope` type, no `scope` state, no `SCOPE_STORAGE_KEY`
- No repo-related state (`selectedRepoPath`, `resolvedRepoPath`, `repoPaths`)
- No overlay/dimming — just a positioned div
- No `setActivePathIndex`, `revealFileInExplorer` — those were repo-specific
- Clicking a missing item creates it inline, then opens it (single-click flow)
- `anchorRect` prop for positioning instead of centered modal

**Step 2: Verify it compiles**

Run: `cd /Users/splice/splice/rally && npx tsc --noEmit`
Expected: No type errors in SettingsPanel.tsx (Sidebar.tsx will temporarily error because it still imports the old name — that's fixed in Task 2)

---

### Task 2: Update Sidebar to use gear icon + popover

**Files:**
- Modify: `src/components/Sidebar.tsx:4` (import change)
- Modify: `src/components/Sidebar.tsx:14` (state change)
- Modify: `src/components/Sidebar.tsx:83-91` (replace button + modal rendering)
- Modify: `src/components/Sidebar.tsx:162-172` (update styles)

**Step 1: Update the import**

Change line 4 from:
```tsx
import { SettingsPanel } from "./SettingsPanel";
```
to:
```tsx
import { GlobalConfigPopover } from "./SettingsPanel";
```

**Step 2: Add ref for anchor positioning + update state**

Replace:
```tsx
const [showSettings, setShowSettings] = useState(false);
```
with:
```tsx
const [popoverAnchor, setPopoverAnchor] = useState<DOMRect | null>(null);
const gearRef = React.useRef<HTMLButtonElement>(null);
```

**Step 3: Replace the bottom button with a gear icon**

Replace the `bottomBtns` div (lines 83-91):
```tsx
<div style={styles.bottomBtns}>
  <button
    className="sidebar-btn"
    style={styles.settingsBtn}
    onClick={() => setShowSettings(true)}
  >
    Agent Config
  </button>
</div>
```
with:
```tsx
<div style={styles.bottomBtns}>
  <button
    ref={gearRef}
    className="sidebar-btn"
    style={styles.gearBtn}
    onClick={() => {
      if (popoverAnchor) {
        setPopoverAnchor(null);
      } else if (gearRef.current) {
        setPopoverAnchor(gearRef.current.getBoundingClientRect());
      }
    }}
    title="Global agent config"
  >
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6.5.75h3l.4 2.14a5.5 5.5 0 0 1 1.33.77l2.06-.82 1.5 2.6-1.66 1.32a5.6 5.6 0 0 1 0 1.48l1.66 1.32-1.5 2.6-2.06-.82a5.5 5.5 0 0 1-1.33.77L9.5 15.25h-3l-.4-2.14a5.5 5.5 0 0 1-1.33-.77l-2.06.82-1.5-2.6 1.66-1.32a5.6 5.6 0 0 1 0-1.48L1.21 6.44l1.5-2.6 2.06.82a5.5 5.5 0 0 1 1.33-.77L6.5.75Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
      <circle cx="8" cy="8" r="2.25" stroke="currentColor" strokeWidth="1.2"/>
    </svg>
  </button>
</div>
```

**Step 4: Replace the modal rendering**

Replace:
```tsx
{showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
```
with:
```tsx
{popoverAnchor && (
  <GlobalConfigPopover
    anchorRect={popoverAnchor}
    onClose={() => setPopoverAnchor(null)}
  />
)}
```

**Step 5: Update styles**

Remove the `settingsBtn` style and add `gearBtn`:
```tsx
gearBtn: {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 30,
  height: 30,
  background: "none",
  border: "none",
  color: "#888",
  cursor: "pointer",
  borderRadius: 4,
  padding: 0,
  margin: "4px 8px",
},
```

**Step 6: Verify full build**

Run: `cd /Users/splice/splice/rally && npx tsc --noEmit`
Expected: PASS, no type errors

---

### Task 3: Manual verification + cleanup

**Step 1: Build and launch**

Run: `cd /Users/splice/splice/rally && ./scripts/run.sh`

**Step 2: Verify behavior**

Manual checklist:
- [ ] Gear icon visible in sidebar footer
- [ ] Clicking gear opens popover anchored above the icon
- [ ] Popover shows 4 items: CLAUDE.md, commands/, skills/, .claude/
- [ ] Existing items appear in normal text, missing items appear dimmed with "create" hint
- [ ] Clicking CLAUDE.md opens it in an editor tab (if workspace selected)
- [ ] Clicking a directory opens Finder
- [ ] Clicking a missing item creates it, then opens it
- [ ] Popover closes on: Escape, click outside, clicking an item
- [ ] No full-screen overlay or dimming
- [ ] No Global/Repo toggle anywhere

**Step 3: Delete the design doc localStorage key**

The old `SCOPE_STORAGE_KEY = "rally:agentConfigScope"` will remain in users' localStorage as dead data. This is harmless — no action needed.

---

## Summary of changes

| File | What changes |
|------|-------------|
| `src/components/SettingsPanel.tsx` | Full rewrite: 598 lines → ~130 lines. Export renamed from `SettingsPanel` to `GlobalConfigPopover`. Removes scope toggle, repo picker, modal overlay, all repo-specific logic. |
| `src/components/Sidebar.tsx` | Import change, state change (`showSettings` boolean → `popoverAnchor` DOMRect), text button → gear icon with ref, modal → popover rendering, style update. |
