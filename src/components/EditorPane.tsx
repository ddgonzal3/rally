import React, { useState, useEffect, useCallback, useRef } from "react";
import Editor, { type OnMount, type BeforeMount } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { showContextMenu } from "../lib/contextMenu";

interface EditorPaneProps {
  filePath: string;
}

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "svg", "avif",
]);

function getExtension(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

function isImageFile(path: string): boolean {
  return IMAGE_EXTENSIONS.has(getExtension(path));
}

function getMimeType(ext: string): string {
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    bmp: "image/bmp",
    webp: "image/webp",
    ico: "image/x-icon",
    svg: "image/svg+xml",
    avif: "image/avif",
  };
  return map[ext] ?? "application/octet-stream";
}

function getLanguageFromPath(path: string): string {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile" || name === "gnumakefile") return "makefile";
  if (name === ".gitignore" || name === ".dockerignore") return "plaintext";

  const ext = name.split(".").pop() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    rs: "rust",
    json: "json",
    md: "markdown",
    css: "css",
    scss: "scss",
    html: "html",
    htm: "html",
    toml: "toml",
    yaml: "yaml",
    yml: "yaml",
    py: "python",
    go: "go",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    sql: "sql",
    xml: "xml",
    graphql: "graphql",
    lock: "json",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    hh: "cpp",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    rb: "ruby",
    php: "php",
    lua: "lua",
    r: "r",
    dart: "dart",
    zig: "zig",
  };
  return map[ext] ?? "plaintext";
}

export const EditorPane = React.memo(function EditorPane({ filePath }: EditorPaneProps) {
  if (isImageFile(filePath)) {
    return <ImageViewer filePath={filePath} />;
  }
  return <TextEditor filePath={filePath} />;
});

/** Image viewer — loads file as base64 and renders an <img> */
function ImageViewer({ filePath }: { filePath: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDataUrl(null);
    setError(null);
    const ext = getExtension(filePath);

    // SVGs can be read as text
    if (ext === "svg") {
      invoke<string>("read_file_content", { path: filePath })
        .then((content) => {
          const blob = new Blob([content], { type: "image/svg+xml" });
          setDataUrl(URL.createObjectURL(blob));
        })
        .catch((e) => setError(String(e)));
    } else {
      invoke<string>("read_file_base64", { path: filePath })
        .then((b64) => {
          setDataUrl(`data:${getMimeType(ext)};base64,${b64}`);
        })
        .catch((e) => setError(String(e)));
    }

    return () => {
      // Revoke object URLs on cleanup
      if (dataUrl?.startsWith("blob:")) URL.revokeObjectURL(dataUrl);
    };
  }, [filePath]);

  if (error) {
    return (
      <div style={styles.center}>
        <span style={{ color: "#df7d7d", fontSize: 13 }}>
          Failed to load image: {error}
        </span>
      </div>
    );
  }

  if (!dataUrl) {
    return <div style={styles.center} />;
  }

  return (
    <div style={styles.imageContainer}>
      <img
        src={dataUrl}
        alt={filePath.split("/").pop() ?? ""}
        style={styles.image}
      />
    </div>
  );
}

/** Text editor — Monaco with syntax highlighting */
function TextEditor({ filePath }: { filePath: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const contentRef = useRef("");
  const editorRef = useRef<any>(null);
  const language = getLanguageFromPath(filePath);

  useEffect(() => {
    setContent(null);
    setDirty(false);
    setError(null);
    invoke<string>("read_file_content", { path: filePath })
      .then((c) => {
        setContent(c);
        contentRef.current = c;
      })
      .catch((e) => setError(String(e)));
  }, [filePath]);

  const handleSave = useCallback(async () => {
    try {
      await invoke("write_file_content", {
        path: filePath,
        content: contentRef.current,
      });
      setDirty(false);
      setSaveMsg("Saved");
      setTimeout(() => setSaveMsg(""), 2000);
    } catch (e: any) {
      setSaveMsg(`Error: ${e}`);
    }
  }, [filePath]);

  const handleBeforeMount: BeforeMount = useCallback((monaco) => {
    monaco.editor.defineTheme("rally-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#1b1b1b",
      },
    });
  }, []);

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        () => handleSave()
      );
    },
    [handleSave]
  );

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const editor = editorRef.current;
    if (!editor) return;

    showContextMenu(
      [
        {
          label: "Cut",
          accelerator: "CmdOrCtrl+X",
          action: () => editor.trigger("contextMenu", "editor.action.clipboardCutAction"),
        },
        {
          label: "Copy",
          accelerator: "CmdOrCtrl+C",
          action: () => editor.trigger("contextMenu", "editor.action.clipboardCopyAction"),
        },
        {
          label: "Paste",
          accelerator: "CmdOrCtrl+V",
          action: () => editor.trigger("contextMenu", "editor.action.clipboardPasteAction"),
        },
        "separator",
        {
          label: "Select All",
          accelerator: "CmdOrCtrl+A",
          action: () => editor.trigger("contextMenu", "editor.action.selectAll"),
        },
      ],
      { x: e.clientX, y: e.clientY },
    );
  }, []);

  if (error) {
    return (
      <div style={styles.center}>
        <span style={{ color: "#df7d7d", fontSize: 13 }}>
          Failed to load file: {error}
        </span>
      </div>
    );
  }

  // Show blank dark background while loading — no flash
  if (content === null) {
    return <div style={styles.center} />;
  }

  return (
    <div style={styles.container} onContextMenu={handleContextMenu}>
      {(dirty || saveMsg) && (
        <div style={styles.statusBar}>
          {dirty && <span style={styles.dirtyDot} />}
          {saveMsg && <span style={styles.saveMsg}>{saveMsg}</span>}
        </div>
      )}
      <Editor
        height="100%"
        path={filePath}
        language={language}
        theme="rally-dark"
        defaultValue={content}
        onChange={(value) => {
          contentRef.current = value ?? "";
          setDirty((prev) => (prev ? prev : true));
        }}
        beforeMount={handleBeforeMount}
        onMount={handleMount}
        loading={<div style={styles.center} />}
        options={{
          contextmenu: false,
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
          lineNumbers: "on",
          wordWrap: "off",
          scrollBeyondLastLine: false,
          glyphMargin: false,
          codeLens: false,
          selectionHighlight: false,
          occurrencesHighlight: "off",
          renderValidationDecorations: "off",
          wordBasedSuggestions: "off",
          quickSuggestions: false,
          padding: { top: 8 },
          renderLineHighlight: "line",
          smoothScrolling: false,
          cursorSmoothCaretAnimation: "off",
        }}
      />
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
    position: "relative",
  },
  center: {
    display: "flex",
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    background: "#1b1b1b",
  },
  statusBar: {
    position: "absolute",
    top: 6,
    right: 20,
    zIndex: 10,
    display: "flex",
    alignItems: "center",
    gap: 6,
    pointerEvents: "none",
  },
  dirtyDot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "#e0e0e0",
  },
  saveMsg: {
    fontSize: 11,
    color: "#7ddf7d",
  },
  imageContainer: {
    display: "flex",
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    background: "#1b1b1b",
    overflow: "auto",
    padding: 24,
  },
  image: {
    maxWidth: "100%",
    maxHeight: "100%",
    objectFit: "contain" as const,
    borderRadius: 4,
    boxShadow: "0 2px 12px rgba(0,0,0,0.4)",
  },
};
