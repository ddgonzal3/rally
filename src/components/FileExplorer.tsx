import React, { useState, useEffect, useCallback } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { invoke } from "@tauri-apps/api/core";
import { ChevronIcon, FileIcon } from "./FileIcons";

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
  const { activeWorkspaceId, openFile } = useWorkspaceStore();

  const handleClick = useCallback(async () => {
    if (entry.is_dir) {
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
    } else if (activeWorkspaceId) {
      openFile(activeWorkspaceId, entry.path);
    }
  }, [entry, loaded, expanded, activeWorkspaceId, openFile]);

  return (
    <div>
      <button
        onClick={handleClick}
        style={{
          ...styles.node,
          paddingLeft: 4 + depth * 16,
          cursor: "pointer",
        }}
      >
        {entry.is_dir ? (
          <ChevronIcon open={expanded} />
        ) : (
          <span style={styles.chevronSpacer} />
        )}
        <FileIcon name={entry.name} isDir={entry.is_dir} isOpen={expanded} />
        <span style={styles.fileName}>{entry.name}</span>
      </button>
      {expanded &&
        children.map((child) => (
          <FileTreeNode key={child.path} entry={child} depth={depth + 1} />
        ))}
    </div>
  );
}

interface FileExplorerProps {
  width: number;
  onCollapse: () => void;
}

export function FileExplorer({ width, onCollapse }: FileExplorerProps) {
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
    <div style={{ ...styles.container, width, minWidth: width }}>
      <div style={styles.header}>
        <span style={styles.headerTitle}>Files</span>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={styles.headerPath}>{ws.name}</span>
          <button
            onClick={onCollapse}
            title="Hide file explorer"
            style={{
              background: "none",
              border: "none",
              color: "#666",
              cursor: "pointer",
              padding: 2,
              display: "flex",
              alignItems: "center",
              fontSize: 12,
            }}
          >
            ✕
          </button>
        </div>
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
    minHeight: 0,
    background: "#1e1e1e",
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
    gap: 2,
    width: "100%",
    padding: "2px 8px",
    background: "none",
    border: "none",
    color: "#ccc",
    fontSize: 12,
    textAlign: "left" as const,
    lineHeight: 1.4,
  },
  chevronSpacer: {
    width: 16,
    flexShrink: 0,
  },
  fileName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    marginLeft: 2,
    fontWeight: 500,
  },
  empty: {
    padding: 20,
    textAlign: "center" as const,
    color: "#666",
    fontSize: 13,
  },
};
