import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Editor, { type OnMount, type BeforeMount } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { showContextMenu } from "../lib/contextMenu";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { addToast } from "./ToastContainer";
import { MarkdownPreview } from "./MarkdownPreview";

interface EditorPaneProps {
  filePath: string;
  paneId: string;
  workspaceId: string;
  groupId: string;
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

  // Shell dotfiles
  const shellDotfiles = new Set([
    ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout",
    ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".bash_aliases",
    ".profile", ".shrc", ".kshrc", ".cshrc", ".tcshrc", ".login",
  ]);
  if (shellDotfiles.has(name)) return "shell";

  // INI-style dotfiles
  if (name === ".gitconfig" || name === ".editorconfig") return "ini";
  if (name === ".npmrc" || name === ".yarnrc") return "ini";

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

export const EditorPane = React.memo(function EditorPane({ filePath, paneId, workspaceId, groupId }: EditorPaneProps) {
  if (isImageFile(filePath)) {
    return <ImageViewer filePath={filePath} />;
  }
  return <TextEditor filePath={filePath} paneId={paneId} workspaceId={workspaceId} groupId={groupId} />;
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
const BASE_FONT_SIZE = 13;

function getStoredZoomLevel(): number {
  const saved = localStorage.getItem("rally:zoomLevel");
  const zoom = saved ? Number(saved) : 1;
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

function TextEditor({ filePath, paneId, workspaceId, groupId }: { filePath: string; paneId: string; workspaceId: string; groupId: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState("");
  const contentRef = useRef("");
  const editorRef = useRef<any>(null);
  const language = getLanguageFromPath(filePath);
  const markDirty = useWorkspaceStore((s) => s.markPaneDirty);
  const markClean = useWorkspaceStore((s) => s.markPaneClean);
  const appTheme = useWorkspaceStore((s) => s.theme);

  // Neutralize body CSS zoom on Monaco's DOM element so coordinate math
  // (click-to-position, double-click selection) works correctly.
  // Same technique as Terminal.tsx: body has zoom:Z, we apply zoom:1/Z
  // on Monaco's element, then scale font size by Z to compensate visually.
  const zoomRef = useRef(getStoredZoomLevel());

  // Subscribe to initialLine/initialCol/editorViewMode from pane data (set via Cmd+click)
  // Direct lookup by workspaceId/groupId avoids iterating all layouts/groups
  const paneDataRef = useRef<{ initialLine?: number; initialCol?: number; editorViewMode?: string }>({});
  const paneData = useWorkspaceStore((s) => {
    const pane = s.layouts[workspaceId]?.groups[groupId]?.panes.find((p) => p.id === paneId);
    if (pane) {
      const next = { initialLine: pane.initialLine, initialCol: pane.initialCol, editorViewMode: pane.editorViewMode };
      const prev = paneDataRef.current;
      if (prev.initialLine === next.initialLine && prev.initialCol === next.initialCol && prev.editorViewMode === next.editorViewMode) {
        return prev;
      }
      paneDataRef.current = next;
      return next;
    }
    return paneDataRef.current;
  });
  const initialLine = paneData?.initialLine;
  const initialCol = paneData?.initialCol;
  const editorViewMode = paneData?.editorViewMode;

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

  const ext = getExtension(filePath);
  const isMarkdown = ext === "md";
  const isHtml = ext === "html" || ext === "htm";
  const hasPreview = isMarkdown || isHtml;
  const viewMode = hasPreview ? (editorViewMode ?? "raw") : "raw";

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
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
      noSuggestionDiagnostics: true,
      onlyVisible: true,
    });
    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
      noSuggestionDiagnostics: true,
      onlyVisible: true,
    });

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

    monaco.editor.defineTheme("rally-dimmed", {
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
        "editor.background": "#202020",
      },
    });

