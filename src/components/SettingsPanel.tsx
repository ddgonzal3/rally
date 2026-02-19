import React, { useState, useEffect, useCallback } from "react";
import Editor from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../stores/workspaceStore";

interface ConfigFile {
  name: string;
  path: string;
  file_type: string;
}

interface SkillInfo {
  name: string;
  path: string;
  content_preview: string;
}

interface SettingsPanelProps {
  onClose: () => void;
}

type Tab = "configs" | "skills";

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const { activeWorkspaceId, workspaces } = useWorkspaceStore();
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);

  const [tab, setTab] = useState<Tab>("configs");
  const [configs, setConfigs] = useState<ConfigFile[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");

  // Load configs and skills
  useEffect(() => {
    invoke<ConfigFile[]>("list_claude_configs", {
      workspacePath: ws?.path ?? null,
    }).then(setConfigs);

    invoke<SkillInfo[]>("list_skills", {
      workspacePath: ws?.path ?? null,
    }).then(setSkills);
  }, [ws?.path]);

  // Load file content when selected
  useEffect(() => {
    if (!selectedPath) return;
    invoke<string>("read_file_content", { path: selectedPath })
      .then((c) => {
        setContent(c);
        setDirty(false);
      })
      .catch(() => {
        setContent(""); // New file
        setDirty(false);
      });
  }, [selectedPath]);

  const handleSave = useCallback(async () => {
    if (!selectedPath) return;
    setSaving(true);
    try {
      await invoke("write_file_content", { path: selectedPath, content });
      setDirty(false);
      setSaveMsg("Saved");
      setTimeout(() => setSaveMsg(""), 2000);
    } catch (e: any) {
      setSaveMsg(`Error: ${e}`);
    } finally {
      setSaving(false);
    }
  }, [selectedPath, content]);

  // Select first config by default
  useEffect(() => {
    if (!selectedPath && configs.length > 0) {
      setSelectedPath(configs[0].path);
    }
  }, [configs, selectedPath]);

  const allItems =
    tab === "configs"
      ? configs.map((c) => ({ name: c.name, path: c.path }))
      : skills.map((s) => ({ name: s.name, path: s.path }));

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <div style={styles.tabs}>
            <button
              style={{
                ...styles.tab,
                ...(tab === "configs" ? styles.tabActive : {}),
              }}
              onClick={() => setTab("configs")}
            >
              CLAUDE.md
            </button>
            <button
              style={{
                ...styles.tab,
                ...(tab === "skills" ? styles.tabActive : {}),
              }}
              onClick={() => setTab("skills")}
            >
              Skills
            </button>
          </div>
          <div style={styles.headerRight}>
            {saveMsg && <span style={styles.saveMsg}>{saveMsg}</span>}
            <button
              style={{
                ...styles.saveBtn,
                opacity: dirty ? 1 : 0.4,
              }}
              onClick={handleSave}
              disabled={!dirty || saving}
            >
              {saving ? "Saving..." : "Save"}
            </button>
            <button style={styles.closeBtn} onClick={onClose}>
              x
            </button>
          </div>
        </div>

        <div style={styles.body}>
          <div style={styles.fileList}>
            {allItems.map((item) => (
              <button
                key={item.path}
                onClick={() => {
                  setSelectedPath(item.path);
                  setDirty(false);
                }}
                style={{
                  ...styles.fileItem,
                  ...(item.path === selectedPath ? styles.fileItemActive : {}),
                }}
              >
                {item.name}
              </button>
            ))}
            {allItems.length === 0 && (
              <div style={styles.emptyList}>
                {tab === "skills"
                  ? "No skills found"
                  : "No config files found"}
              </div>
            )}
          </div>

          <div style={styles.editor}>
            {selectedPath ? (
              <Editor
                height="100%"
                language={
                  selectedPath.endsWith(".json") ? "json" : "markdown"
                }
                theme="vs-dark"
                value={content}
                onChange={(value) => {
                  setContent(value ?? "");
                  setDirty(true);
                }}
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  fontFamily:
                    "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
                  lineNumbers: "on",
                  wordWrap: "on",
                  scrollBeyondLastLine: false,
                  padding: { top: 8 },
                }}
              />
            ) : (
              <div style={styles.noSelection}>
                Select a file to edit
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0, 0, 0, 0.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  panel: {
    width: "80vw",
    height: "70vh",
    maxWidth: 1000,
    background: "#1e1e1e",
    borderRadius: 8,
    border: "1px solid #3a3a3a",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 12px",
    borderBottom: "1px solid #333",
    minHeight: 40,
  },
  tabs: {
    display: "flex",
    gap: 0,
  },
  tab: {
    padding: "10px 16px",
    background: "none",
    border: "none",
    borderBottom: "2px solid transparent",
    color: "#888",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 500,
  },
  tabActive: {
    color: "#e0e0e0",
    borderBottomColor: "#7c6ef5",
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  saveMsg: {
    fontSize: 11,
    color: "#7ddf7d",
  },
  saveBtn: {
    padding: "5px 12px",
    background: "#7c6ef5",
    border: "none",
    borderRadius: 4,
    color: "#fff",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 500,
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "#888",
    fontSize: 16,
    cursor: "pointer",
    padding: "0 4px",
  },
  body: {
    flex: 1,
    display: "flex",
    minHeight: 0,
  },
  fileList: {
    width: 200,
    minWidth: 200,
    borderRight: "1px solid #333",
    overflow: "auto",
    padding: "4px 0",
  },
  fileItem: {
    width: "100%",
    padding: "8px 12px",
    background: "none",
    border: "none",
    borderLeft: "3px solid transparent",
    color: "#ccc",
    cursor: "pointer",
    textAlign: "left" as const,
    fontSize: 12,
    display: "block",
  },
  fileItemActive: {
    background: "#2a2a2a",
    borderLeftColor: "#7c6ef5",
    color: "#fff",
  },
  emptyList: {
    padding: 16,
    color: "#666",
    fontSize: 12,
    textAlign: "center" as const,
  },
  editor: {
    flex: 1,
    minWidth: 0,
  },
  noSelection: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    color: "#666",
    fontSize: 13,
  },
};
