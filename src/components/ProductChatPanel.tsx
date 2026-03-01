import React, { useState, useCallback, useRef, useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ClaudeTerminalWrapper } from "./ClaudeTerminalWrapper";
import { Terminal } from "./Terminal";
import { useWorkspaceStore, clearPtyBuffer } from "../stores/workspaceStore";
import { api } from "../lib/tauri";
import type { OnFileOpen } from "../lib/terminalLinkProvider";
import { BranchSwitcher } from "./BranchSwitcher";
import { RepoSwitcher } from "./RepoSwitcher";
import { addToast } from "./ToastContainer";

// Inject spin keyframe once
if (typeof document !== "undefined" && !document.getElementById("rally-spin-keyframe")) {
  const style = document.createElement("style");
  style.id = "rally-spin-keyframe";
  style.textContent = `@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`;
  document.head.appendChild(style);
}

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

  const { state, ptyId, prompt } = session;

  const [inputFocused, setInputFocused] = useState(false);
  const [readiness, setReadiness] = useState<{ ready: boolean; issues: string[] } | null>(null);
  const [dangerousMode, setDangerousMode] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const syncBranch = useWorkspaceStore((s) => s.syncBranch);
  const ptyIdRef = useRef<string | undefined>(undefined);
  const unlistenExitRef = useRef<UnlistenFn | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ptyIdRef.current = ptyId;
  }, [ptyId]);

  const openFile = useWorkspaceStore((s) => s.openFile);
  const gitStatus = useWorkspaceStore((s) => s.gitStatuses[rootPath]);
  const branch = gitStatus?.branch ?? "";
  const mainBranch = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.paths.includes(rootPath));
    return ws?.main_branch ?? "main";
  });
  const refreshGitStatusForPath = useWorkspaceStore((s) => s.refreshGitStatusForPath);
  const refreshPrStatusForPath = useWorkspaceStore((s) => s.refreshPrStatusForPath);
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId));

  const shellPanel = useWorkspaceStore((s) => s.shellPanels[workspaceId]);
  const toggleShellPanel = useWorkspaceStore((s) => s.toggleShellPanel);

  const repoName = rootPath.split("/").pop() || "Claude Code";

  const SHELL_DEFAULT = 33;
  const SHELL_MAX = 50;
  const [shellHeight, setShellHeight] = useState(SHELL_DEFAULT);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => resizeCleanupRef.current?.();
  }, []);

  // Clear shell panel PTY buffer on unmount (mode switch PRD→DEV)
  useEffect(() => {
    return () => {
      const panel = useWorkspaceStore.getState().shellPanels[workspaceId];
      if (panel?.ptyId) {
        clearPtyBuffer(panel.ptyId);
      }
    };
  }, [workspaceId]);

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

  const prevRootPathRef = useRef(rootPath);
  useEffect(() => {
    if (prevRootPathRef.current !== rootPath) {
      prevRootPathRef.current = rootPath;
      if (state === "idle") {
        // Clear auto-generated setup text from the previous repo
        if (prompt.startsWith("Set up this project.")) {
          setProductSession(workspaceId, { state: "idle", ptyId: undefined, prompt: "" });
        }
        setReadiness(null);
      }
    }
  }, [rootPath, state, prompt, workspaceId, setProductSession]);

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
    }).catch(() => {});
  }, [state, rootPath]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFileOpen: OnFileOpen = useCallback(
    (filePath, line, col) => {
      openFile(workspaceId, filePath, { line, col });
    },
    [workspaceId, openFile],
  );

  const handlePtySpawned = useCallback((id: string) => {
    ptyIdRef.current = id;
    setProductSession(workspaceId, { state: "active", ptyId: id, prompt });
  }, [workspaceId, prompt, setProductSession]);

  // Listen for PTY exit to transition back to idle
  useEffect(() => {
    if (!ptyId) return;

    let cancelled = false;
    listen<{ code: number | null }>(`pty-exit-${ptyId}`, () => {
      if (cancelled) return;
      setTimeout(() => {
        if (!cancelled) {
          ptyIdRef.current = undefined;
          clearProductSession(workspaceId);
          setReadiness(null);
        }
      }, 2000);
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        unlistenExitRef.current = unlisten;
      }
    });

    return () => {
      cancelled = true;
      unlistenExitRef.current?.();
      unlistenExitRef.current = null;
    };
  }, [ptyId, workspaceId, clearProductSession]);

  const handleSubmit = useCallback(() => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    setProductSession(workspaceId, { state: "active", ptyId: undefined, prompt: trimmed });
  }, [prompt, workspaceId, setProductSession]);

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
    if (ptyIdRef.current) {
      api.killPty(ptyIdRef.current);
    }
    unlistenExitRef.current?.();
    unlistenExitRef.current = null;
    ptyIdRef.current = undefined;
    clearProductSession(workspaceId);
  }, [workspaceId, clearProductSession]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      await syncBranch(rootPath, mainBranch);
      addToast({ type: "success", title: "Sync complete", message: `Synced ${branch} with ${mainBranch}` });
    } catch (e) {
      addToast({ type: "warning", title: "Sync failed", message: String(e instanceof Error ? e.message : e) });
    } finally {
      setSyncing(false);
    }
  }, [syncBranch, rootPath, mainBranch, branch]);

  useEffect(() => {
    if (state === "idle") {
      const t = setTimeout(() => inputRef.current?.focus(), 100);
      return () => clearTimeout(t);
    }
  }, [state]);

  const contentTop = shellPanel?.visible && shellHeight > SHELL_DEFAULT
    ? Math.max(8, 28 - (shellHeight - SHELL_DEFAULT))
    : 28;

  // Build the claude command with prompt as CLI argument
  const claudeFlags = dangerousMode ? " --dangerously-skip-permissions" : "";

  if (state === "idle") {
    const needsSetup = readiness && !readiness.ready;

    return (
      <div style={styles.outerContainer} data-shell-container>
        <div style={styles.idleContainer} />
        <div style={{ ...styles.activeHeader, position: "absolute", top: 0, left: 0, right: 0, zIndex: 10 }}>
          <div />
          <div style={styles.headerRight}>
            <RepoSwitcher workspaceId={workspaceId} rootPath={rootPath} />
            {(workspace?.paths.length ?? 0) <= 1 && (
              <>
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                  <path
                    d="M2 4.5A1.5 1.5 0 013.5 3H6l1 1.5h5.5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z"
                    stroke="var(--text-secondary)"
                    strokeWidth="1.1"
                    strokeLinejoin="round"
                    fill="none"
                  />
                </svg>
                <span style={styles.headerPathText}>{shortenPath(rootPath)}</span>
              </>
            )}
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
            {gitStatus && gitStatus.behind > 0 && branch !== mainBranch && (
              <button
                style={styles.syncBtn}
                onClick={handleSync}
                disabled={syncing}
                title={`Sync ${branch} with ${mainBranch} (${gitStatus.behind} behind)`}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  style={syncing ? { animation: "spin 1s linear infinite" } : undefined}
                >
                  <path
                    d="M2.5 8a5.5 5.5 0 0 1 9.3-3.95L10 6h5V1l-1.8 1.8A7.5 7.5 0 0 0 .5 8h2zm11 0a5.5 5.5 0 0 1-9.3 3.95L6 10H1v5l1.8-1.8A7.5 7.5 0 0 0 15.5 8h-2z"
                    fill="var(--text-secondary)"
                  />
                </svg>
              </button>
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
        <div style={{ ...styles.idleContent, top: `${contentTop}%` }}>
          <svg
            width="36"
            height="36"
            viewBox="0 0 24 24"
            fill="var(--text-secondary)"
            fillRule="evenodd"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" />
          </svg>

          <span style={styles.repoName}>{repoName}</span>

          {needsSetup && (
            <span style={styles.setupHint}>This project needs setup</span>
          )}

          <div
            style={{
              ...styles.inputCard,
              borderColor: inputFocused
                ? "var(--border)"
                : "var(--border-subtle)",
            }}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
          >
            <div style={styles.inputRow}>
              <textarea
                ref={(el) => {
                  (inputRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
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
                    stroke="var(--text-primary)"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>

            <div style={styles.infoBar}>
              <RepoSwitcher workspaceId={workspaceId} rootPath={rootPath} />
              {(workspace?.paths.length ?? 0) <= 1 && (
                <>
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                    <path
                      d="M2 4.5A1.5 1.5 0 013.5 3H6l1 1.5h5.5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z"
                      stroke="var(--text-secondary)"
                      strokeWidth="1.1"
                      strokeLinejoin="round"
                      fill="none"
                    />
                  </svg>
                  <span style={styles.headerPathText}>{shortenPath(rootPath)}</span>
                </>
              )}
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
              <div style={{ flex: 1 }} />
              <label
                style={{ ...styles.toggleLabel, marginLeft: 0 }}
                title="Start Claude Code with --dangerously-skip-permissions"
                onMouseDown={(e) => e.preventDefault()}
              >
                <div
                  onClick={() => setDangerousMode(!dangerousMode)}
                  style={{
                    ...styles.toggleTrack,
                    background: dangerousMode ? "rgba(100,130,180,0.55)" : "rgba(255,255,255,0.08)",
                  }}
                >
                  <div
                    style={{
                      ...styles.toggleThumb,
                      transform: dangerousMode ? "translateX(12px)" : "translateX(0)",
                    }}
                  />
                </div>
                <span style={styles.toggleText}>Bypass permissions</span>
              </label>
            </div>
          </div>
        </div>
      {shellPanel?.visible && (
        <div style={{ height: `${shellHeight}%`, minHeight: 80, display: "flex", flexDirection: "column", zIndex: 2, flexShrink: 0 }}>
          <div style={styles.shellResizeHandle} onMouseDown={handleShellResize}>
            <div style={styles.shellResizeLine} />
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, borderTop: "1px solid var(--border)" }}>
            <Terminal cwd={rootPath} ptyId={shellPanel.ptyId} onFileOpen={handleFileOpen} />
          </div>
        </div>
      )}
      </div>
    );
  }

  // Active state: header + claude terminal
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
              stroke="var(--text-secondary)"
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
          {gitStatus && gitStatus.behind > 0 && branch !== mainBranch && (
            <button
              style={styles.syncBtn}
              onClick={handleSync}
              disabled={syncing}
              title={`Sync ${branch} with ${mainBranch} (${gitStatus.behind} behind)`}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                style={syncing ? { animation: "spin 1s linear infinite" } : undefined}
              >
                <path
                  d="M2.5 8a5.5 5.5 0 0 1 9.3-3.95L10 6h5V1l-1.8 1.8A7.5 7.5 0 0 0 .5 8h2zm11 0a5.5 5.5 0 0 1-9.3 3.95L6 10H1v5l1.8-1.8A7.5 7.5 0 0 0 15.5 8h-2z"
                  fill="var(--text-secondary)"
                />
              </svg>
            </button>
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
      <div style={styles.terminalArea}>
        <ClaudeTerminalWrapper
          key={ptyId ?? "fresh"}
          cwd={rootPath}
          command={ptyId ? undefined : `claude${claudeFlags} '${prompt.replace(/'/g, "'\\''")}'`}
          ptyId={ptyId}
          onPtySpawned={handlePtySpawned}
          onFileOpen={handleFileOpen}
        />
      </div>
    </div>
    {shellPanel?.visible && (
      <div style={{ height: `${shellHeight}%`, minHeight: 80, display: "flex", flexDirection: "column", zIndex: 2, flexShrink: 0 }}>
        <div style={styles.shellResizeHandle} onMouseDown={handleShellResize}>
          <div style={styles.shellResizeLine} />
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, borderTop: "1px solid var(--border)" }}>
          <Terminal cwd={rootPath} ptyId={shellPanel.ptyId} onFileOpen={handleFileOpen} />
        </div>
      </div>
    )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  idleContainer: {
    position: "absolute",
    inset: 0,
    background: "var(--bg-app)",
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
    color: "var(--text-primary)",
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
    background: "var(--frosted-bg)",
    backdropFilter: "blur(20px) saturate(150%)",
    border: "1px solid var(--border-subtle)",
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
    color: "var(--text-primary)",
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
    bottom: 6,
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
    gap: 6,
    padding: "7px 16px",
    borderTop: "1px solid var(--border-subtle)",
  },
  infoText: {
    fontSize: 12,
    color: "var(--text-secondary)",
    fontWeight: 400,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },

  // Toggle
  toggleLabel: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    cursor: "pointer",
    marginLeft: "auto",
  },
  toggleTrack: {
    width: 26,
    height: 14,
    borderRadius: 7,
    position: "relative" as const,
    cursor: "pointer",
    transition: "background 0.15s ease",
    flexShrink: 0,
  },
  toggleThumb: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    background: "var(--text-primary)",
    position: "absolute" as const,
    top: 2,
    left: 2,
    transition: "transform 0.15s ease",
  },
  toggleText: {
    fontSize: 12,
    color: "var(--text-secondary)",
    fontWeight: 400,
    whiteSpace: "nowrap" as const,
    userSelect: "none" as const,
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
    background: "var(--bg-elevated)",
    borderBottom: "1px solid var(--border)",
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
    color: "var(--text-secondary)",
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
    color: "var(--text-secondary)",
    fontWeight: 400,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  syncBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: 2,
    borderRadius: 3,
    flexShrink: 0,
    opacity: 0.7,
    transition: "opacity 0.15s ease",
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
    borderRadius: 3,
    fontSize: 12,
    color: "var(--text-dim)",
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
    color: "var(--text-secondary)",
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
    background: "var(--bg-elevated)",
  },
  shellResizeLine: {
    width: 32,
    height: 2,
    borderRadius: 1,
    background: "rgba(255,255,255,0.15)",
  },
};
