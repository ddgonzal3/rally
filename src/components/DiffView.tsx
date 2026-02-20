import React, { useState, useEffect } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { api } from "../lib/tauri";

function getLanguageFromPath(path: string): string {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  const ext = name.split(".").pop() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    rs: "rust", json: "json", md: "markdown", css: "css", html: "html",
    toml: "toml", yaml: "yaml", yml: "yaml", py: "python", go: "go",
    sh: "shell", sql: "sql", xml: "xml",
  };
  return map[ext] ?? "plaintext";
}

interface DiffViewProps {
  rootPath: string;
  filePath: string;
  isUntracked?: boolean;
}

/**
 * Full-pane Monaco DiffEditor. Shows HEAD vs working copy for a single file.
 */
export function DiffView({ rootPath, filePath, isUntracked }: DiffViewProps) {
  const [original, setOriginal] = useState("");
  const [modified, setModified] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    (async () => {
      const fullPath = filePath.startsWith("/") ? filePath : `${rootPath}/${filePath}`;

      // Get current file content
      let mod = "";
      try { mod = await api.readFileContent(fullPath); } catch { /* deleted */ }

      // Get HEAD version (empty for untracked)
      let orig = "";
      if (!isUntracked) {
        try { orig = await api.gitFileAtHead(rootPath, filePath); } catch { /* new file */ }
      }

      if (!cancelled) {
        setOriginal(orig);
        setModified(mod);
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [rootPath, filePath, isUntracked]);

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#555", fontSize: 13 }}>
        Loading diff...
      </div>
    );
  }

  return (
    <DiffEditor
      original={original}
      modified={modified}
      language={getLanguageFromPath(filePath)}
      theme="vs-dark"
      options={{
        readOnly: true,
        renderSideBySide: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        lineNumbers: "on",
        padding: { top: 8 },
      }}
    />
  );
}
