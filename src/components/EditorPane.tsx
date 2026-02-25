import React, { useState, useEffect, useCallback, useRef } from "react";
import Editor, { type OnMount, type BeforeMount } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { showContextMenu } from "../lib/contextMenu";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { addToast } from "./ToastContainer";
import { MarkdownPreview } from "./MarkdownPreview";

interface EditorPaneProps {
  filePath: string;
  paneId: string;
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

  // Extensionless files in bin/ or scripts/ directories are shell scripts
  if (!name.includes(".")) {
    const dir = path.toLowerCase();
    if (dir.includes("/bin/") || dir.includes("/scripts/")) return "shell";
  }

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

export const EditorPane = React.memo(function EditorPane({ filePath, paneId }: EditorPaneProps) {
  if (isImageFile(filePath)) {
    return <ImageViewer filePath={filePath} />;
  }
  return <TextEditor filePath={filePath} paneId={paneId} />;
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
function TextEditor({ filePath, paneId }: { filePath: string; paneId: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState("");
  const contentRef = useRef("");
  const editorRef = useRef<any>(null);
  const language = getLanguageFromPath(filePath);
  const markDirty = useWorkspaceStore((s) => s.markPaneDirty);
  const markClean = useWorkspaceStore((s) => s.markPaneClean);

  // Subscribe to initialLine/initialCol from pane data (set via Cmd+click)
  const initialLine = useWorkspaceStore((s) => {
    for (const layout of Object.values(s.layouts)) {
      for (const group of Object.values(layout.groups)) {
        const pane = group.panes.find((p) => p.id === paneId);
        if (pane) return pane.initialLine;
      }
    }
    return undefined;
  });
  const initialCol = useWorkspaceStore((s) => {
    for (const layout of Object.values(s.layouts)) {
      for (const group of Object.values(layout.groups)) {
        const pane = group.panes.find((p) => p.id === paneId);
        if (pane) return pane.initialCol;
      }
    }
    return undefined;
  });
  const editorViewMode = useWorkspaceStore((s) => {
    for (const layout of Object.values(s.layouts)) {
      for (const group of Object.values(layout.groups)) {
        const pane = group.panes.find((p) => p.id === paneId);
        if (pane) return pane.editorViewMode;
      }
    }
    return undefined;
  });

  useEffect(() => {
    setContent(null);
    markClean(paneId);
    setError(null);
    invoke<string>("read_file_content", { path: filePath })
      .then((c) => {
        setContent(c);
        contentRef.current = c;
        setPreviewContent(c);
      })
      .catch((e) => setError(String(e)));
  }, [filePath, paneId, markClean]);

  const isMarkdown = getExtension(filePath) === "md";
  const viewMode = isMarkdown ? (editorViewMode ?? "raw") : "raw";

  const handleSave = useCallback(async () => {
    try {
      await invoke("write_file_content", {
        path: filePath,
        content: contentRef.current,
      });
      markClean(paneId);
    } catch (e) {
      addToast({ type: "warning", title: "Save failed", message: String(e instanceof Error ? e.message : e) });
    }
  }, [filePath, paneId, markClean]);

  const handleBeforeMount: BeforeMount = useCallback((monaco) => {
    // Register a rich bash/shell tokenizer (Monarch grammar)
    if (!monaco.languages.getLanguages().some((l: { id: string }) => l.id === "shell")) {
      monaco.languages.register({ id: "shell" });
    }
    monaco.languages.setMonarchTokensProvider("shell", shellLanguageDef);

    monaco.editor.defineTheme("rally-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment.shell", foreground: "6a9955", fontStyle: "italic" },
        { token: "keyword.shell", foreground: "c586c0" },
        { token: "string.shell", foreground: "ce9178" },
        { token: "string.escape.shell", foreground: "d7ba7d" },
        { token: "variable.shell", foreground: "9cdcfe" },
        { token: "variable.special.shell", foreground: "4fc1ff" },
        { token: "number.shell", foreground: "b5cea8" },
        { token: "operator.shell", foreground: "d4d4d4" },
        { token: "delimiter.shell", foreground: "d4d4d4" },
        { token: "builtin.shell", foreground: "dcdcaa" },
        { token: "command.shell", foreground: "4ec9b0" },
        { token: "flag.shell", foreground: "9cdcfe" },
        { token: "shebang.shell", foreground: "6a9955", fontStyle: "italic" },
      ],
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
      // Jump to line:col if specified (e.g. from Cmd+click in terminal)
      if (initialLine) {
        editor.revealLineInCenter(initialLine);
        editor.setPosition({ lineNumber: initialLine, column: initialCol || 1 });
        editor.focus();
      }
    },
    [handleSave, initialLine, initialCol]
  );

  // Jump to line:col when it changes on an already-mounted editor
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !initialLine) return;
    editor.revealLineInCenter(initialLine);
    editor.setPosition({ lineNumber: initialLine, column: initialCol || 1 });
    editor.focus();
  }, [initialLine, initialCol]);

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

