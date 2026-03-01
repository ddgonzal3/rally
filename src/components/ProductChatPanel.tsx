import React, { useState, useCallback, useRef, useEffect } from "react";
import { ChatView } from "./ChatView";
import { Terminal } from "./Terminal";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { api } from "../lib/tauri";
import type { OnFileOpen } from "../lib/terminalLinkProvider";
import { BranchSwitcher } from "./BranchSwitcher";

interface ProductChatPanelProps {
  rootPath: string;
  workspaceId: string;
}

function shortenPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~");
}

const IDLE_SESSION = { state: "idle" as const, ptyId: undefined, prompt: "" };

export function ProductChatPanel({ rootPath, workspaceId }: ProductChatPanelProps) {
  const session = useWorkspaceStore(
    (s) => s.productSessions[workspaceId] ?? IDLE_SESSION
  );
  const setProductSession = useWorkspaceStore((s) => s.setProductSession);
  const clearProductSession = useWorkspaceStore((s) => s.clearProductSession);
  const startChatSession = useWorkspaceStore((s) => s.startChatSession);
  const clearChatSession = useWorkspaceStore((s) => s.clearChatSession);

  const { state, prompt } = session;

  const [inputFocused, setInputFocused] = useState(false);
  const [readiness, setReadiness] = useState<{ ready: boolean; issues: string[] } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const openFile = useWorkspaceStore((s) => s.openFile);
  const gitStatus = useWorkspaceStore((s) => s.gitStatuses[rootPath]);
  const branch = gitStatus?.branch ?? "";
  const mainBranch = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.paths.includes(rootPath));
    return ws?.main_branch ?? "main";
  });
  const refreshGitStatusForPath = useWorkspaceStore((s) => s.refreshGitStatusForPath);
  const refreshPrStatusForPath = useWorkspaceStore((s) => s.refreshPrStatusForPath);

  const shellPanel = useWorkspaceStore((s) => s.shellPanels[workspaceId]);
  const toggleShellPanel = useWorkspaceStore((s) => s.toggleShellPanel);

  const repoName = rootPath.split("/").pop() || "Claude Code";

  const SHELL_DEFAULT = 33;
  const SHELL_MAX = 50; // percentage of container height
  const [shellHeight, setShellHeight] = useState(SHELL_DEFAULT);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  // Clean up resize listeners on unmount
  useEffect(() => {
    return () => resizeCleanupRef.current?.();
  }, []);

  const handleShellResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = shellHeight;
    const container = (e.target as HTMLElement).closest('[data-shell-container]') as HTMLElement;
    if (!container) return;
    const containerHeight = container.getBoundingClientRect().height;

    const onMove = (ev: MouseEvent) => {
      const dy = startY - ev.clientY;
      const newHeight = startHeight + (dy / containerHeight) * 100;
      setShellHeight(Math.min(SHELL_MAX, Math.max(15, newHeight)));
    };
    const cleanup = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", cleanup);
      resizeCleanupRef.current = null;
    };
    resizeCleanupRef.current?.();
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", cleanup);
    resizeCleanupRef.current = cleanup;
  }, [shellHeight]);

  // Check workspace readiness on mount
  useEffect(() => {
    if (state !== "idle") return;
    api.checkWorkspaceReady(rootPath).then((result) => {
      setReadiness(result);
      if (!result.ready && !prompt) {
        const issueList = result.issues.map((i) => `- ${i}`).join("\n");
        setProductSession(workspaceId, {
          state: "idle",
          ptyId: undefined,
          prompt: `Set up this project. Issues detected:\n${issueList}\n\nCheck RALLY.json for any setup instructions, then install dependencies and prepare the development environment.`,
        });
      }
    }).catch(() => {
      // Silently ignore — readiness check is best-effort
    });
  }, [state, rootPath]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFileOpen: OnFileOpen = useCallback(
    (filePath, line, col) => {
      openFile(workspaceId, filePath, { line, col });
    },
    [workspaceId, openFile],
  );

  const handleSubmit = useCallback(() => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    startChatSession(workspaceId, rootPath, trimmed).catch((e) => {
      console.error("Failed to start chat session:", e);
      // Fallback: still show as active to not lose the prompt
      setProductSession(workspaceId, { state: "active", ptyId: undefined, prompt: trimmed });
    });
  }, [prompt, workspaceId, rootPath, startChatSession, setProductSession]);

  // Auto-resize textarea to fit content
  const autoResize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, []);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setProductSession(workspaceId, { ...session, prompt: e.target.value });
    requestAnimationFrame(autoResize);
  }, [workspaceId, session, setProductSession, autoResize]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleNewSession = useCallback(() => {
    // Clean up chat session
    clearChatSession(workspaceId).then(() => {
      clearProductSession(workspaceId);
      setReadiness(null);
    }).catch(() => {
      clearProductSession(workspaceId);
      setReadiness(null);
    });
  }, [workspaceId, clearChatSession, clearProductSession]);

  // Focus input when returning to idle
  useEffect(() => {
    if (state === "idle") {
      // Short delay to let the DOM settle
      const t = setTimeout(() => inputRef.current?.focus(), 100);
      return () => clearTimeout(t);
    }
  }, [state]);

  // Content stays at 28% when shell <= default. Above default, shift up proportionally.
  const contentTop = shellPanel?.visible && shellHeight > SHELL_DEFAULT
    ? Math.max(8, 28 - (shellHeight - SHELL_DEFAULT))
    : 28;

  if (state === "idle") {
    const needsSetup = readiness && !readiness.ready;

    return (
      <div style={styles.outerContainer} data-shell-container>
        <div style={styles.idleContainer} />
        <div style={{ ...styles.idleContent, top: `${contentTop}%` }}>
          {/* Claude mascot */}
          <svg
            width="36"
            height="36"
            viewBox="0 0 24 24"
            fill="#c5c5c5"
            fillRule="evenodd"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" />
          </svg>

          <span style={styles.repoName}>{repoName}</span>

          {needsSetup && (
            <span style={styles.setupHint}>This project needs setup</span>
          )}

          {/* Frosted glass input card */}
          <div
            style={{
              ...styles.inputCard,
              borderColor: inputFocused
                ? "rgba(255,255,255,0.22)"
                : "rgba(255,255,255,0.12)",
            }}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
          >
            <div style={styles.inputRow}>
              <textarea
                ref={(el) => {
                  (inputRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
                  // Resize on mount to fit pre-filled text
                  if (el) {
                    el.style.height = "auto";
                    el.style.height = el.scrollHeight + "px";
                  }
                }}
                value={prompt}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                placeholder="What would you like to build?"
                style={styles.input}
                rows={1}
                autoFocus
              />
              <button
                style={{
                  ...styles.submitBtn,
                  background: prompt.trim() ? "rgba(255,255,255,0.15)" : "transparent",
                  opacity: prompt.trim() ? 1 : 0.3,
                }}
                onClick={handleSubmit}
                disabled={!prompt.trim()}
                title="Send"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M8 12V4M5 5l3-3 3 3"
                    stroke="#fff"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>

            {/* Info bar */}
            <div style={styles.infoBar}>
              {/* Folder icon */}
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                <path
                  d="M2 4.5A1.5 1.5 0 013.5 3H6l1 1.5h5.5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z"
                  stroke="#bbb"
                  strokeWidth="1.1"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
              <span style={styles.infoText}>{shortenPath(rootPath)}</span>
              {branch && (
                <BranchSwitcher
                  rootPath={rootPath}
                  branchName={branch}
                  mainBranch={mainBranch}
                  onBranchChanged={() => {
                    refreshGitStatusForPath(rootPath, mainBranch).catch(() => {});
                    refreshPrStatusForPath(rootPath).catch(() => {});
                  }}
                  variant="inline"
                />
              )}
              <button
                style={styles.shellToggleBtn}
                onClick={() => toggleShellPanel(workspaceId, rootPath)}
                title="Toggle terminal (Ctrl+`)"
              >
                Terminal
              </button>
            </div>
          </div>
        </div>
      {shellPanel?.visible && (
        <div style={{ height: `${shellHeight}%`, minHeight: 80, display: "flex", flexDirection: "column", zIndex: 2, flexShrink: 0 }}>
          <div style={styles.shellResizeHandle} onMouseDown={handleShellResize}>
            <div style={styles.shellResizeLine} />
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, borderTop: "1px solid #333" }}>
            <Terminal cwd={rootPath} ptyId={shellPanel.ptyId} onFileOpen={handleFileOpen} />
          </div>
        </div>
      )}
      </div>
    );
  }

  // Active state: header + terminal
  return (
    <div style={styles.outerContainer} data-shell-container>
    <div style={{ ...styles.activeContainer, flex: shellPanel?.visible ? undefined : 1, height: shellPanel?.visible ? `${100 - shellHeight}%` : undefined }}>
      <div style={styles.activeHeader}>
        <button
          className="sidebar-btn"
          style={styles.newSessionBtn}
          onClick={handleNewSession}
          title="End session and start a new one"
        >
          New Session
        </button>
        <div style={styles.headerRight}>
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
            <path
              d="M2 4.5A1.5 1.5 0 013.5 3H6l1 1.5h5.5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z"
              stroke="#777"
              strokeWidth="1.1"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
          <span style={styles.headerPathText}>{shortenPath(rootPath)}</span>
          {branch && (
            <BranchSwitcher
              rootPath={rootPath}
              branchName={branch}
              mainBranch={mainBranch}
              onBranchChanged={() => {
                refreshGitStatusForPath(rootPath, mainBranch).catch(() => {});
                refreshPrStatusForPath(rootPath).catch(() => {});
              }}
              variant="inline"
            />
          )}
          <button
            className="sidebar-btn"
            style={styles.shellToggleBtnHeader}
            onClick={() => toggleShellPanel(workspaceId, rootPath)}
            title="Toggle terminal (Ctrl+`)"
          >
            Terminal
          </button>
        </div>
      </div>
      <ChatView workspaceId={workspaceId} rootPath={rootPath} />
    </div>
    {shellPanel?.visible && (
      <div style={{ height: `${shellHeight}%`, minHeight: 80, display: "flex", flexDirection: "column", zIndex: 2, flexShrink: 0 }}>
        <div style={styles.shellResizeHandle} onMouseDown={handleShellResize}>
          <div style={styles.shellResizeLine} />
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, borderTop: "1px solid #333" }}>
          <Terminal cwd={rootPath} ptyId={shellPanel.ptyId} onFileOpen={handleFileOpen} />
        </div>
      </div>
    )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // Idle state
  idleContainer: {
    position: "absolute",
    inset: 0,
    background: "#1b1b1b",
    backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.04) 1px, transparent 1px)",
    backgroundSize: "16px 16px",
  },
  idleContent: {
    position: "absolute",
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    width: "100%",
    maxWidth: 648,
    paddingLeft: 24,
    paddingRight: 24,
    gap: 8,
    zIndex: 1,
    pointerEvents: "auto",
  },
  repoName: {
    fontSize: 20,
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontWeight: 400,
    color: "#fff",
    letterSpacing: "0.01em",
    lineHeight: 1,
    marginTop: 2,
  },
  setupHint: {
    fontSize: 12,
    color: "#e2c08d",
    fontWeight: 500,
    marginTop: 2,
  },
  inputCard: {
    width: "100%",
    maxWidth: 600,
    marginTop: 20,
    background: "rgba(40, 40, 40, 0.85)",
    backdropFilter: "blur(20px) saturate(150%)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 14,
    transition: "border-color 0.15s ease",
  },
  inputRow: {
    display: "flex",
    alignItems: "center",
    position: "relative",
  },
  input: {
    flex: 1,
    background: "transparent",
    border: "none",
    padding: "12px 44px 12px 16px",
    fontSize: 14,
    color: "#e0e0e0",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    outline: "none",
    resize: "none",
    lineHeight: 1.4,
    maxHeight: 200,
    overflowY: "auto",
  },
  submitBtn: {
    position: "absolute",
    right: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 32,
    height: 32,
    border: "none",
    borderRadius: 10,
    cursor: "pointer",
    padding: 0,
    transition: "background 0.15s ease",
  },
  infoBar: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    padding: "6px 16px",
    borderTop: "1px solid rgba(255,255,255,0.06)",
  },
  infoText: {
    fontSize: 11,
    color: "#bbb",
    fontWeight: 400,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },

  // Active state
  activeContainer: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
  },
  activeHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 10px",
    minHeight: 29,
    maxHeight: 29,
    background: "#1e1e1e",
    borderBottom: "1px solid #333",
    zIndex: 10,
    position: "relative" as const,
    flexShrink: 0,
  },
  newSessionBtn: {
    display: "flex",
    alignItems: "center",
    background: "none",
    border: "none",
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 500,
    color: "#999",
    padding: "0 6px",
    borderRadius: 4,
    height: 22,
    whiteSpace: "nowrap" as const,
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    overflow: "hidden",
    minWidth: 0,
  },
  headerPathText: {
    fontSize: 11,
    color: "#777",
    fontWeight: 400,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  terminalArea: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    minWidth: 0,
    position: "relative",
  },

  // Shell panel
  outerContainer: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    justifyContent: "flex-end",
    position: "relative",
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
  },
  shellToggleBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    marginLeft: "auto",
    borderRadius: 3,
    fontSize: 11,
    color: "#999",
    fontWeight: 400,
    padding: "1px 4px",
    letterSpacing: "0.01em",
  },
  shellToggleBtnHeader: {
    background: "none",
    border: "none",
    cursor: "pointer",
    borderRadius: 4,
    padding: "0 6px",
    marginLeft: 6,
    fontSize: 11,
    color: "#999",
    fontWeight: 400,
    height: 22,
    letterSpacing: "0.01em",
    whiteSpace: "nowrap" as const,
  },
  shellResizeHandle: {
    height: 6,
    cursor: "row-resize",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    background: "#1e1e1e",
  },
  shellResizeLine: {
    width: 32,
    height: 2,
    borderRadius: 1,
    background: "rgba(255,255,255,0.15)",
  },
};