    monaco.editor.defineTheme("rally-light", {
      base: "vs",
      inherit: true,
      rules: [
        { token: "comment.shell", foreground: "4e7a3e", fontStyle: "italic" },
        { token: "keyword.shell", foreground: "8b2e8b" },
        { token: "string.shell", foreground: "a44a1f" },
        { token: "string.escape.shell", foreground: "8a6914" },
        { token: "variable.shell", foreground: "1a6090" },
        { token: "variable.special.shell", foreground: "0070a0" },
        { token: "number.shell", foreground: "4a7030" },
        { token: "operator.shell", foreground: "333333" },
        { token: "delimiter.shell", foreground: "333333" },
        { token: "builtin.shell", foreground: "795e26" },
        { token: "command.shell", foreground: "267f6e" },
        { token: "flag.shell", foreground: "1a6090" },
        { token: "shebang.shell", foreground: "4e7a3e", fontStyle: "italic" },
      ],
      colors: {
        "editor.background": "#c4c4c4",
        "editor.foreground": "#111111",
        "editorLineNumber.foreground": "#666666",
        "editorCursor.foreground": "#333333",
        "editor.selectionBackground": "#8ab4d866",
        "editor.lineHighlightBackground": "#00000008",
        "editorWidget.background": "#bfbfbf",
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

      // Neutralize body CSS zoom on Monaco's DOM element
      const domNode = editor.getDomNode();
      if (domNode) {
        const z = getStoredZoomLevel();
        if (z !== 1) {
          domNode.style.zoom = String(1 / z);
        }
      }

      // Jump to line:col if specified (e.g. from Cmd+click in terminal)
      if (initialLine) {
        editor.revealLineInCenter(initialLine);
        editor.setPosition({ lineNumber: initialLine, column: initialCol || 1 });
        editor.focus();
      }
    },
    [handleSave, initialLine, initialCol]
  );

  // Keep zoom neutralization in sync when body zoom changes
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const domNode = editor.getDomNode();
    if (!domNode) return;
    const parentEl = domNode.parentElement;
    if (!parentEl) return;

    const ro = new ResizeObserver(() => {
      const z = getStoredZoomLevel();
      if (z !== zoomRef.current) {
        zoomRef.current = z;
        domNode.style.zoom = z === 1 ? "" : String(1 / z);
        editor.updateOptions({ fontSize: Math.round(BASE_FONT_SIZE * z) });
        editor.layout();
      }
    });
    ro.observe(parentEl);
    return () => ro.disconnect();
  }, []);

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

  const editorOptions = useMemo(() => ({
    automaticLayout: true,
    contextmenu: false,
    minimap: { enabled: false },
    fontSize: Math.round(BASE_FONT_SIZE * getStoredZoomLevel()),
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
    lineNumbers: "on" as const,
    wordWrap: "off" as const,
    scrollBeyondLastLine: false,
    glyphMargin: false,
    codeLens: false,
    folding: false,
    links: false,
    colorDecorators: false,
    selectionHighlight: false,
    occurrencesHighlight: "off" as const,
    renderValidationDecorations: "off" as const,
    wordBasedSuggestions: "off" as const,
    quickSuggestions: false,
    padding: { top: 8 },
    renderLineHighlight: "line" as const,
    smoothScrolling: false,
    cursorSmoothCaretAnimation: "off" as const,
    disableLayerHinting: true,
    guides: {
      indentation: false,
      bracketPairs: false,
      highlightActiveIndentation: false,
      bracketPairsHorizontal: false,
      highlightActiveBracketPair: false,
    },
    matchBrackets: "never" as const,
    stickyScroll: { enabled: false },
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    scrollbar: {
      verticalScrollbarSize: 10,
      horizontalScrollbarSize: 10,
      useShadows: false,
      alwaysConsumeMouseWheel: false,
    },
  }), []);

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
      theme={`rally-${appTheme}`}
      defaultValue={content}
      saveViewState
      keepCurrentModel
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
      options={editorOptions}
    />
  );

  if (viewMode === "preview") {
    return (
      <div style={styles.container}>
        {isHtml ? (
          <HtmlPreview content={previewContent} />
        ) : (
          <MarkdownPreview content={previewContent} />
        )}
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

/** HTML preview — renders content in a sandboxed iframe */
function HtmlPreview({ content }: { content: string }) {
  return (
    <iframe
      srcDoc={content}
      sandbox="allow-scripts"
      style={styles.htmlIframe}
      title="HTML Preview"
    />
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
    contain: "layout paint",
    overflow: "hidden",
  },
  center: {
    display: "flex",
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    background: "var(--bg-surface)",
  },
  imageContainer: {
    display: "flex",
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    background: "var(--bg-surface)",
    overflow: "auto",
    padding: 24,
  },
  image: {
    maxWidth: "100%",
    maxHeight: "100%",
    objectFit: "contain" as const,
    borderRadius: 4,
    boxShadow: "0 2px 12px var(--shadow)",
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
    background: "var(--bg-elevated)",
    flexShrink: 0,
    cursor: "col-resize",
  },
  splitRight: {
    display: "flex",
    flexDirection: "column" as const,
    minWidth: 0,
    overflow: "hidden",
  },
  htmlIframe: {
    flex: 1,
    width: "100%",
    border: "none",
    background: "#fff",
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
