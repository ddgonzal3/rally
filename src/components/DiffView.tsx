import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { api } from "../lib/tauri";
import { addToast } from "./ToastContainer";

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
  isActive?: boolean;
}

type ChangeKind = "staged" | "unstaged" | "untracked" | null;
const GIT_CHANGES_REFRESH_EVENT = "rally:git-changes-refresh";

function toRepoRelativePath(rootPath: string, filePath: string): string {
  if (filePath.startsWith(rootPath + "/")) {
    return filePath.slice(rootPath.length + 1);
  }
  return filePath;
}

/**
 * Full-pane Monaco DiffEditor. Shows HEAD vs working copy for a single file.
 */
export function DiffView({
  rootPath,
  filePath,
  isUntracked,
  isActive = true,
}: DiffViewProps) {
  const [original, setOriginal] = useState("");
  const [modified, setModified] = useState("");
  const [loading, setLoading] = useState(true);
  const [changeKind, setChangeKind] = useState<ChangeKind>(null);
  const [actionBusy, setActionBusy] = useState<null | "stage" | "unstage" | "discard">(null);
  const [reloadToken, setReloadToken] = useState(0);
  const repoFilePath = useMemo(
    () => toRepoRelativePath(rootPath, filePath),
    [rootPath, filePath]
  );

  const showError = useCallback((title: string, e: unknown) => {
    addToast({
      type: "warning",
      title,
      message: String(e),
    });
  }, []);

  const doAction = useCallback(
    async (
      kind: "stage" | "unstage" | "discard",
      action: () => Promise<void>
    ) => {
      setActionBusy(kind);
      try {
        await action();
        document.dispatchEvent(
          new CustomEvent<{ rootPath: string }>(GIT_CHANGES_REFRESH_EVENT, {
            detail: { rootPath },
          })
        );
      } catch (e) {
        showError(
          kind === "stage"
            ? "Stage failed"
            : kind === "unstage"
              ? "Unstage failed"
              : "Discard failed",
          e
        );
      } finally {
        setActionBusy(null);
      }
    },
    [rootPath, showError]
  );

  // Track whether this is the initial load vs a background refresh.
  // On initial load (file/path change) we show a loading spinner.
  // On background refresh (reloadToken from file watcher) we silently
  // re-fetch and only update state if the content actually changed,
  // preserving the Monaco editor instance and its scroll position.
  const isInitialLoad = useRef(true);

  useEffect(() => {
    // Reset to initial load when the file identity changes
    isInitialLoad.current = true;
  }, [rootPath, filePath, repoFilePath, isUntracked]);

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    const showLoading = isInitialLoad.current;
    if (showLoading) {
      setLoading(true);
      setChangeKind(null);
    }
    isInitialLoad.current = false;

    (async () => {
      const fullPath = filePath.startsWith("/") ? filePath : `${rootPath}/${repoFilePath}`;

      // Get current file content
      let mod = "";
      try { mod = await api.readFileContent(fullPath); } catch { /* deleted */ }

      let detectedKind: ChangeKind = null;
      try {
        const changes = await api.gitChanges(rootPath);
        if (changes.untracked.includes(repoFilePath)) {
          detectedKind = "untracked";
        } else if (changes.unstaged.some((f) => f.path === repoFilePath)) {
          detectedKind = "unstaged";
        } else if (changes.staged.some((f) => f.path === repoFilePath)) {
          detectedKind = "staged";
        }
      } catch {
        // Fall back to prop hint when changes query fails.
      }

      // Get HEAD version (empty for untracked)
      let orig = "";
      const untracked = detectedKind === "untracked" || (!!isUntracked && detectedKind === null);
      if (!untracked) {
        try { orig = await api.gitFileAtHead(rootPath, repoFilePath); } catch { /* new file */ }
      }

      if (!cancelled) {
        const nextKind = detectedKind ?? (isUntracked ? "untracked" : null);
        setOriginal((prev) => (prev === orig ? prev : orig));
        setModified((prev) => (prev === mod ? prev : mod));
        setChangeKind((prev) => (prev === nextKind ? prev : nextKind));
        if (showLoading) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [rootPath, filePath, repoFilePath, isUntracked, reloadToken, isActive]);

  useEffect(() => {
    if (!isActive) return;
    const onRefreshEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ rootPath?: string }>).detail;
      if (!detail || detail.rootPath === rootPath) {
        setReloadToken((x) => x + 1);
      }
    };
    document.addEventListener(GIT_CHANGES_REFRESH_EVENT, onRefreshEvent);
    return () => document.removeEventListener(GIT_CHANGES_REFRESH_EVENT, onRefreshEvent);
  }, [rootPath, isActive]);

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-dim)", fontSize: 13 }}>
        Loading diff...
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {changeKind && (
        <div style={styles.toolbar}>
          <span style={{ flex: 1 }} />
          {changeKind === "staged" && (
            <button
              style={styles.actionBtn}
              disabled={actionBusy !== null}
              onClick={() =>
                doAction("unstage", () => api.gitUnstageFile(rootPath, repoFilePath))
              }
              title="Unstage file"
            >
              Unstage
            </button>
          )}
          {(changeKind === "unstaged" || changeKind === "untracked") && (
            <>
              <button
                style={styles.actionBtn}
                disabled={actionBusy !== null}
                onClick={() =>
                  doAction("stage", () => api.gitStageFile(rootPath, repoFilePath))
                }
                title="Stage file"
              >
                Stage
              </button>
              <button
                style={{ ...styles.actionBtn, ...styles.dangerBtn }}
                disabled={actionBusy !== null}
                onClick={() =>
                  doAction("discard", () =>
                    api.gitDiscardFile(
                      rootPath,
                      repoFilePath,
                      changeKind === "untracked"
                    )
                  )
                }
                title={changeKind === "untracked" ? "Remove untracked file" : "Discard unstaged changes"}
              >
                Discard
              </button>
            </>
          )}
        </div>
      )}
      <div style={styles.editorWrap}>
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
            glyphMargin: false,
            codeLens: false,
            selectionHighlight: false,
            occurrencesHighlight: "off",
            renderValidationDecorations: "off",
            quickSuggestions: false,
            fontSize: 13,
            lineNumbers: "on",
            padding: { top: 8 },
          }}
        />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 8px",
    borderBottom: "1px solid var(--border)",
    flexShrink: 0,
    background: "var(--bg-surface)",
  },
  actionBtn: {
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    borderRadius: 4,
    color: "var(--text-secondary)",
    fontSize: 11,
    lineHeight: 1.2,
    padding: "3px 8px",
    cursor: "pointer",
  },
  dangerBtn: {
    color: "#d5b5b5",
    borderColor: "#5a3a3a",
    background: "#332424",
  },
  editorWrap: {
    flex: 1,
    minHeight: 0,
  },
};