  const editorElement = (
    <Editor
      height="100%"
      path={filePath}
      language={language}
      theme="rally-dark"
      defaultValue={content}
      onChange={(value) => {
        contentRef.current = value ?? "";
        markDirty(paneId);
        if (viewMode !== "raw") {
          setPreviewContent(value ?? "");
        }
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
  );

  if (viewMode === "preview") {
    return (
      <div style={styles.container}>
        <MarkdownPreview content={previewContent} />
      </div>
    );
  }

  if (viewMode === "split") {
    return (
      <SplitEditorPreview
        editorElement={editorElement}
        previewContent={previewContent}
        editorRef={editorRef}
        onContextMenu={handleContextMenu}
      />
    );
  }

  return (
    <div style={styles.container} onContextMenu={handleContextMenu}>
      {editorElement}
    </div>
  );
}

/** Split view with scroll sync and resizable divider */
function SplitEditorPreview({
  editorElement,
  previewContent,
  editorRef,
  onContextMenu,
}: {
  editorElement: React.ReactNode;
  previewContent: string;
  editorRef: React.MutableRefObject<any>;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const previewRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const syncingRef = useRef<"editor" | "preview" | null>(null);

  // Editor → Preview scroll sync
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const disposable = editor.onDidScrollChange?.((e: any) => {
      if (syncingRef.current === "preview") return;
      const preview = previewRef.current;
      if (!preview) return;
      const scrollTop = e.scrollTop;
      const scrollHeight = e.scrollHeight;
      const layoutHeight = editor.getLayoutInfo?.()?.height ?? 1;
      const maxScroll = scrollHeight - layoutHeight;
      if (maxScroll <= 0) return;
      const ratio = scrollTop / maxScroll;
      syncingRef.current = "editor";
      preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
      requestAnimationFrame(() => { syncingRef.current = null; });
    });
    return () => disposable?.dispose?.();
  }, [editorRef]);

  // Preview → Editor scroll sync
  const handlePreviewScroll = useCallback(
    (scrollTop: number, scrollHeight: number, clientHeight: number) => {
      if (syncingRef.current === "editor") return;
      const editor = editorRef.current;
      if (!editor) return;
      const maxScroll = scrollHeight - clientHeight;
      if (maxScroll <= 0) return;
      const ratio = scrollTop / maxScroll;
      const editorScrollHeight = editor.getScrollHeight?.() ?? 0;
      const layoutHeight = editor.getLayoutInfo?.()?.height ?? 1;
      const editorMaxScroll = editorScrollHeight - layoutHeight;
      syncingRef.current = "preview";
      editor.setScrollTop?.(ratio * editorMaxScroll);
      requestAnimationFrame(() => { syncingRef.current = null; });
    },
    [editorRef],
  );

  // Resizable divider drag
  const handleDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const startX = e.clientX;
      const rect = container.getBoundingClientRect();

      const onMouseMove = (ev: MouseEvent) => {
        const newRatio = (ev.clientX - rect.left) / rect.width;
        setSplitRatio(Math.max(0.2, Math.min(0.8, newRatio)));
      };
      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [],
  );

  return (
    <div ref={containerRef} style={styles.splitContainer} onContextMenu={onContextMenu}>
      <div style={{ ...styles.splitLeft, flex: splitRatio }}>
        {editorElement}
      </div>
      <div
        style={styles.splitDivider}
        onMouseDown={handleDividerMouseDown}
      />
      <div style={{ ...styles.splitRight, flex: 1 - splitRatio }}>
        <MarkdownPreview
          ref={previewRef}
          content={previewContent}
          onScroll={handlePreviewScroll}
        />
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
    position: "relative",
  },
  center: {
    display: "flex",
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    background: "#1b1b1b",
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
  splitContainer: {
    display: "flex",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    position: "relative",
  },
  splitLeft: {
    display: "flex",
    flexDirection: "column" as const,
    minWidth: 0,
    overflow: "hidden",
  },
  splitDivider: {
    width: 4,
    background: "#2d2d2d",
    flexShrink: 0,
    cursor: "col-resize",
  },
  splitRight: {
    display: "flex",
    flexDirection: "column" as const,
    minWidth: 0,
    overflow: "hidden",
  },
};

// ---------------------------------------------------------------------------
// Monarch tokenizer for bash/shell scripts
// ---------------------------------------------------------------------------

const shellLanguageDef: import("monaco-editor").languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".shell",

