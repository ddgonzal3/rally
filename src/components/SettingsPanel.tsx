import React, { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { api } from "../lib/tauri";
import { showContextMenu } from "../lib/contextMenu";
import { ChevronIcon, FileIcon } from "./FileIcons";
import { ScrollArea } from "./ScrollArea";

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileEntry[];
}

interface ConfigFile {
  name: string;
  path: string;
  file_type: string;
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : "/";
}

// --- Simple tree node for ~/.claude/ ---

function ConfigTreeNode({
  entry,
  depth,
  expandedFolders,
  onToggleFolder,
  onClickFile,
  onRefreshParent,
}: {
  entry: FileEntry;
  depth: number;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  onClickFile: (path: string) => void;
  onRefreshParent: () => void;
}) {
  const [children, setChildren] = useState<FileEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const expanded = entry.is_dir && expandedFolders.has(entry.path);

  // Load children when expanded
  useEffect(() => {
    if (expanded && !loaded && entry.is_dir) {
      invoke<FileEntry[]>("list_directory", { path: entry.path })
        .then((entries) => {
          setChildren(entries);
          setLoaded(true);
        })
        .catch((e) => console.error("Failed to load directory:", e));
    }
  }, [expanded, loaded, entry.is_dir, entry.path]);

  const handleClick = useCallback(() => {
    if (entry.is_dir) {
      onToggleFolder(entry.path);
    } else {
      onClickFile(entry.path);
    }
  }, [entry, onToggleFolder, onClickFile]);

  const refreshChildren = useCallback(() => {
    if (entry.is_dir) {
      invoke<FileEntry[]>("list_directory", { path: entry.path })
        .then((entries) => {
          setChildren(entries);
          setLoaded(true);
        })
        .catch((e) => console.error("Failed to refresh directory:", e));
    }
  }, [entry.is_dir, entry.path]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const items: Parameters<typeof showContextMenu>[0] = [
        {
          label: "New File...",
          action: () => {
            // Dispatch custom event to trigger inline input
            document.dispatchEvent(
              new CustomEvent("rally:config-new-item", {
                detail: {
                  parentPath: entry.is_dir ? entry.path : dirname(entry.path),
                  kind: "file",
                },
              }),
            );
          },
        },
        {
          label: "New Folder...",
          action: () => {
            document.dispatchEvent(
              new CustomEvent("rally:config-new-item", {
                detail: {
                  parentPath: entry.is_dir ? entry.path : dirname(entry.path),
                  kind: "dir",
                },
              }),
            );
          },
        },
        "separator",
        {
          label: "Copy Path",
          action: () => navigator.clipboard.writeText(entry.path),
        },
        "separator",
        {
          label: "Reveal in Finder",
          action: () => api.revealInFinder(entry.path),
        },
        "separator",
        {
          label: "Move to Trash",
          action: async () => {
            try {
              await api.trashFile(entry.path);
              onRefreshParent();
            } catch (e) {
              console.error("Failed to trash:", e);
            }
          },
        },
      ];
      showContextMenu(items);
    },
    [entry, onRefreshParent],
  );

  return (
    <div>
      <button
        className="file-node"
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        style={{ ...styles.node, paddingLeft: 4 + depth * 10 }}
      >
        {entry.is_dir ? (
          <ChevronIcon open={expanded} />
        ) : (
          <span style={styles.spacer} />
        )}
        <FileIcon name={entry.name} isDir={entry.is_dir} isOpen={expanded} />
        <span style={styles.name}>{entry.name}</span>
      </button>
      {expanded &&
        children.map((c) => (
          <ConfigTreeNode
            key={c.path}
            entry={c}
            depth={depth + 1}
            expandedFolders={expandedFolders}
            onToggleFolder={onToggleFolder}
            onClickFile={onClickFile}
            onRefreshParent={refreshChildren}
          />
        ))}
    </div>
  );
}

// --- Inline name input for creating new files/folders ---

function InlineNameInput({
  parentPath,
  kind,
  onDone,
}: {
  parentPath: string;
  kind: "file" | "dir";
  onDone: () => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(async () => {
    const name = value.trim();
    if (!name) {
      onDone();
      return;
    }
    const fullPath = parentPath.replace(/\/+$/, "") + "/" + name;
    try {
      if (kind === "dir") {
        await api.createDirectory(fullPath);
      } else {
        await api.writeFileContent(fullPath, "");
      }
    } catch (e) {
      console.error("Failed to create:", e);
    }
    onDone();
  }, [value, parentPath, kind, onDone]);

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") void handleSubmit();
        if (e.key === "Escape") onDone();
      }}
      onBlur={onDone}
      placeholder={kind === "dir" ? "folder name" : "file name"}
      style={styles.inlineInput}
    />
  );
}

// --- Main component ---

