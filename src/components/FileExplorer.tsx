import React, { useState, useEffect, useCallback } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { invoke } from "@tauri-apps/api/core";

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileEntry[];
}

function FileTreeNode({
  entry,
  depth,
}: {
  entry: FileEntry;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>(entry.children ?? []);
  const [loaded, setLoaded] = useState(false);

  const toggle = useCallback(async () => {
    if (!entry.is_dir) return;

    if (!loaded) {
      try {
        const entries = await invoke<FileEntry[]>("list_directory", {
          path: entry.path,
        });
        setChildren(entries);
        setLoaded(true);
      } catch (e) {
        console.error("Failed to list directory:", e);
      }
    }
    setExpanded(!expanded);
  }, [entry, loaded, expanded]);

  const icon = entry.is_dir
    ? expanded
      ? "▾"
      : "▸"
    : " ";

  const fileIcon = entry.is_dir ? "📁" : getFileIcon(entry.name);

  return (
    <div>
      <button
        onClick={toggle}
        style={{
          ...styles.node,
          paddingLeft: 12 + depth * 16,
          cursor: entry.is_dir ? "pointer" : "default",
        }}
      >
        <span style={styles.arrow}>{icon}</span>
        <span style={styles.fileIcon}>{fileIcon}</span>
        <span style={styles.fileName}>{entry.name}</span>
      </button>
      {expanded &&
        children.map((child) => (
          <FileTreeNode key={child.path} entry={child} depth={depth + 1} />
        ))}
    </div>
  );
}

function getFileIcon(name: string): string {
  if (name.endsWith(".ts") || name.endsWith(".tsx")) return "🟦";
  if (name.endsWith(".js") || name.endsWith(".jsx")) return "🟨";
  if (name.endsWith(".rs")) return "🦀";
  if (name.endsWith(".json")) return "📋";
  if (name.endsWith(".md")) return "📝";
  if (name.endsWith(".css") || name.endsWith(".scss")) return "🎨";
  if (name.endsWith(".html")) return "🌐";
  if (name === ".gitignore") return "🚫";
  return "📄";
}

export function FileExplorer() {
  const { activeWorkspaceId, workspaces } = useWorkspaceStore();
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);

  useEffect(() => {
    if (!ws) return;
    invoke<FileEntry[]>("list_directory", { path: ws.path })
      .then(setRootEntries)
      .catch((e) => console.error("Failed to load file tree:", e));
  }, [ws?.path]);

  if (!ws) {
    return (
      <div style={styles.container}>
        <div style={styles.empty}>No workspace selected</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.headerTitle}>Files</span>
        <span style={styles.headerPath}>{ws.name}</span>
      </div>
      <div style={styles.tree}>
        {rootEntries.map((entry) => (
          <FileTreeNode key={entry.path} entry={entry} depth={0} />
        ))}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    background: "#1a1a1a",
    border: "1px solid #333",
    borderRadius: 6,
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "4px 10px",
    background: "#252525",
    borderBottom: "1px solid #333",
    minHeight: 28,
  },
  headerTitle: {
    fontSize: 11,
    fontWeight: 500,
    color: "#999",
  },
  headerPath: {
    fontSize: 10,
    color: "#666",
  },
  tree: {
    flex: 1,
    overflow: "auto",
    padding: "4px 0",
  },
  node: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    width: "100%",
    padding: "3px 12px",
    background: "none",
    border: "none",
    color: "#ccc",
    fontSize: 12,
    textAlign: "left" as const,
    lineHeight: 1.4,
  },
  arrow: {
    width: 12,
    fontSize: 10,
    color: "#666",
    flexShrink: 0,
  },
  fileIcon: {
    fontSize: 12,
    flexShrink: 0,
  },
  fileName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  empty: {
    padding: 20,
    textAlign: "center" as const,
    color: "#666",
    fontSize: 13,
  },
};