  brackets: [
    { open: "{", close: "}", token: "delimiter.curly" },
    { open: "[", close: "]", token: "delimiter.bracket" },
    { open: "(", close: ")", token: "delimiter.paren" },
  ],

  keywords: [
    "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done",
    "case", "esac", "in", "function", "select", "return", "exit",
    "break", "continue", "declare", "typeset", "local", "export", "readonly",
    "unset", "shift", "trap", "eval", "exec", "source", "set",
  ],

  builtins: [
    "echo", "printf", "read", "cd", "pwd", "pushd", "popd",
    "test", "true", "false", "kill", "wait", "sleep",
    "mkdir", "rmdir", "rm", "cp", "mv", "ln", "chmod", "chown",
    "cat", "head", "tail", "less", "more", "wc", "sort", "uniq",
    "grep", "awk", "sed", "cut", "tr", "tee", "xargs", "find",
    "curl", "wget", "tar", "zip", "unzip", "gzip", "gunzip",
    "git", "docker", "npm", "yarn", "pnpm", "cargo", "make",
    "env", "which", "type", "command", "hash",
  ],

  operators: [
    "&&", "||", "|", "&", ";", ";;", ">>", ">", "<<", "<",
    ">=", "<=", "!=", "==", "=", "!", "-eq", "-ne", "-lt",
    "-le", "-gt", "-ge", "-z", "-n", "-f", "-d", "-e", "-r",
    "-w", "-x", "-s",
  ],

  tokenizer: {
    root: [
      // Shebang
      [/^#!.*$/, "shebang"],

      // Comments
      [/#.*$/, "comment"],

      // Strings
      [/"/, "string", "@doubleQuoteString"],
      [/'/, "string", "@singleQuoteString"],

      // Here-doc start
      [/<<-?\s*['"]?(\w+)['"]?/, { token: "string", next: "@heredoc.$1" }],

      // Backtick command substitution
      [/`/, "string", "@backtickCmd"],

      // Variables
      [/\$\{/, "variable", "@variableExpansion"],
      [/\$\(/, "variable", "@commandSubstitution"],
      [/\$[A-Za-z_]\w*/, "variable"],
      [/\$[0-9#?!@*$-]/, "variable.special"],

      // Numbers
      [/\b\d+\b/, "number"],

      // Flags (--flag, -f)
      [/\s--?[A-Za-z][\w-]*/, "flag"],

      // Keywords and builtins
      [/[a-zA-Z_][\w-]*/, {
        cases: {
          "@keywords": "keyword",
          "@builtins": "builtin",
          "@default": "command",
        },
      }],

      // Operators
      [/[|&;><]+/, "operator"],
      [/[{}()\[\]]/, "@brackets"],
    ],

    doubleQuoteString: [
      [/\\./, "string.escape"],
      [/\$\{/, "variable", "@variableExpansion"],
      [/\$\(/, "variable", "@commandSubstitution"],
      [/\$[A-Za-z_]\w*/, "variable"],
      [/\$[0-9#?!@*$-]/, "variable.special"],
      [/"/, "string", "@pop"],
      [/[^"\\$]+/, "string"],
    ],

    singleQuoteString: [
      [/'/, "string", "@pop"],
      [/[^']+/, "string"],
    ],

    backtickCmd: [
      [/\\./, "string.escape"],
      [/`/, "string", "@pop"],
      [/[^`\\]+/, "string"],
    ],

    variableExpansion: [
      [/\}/, "variable", "@pop"],
      [/[^}]+/, "variable"],
    ],

    commandSubstitution: [
      [/\)/, "variable", "@pop"],
      [/\(/, "variable", "@push"],
      [/[^()]+/, "variable"],
    ],

    heredoc: [
      [/^(\w+)$/, {
        cases: {
          "$1==$S2": { token: "string", next: "@pop" },
          "@default": "string",
        },
      }],
      [/.*$/, "string"],
    ],
  },
};