export function GlobalConfigExplorer() {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const openFile = useWorkspaceStore((s) => s.openFile);

  const [claudeDir, setClaudeDir] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [newItem, setNewItem] = useState<{
    parentPath: string;
    kind: "file" | "dir";
  } | null>(null);

  // Resolve ~/.claude/ directory on mount
  useEffect(() => {
    let cancelled = false;
    invoke<ConfigFile[]>("list_claude_configs", { workspacePath: null })
      .then((files) => {
        if (cancelled) return;
        const global = files.find(
          (f) => f.file_type === "claude-md" && f.path.endsWith("/.claude/CLAUDE.md"),
        );
        const dir = global ? dirname(global.path) : null;
        setClaudeDir(dir);
        if (dir) {
          return invoke<FileEntry[]>("list_directory", { path: dir });
        }
        return [];
      })
      .then((result) => {
        if (cancelled) return;
        if (result) setEntries(result);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshRoot = useCallback(() => {
    if (!claudeDir) return;
    invoke<FileEntry[]>("list_directory", { path: claudeDir })
      .then(setEntries)
      .catch((e) => console.error("Failed to refresh config dir:", e));
  }, [claudeDir]);

  const handleToggleFolder = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleClickFile = useCallback(
    (filePath: string) => {
      if (activeWorkspaceId) {
        openFile(activeWorkspaceId, filePath);
      }
    },
    [activeWorkspaceId, openFile],
  );

  // Listen for "new item" events from context menu
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ parentPath: string; kind: "file" | "dir" }>).detail;
      if (detail) {
        // Ensure parent folder is expanded
        setExpandedFolders((prev) => {
          const next = new Set(prev);
          next.add(detail.parentPath);
          return next;
        });
        setNewItem(detail);
      }
    };
    document.addEventListener("rally:config-new-item", handler);
    return () => document.removeEventListener("rally:config-new-item", handler);
  }, []);

  const handleNewItemDone = useCallback(() => {
    setNewItem(null);
    refreshRoot();
  }, [refreshRoot]);

  const handleRootContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (!claudeDir) return;
      showContextMenu([
        {
          label: "New File...",
          action: () => {
            setNewItem({ parentPath: claudeDir, kind: "file" });
          },
        },
        {
          label: "New Folder...",
          action: () => {
            setNewItem({ parentPath: claudeDir, kind: "dir" });
          },
        },
        "separator",
        {
          label: "Copy Path",
          action: () => navigator.clipboard.writeText(claudeDir),
        },
        "separator",
        {
          label: "Reveal in Finder",
          action: () => api.revealInFinder(claudeDir),
        },
      ]);
    },
    [claudeDir],
  );

  if (!loaded) {
    return (
      <div style={styles.container}>
        <div style={styles.header} />
        <div style={styles.emptyMsg}>Loading...</div>
      </div>
    );
  }

  if (!claudeDir) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <span style={styles.headerText}>Claude Config</span>
        </div>
        <div style={styles.emptyMsg}>Could not resolve ~/.claude</div>
      </div>
    );
  }

  return (
    <div style={styles.container} onContextMenu={handleRootContextMenu}>
      <div style={styles.header}>
        <span style={styles.headerText}>Claude Config</span>
      </div>
      <ScrollArea style={{ flex: 1, padding: "2px 0" }}>
        {entries.map((entry) => (
          <ConfigTreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            expandedFolders={expandedFolders}
            onToggleFolder={handleToggleFolder}
            onClickFile={handleClickFile}
            onRefreshParent={refreshRoot}
          />
        ))}
        {newItem && newItem.parentPath === claudeDir && (
          <InlineNameInput
            parentPath={newItem.parentPath}
            kind={newItem.kind}
            onDone={handleNewItemDone}
          />
        )}
      </ScrollArea>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    background: "#1a1a1a",
    overflow: "hidden",
    userSelect: "none",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 8px 0 12px",
    minHeight: 29,
    maxHeight: 29,
    borderBottom: "1px solid #333",
    flexShrink: 0,
  },
  headerText: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    color: "#fff",
  },
  emptyMsg: {
    padding: "8px 12px",
    color: "#888",
    fontSize: 11,
  },
  node: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    width: "100%",
    padding: "2px 2px",
    background: "none",
    border: "none",
    color: "#ddd",
    fontSize: 12,
    textAlign: "left" as const,
    lineHeight: 1.4,
    cursor: "pointer",
    position: "relative" as const,
  },
  spacer: {
    width: 14,
    flexShrink: 0,
  },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    marginLeft: 2,
    fontWeight: 600,
  },
  inlineInput: {
    display: "block",
    width: "calc(100% - 16px)",
    margin: "2px 8px",
    padding: "2px 6px",
    fontSize: 12,
    background: "#2a2a2a",
    border: "1px solid #555",
    borderRadius: 3,
    color: "#eee",
    outline: "none",
  },
};
