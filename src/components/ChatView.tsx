import React, { useState, useEffect, useRef, useCallback } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { api } from "../lib/tauri";
import { marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js";
import DOMPurify from "dompurify";
import type {
  ChatMessage,
  ChatContentBlock,
  PermissionRequest,
} from "../lib/types";

// ---------------------------------------------------------------------------
// Markdown rendering setup
// ---------------------------------------------------------------------------

marked.use(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  })
);

function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
}

// ---------------------------------------------------------------------------
// Tool‑use summary helper
// ---------------------------------------------------------------------------

function toolSummary(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  switch (name) {
    case "Write":
    case "Read":
    case "Edit":
      return String(obj.file_path ?? obj.filePath ?? "");
    case "Bash":
      return typeof obj.command === "string"
        ? obj.command.slice(0, 60)
        : "";
    case "Glob":
      return String(obj.pattern ?? "");
    case "Grep":
      return String(obj.pattern ?? "");
    case "Task":
    case "TaskCreate":
      return String(obj.description ?? obj.subject ?? "");
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// Sub‑components
// ---------------------------------------------------------------------------

function ThinkingBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={styles.thinkingBlock}>
      <button
        style={styles.collapsibleHeader}
        onClick={() => setExpanded((p) => !p)}
      >
        <span style={styles.chevron}>{expanded ? "▾" : "▸"}</span>
        <span style={styles.thinkingLabel}>Thinking</span>
        {!expanded && (
          <span style={styles.thinkingDots}>
            <span style={{ ...styles.dot, animationDelay: "0s" }}>•</span>
            <span style={{ ...styles.dot, animationDelay: "0.15s" }}>•</span>
            <span style={{ ...styles.dot, animationDelay: "0.3s" }}>•</span>
          </span>
        )}
      </button>
      {expanded && (
        <div style={styles.thinkingBody}>
          <div
            className="chat-markdown"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
          />
        </div>
      )}
    </div>
  );
}

function ToolUseBlock({
  name,
  input,
}: {
  name: string;
  input: unknown;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = toolSummary(name, input);

  return (
    <div style={styles.toolUseBlock}>
      <button
        style={styles.collapsibleHeader}
        onClick={() => setExpanded((p) => !p)}
      >
        <span style={styles.chevron}>{expanded ? "▾" : "▸"}</span>
        <span style={styles.toolName}>{name}</span>
        {summary && <span style={styles.toolSummary}>{summary}</span>}
      </button>
      {expanded && (
        <pre style={styles.toolInputPre}>
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ToolResultBlock({
  content,
  isError,
}: {
  content: string;
  isError?: boolean;
}) {
  const long = content.length > 200;
  const [expanded, setExpanded] = useState(!long);

  return (
    <div
      style={{
        ...styles.toolResultBlock,
        borderLeftColor: isError ? "#c44" : "#444",
      }}
    >
      {long && (
        <button
          style={styles.collapsibleHeader}
          onClick={() => setExpanded((p) => !p)}
        >
          <span style={styles.chevron}>{expanded ? "▾" : "▸"}</span>
          <span style={styles.toolResultLabel}>
            {isError ? "Error output" : "Result"}
          </span>
        </button>
      )}
      {expanded && (
        <pre style={styles.toolResultPre}>{content}</pre>
      )}
      {!expanded && (
        <pre style={styles.toolResultPre}>
          {content.slice(0, 200)}…
        </pre>
      )}
    </div>
  );
}

function ContentBlockView({ block }: { block: ChatContentBlock }) {
  switch (block.type) {
    case "text":
      return (
        <div
          className="chat-markdown"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(block.text) }}
        />
      );
    case "tool_use":
      return <ToolUseBlock name={block.name} input={block.input} />;
    case "tool_result":
      return (
        <ToolResultBlock
          content={block.content}
          isError={block.is_error}
        />
      );
    case "thinking":
      return <ThinkingBlock text={block.text} />;
    default:
      return null;
  }
}

function MessageRow({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";

  // User messages that only contain tool_result blocks are inline system data,
  // not things typed by the user — render them left-aligned without the user bubble.
  const isToolResultOnly =
    isUser &&
    message.content.length > 0 &&
    message.content.every((b) => b.type === "tool_result");

  if (isUser && !isToolResultOnly) {
    // Render user‑typed text blocks right-aligned
    const textBlocks = message.content.filter((b) => b.type === "text");
    if (textBlocks.length === 0) return null;
    return (
      <div style={styles.userRow}>
        <div style={styles.userBubble}>
          {textBlocks.map((b, i) => (
              <div key={i} style={styles.userText}>
                {b.text}
              </div>
          ))}
        </div>
      </div>
    );
  }

  // Assistant messages or tool-result-only user messages
  return (
    <div style={styles.assistantRow}>
      {message.content.map((block, i) => (
        <ContentBlockView key={i} block={block} />
      ))}
    </div>
  );
}

function PermissionPrompt({
  permission,
  onRespond,
}: {
  permission: PermissionRequest;
  onRespond: (decision: "allow" | "deny") => void;
}) {
  return (
    <div style={styles.permissionCard}>
      <div style={styles.permissionHeader}>
        <span style={styles.permissionTitle}>Permission required</span>
      </div>
      <div style={styles.permissionBody}>
        <span style={styles.permissionToolName}>{permission.tool_name}</span>
        <pre style={styles.permissionInput}>
          {JSON.stringify(permission.tool_input, null, 2)}
        </pre>
      </div>
      <div style={styles.permissionActions}>
        <button
          style={styles.permissionBtnAllow}
          onClick={() => onRespond("allow")}
        >
          Allow
        </button>
        <button
          style={styles.permissionBtnDeny}
          onClick={() => onRespond("deny")}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatView — main exported component
// ---------------------------------------------------------------------------

interface ChatViewProps {
  workspaceId: string;
}

export function ChatView({ workspaceId }: ChatViewProps) {
  const chatSession = useWorkspaceStore((s) => s.chatSessions[workspaceId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [followUpText, setFollowUpText] = useState("");
  const followUpRef = useRef<HTMLTextAreaElement>(null);

  // Auto‑resize the follow-up textarea
  const autoResize = useCallback(() => {
    const el = followUpRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, []);

  // Event listener is registered in the store's startChatSession()
  // to avoid race conditions with fast sidecar responses.

  // ---- Auto-scroll ----

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [
    chatSession?.messages.length,
    chatSession?.streamingText,
    chatSession?.pendingPermission,
  ]);

  // ---- Permission response ----

  const handlePermissionResponse = useCallback(
    async (decision: "allow" | "deny") => {
      if (!chatSession?.pendingPermission || !chatSession.sessionId) return;
      try {
        await api.respondToPermission(
          chatSession.sessionId,
          chatSession.pendingPermission.request_id,
          decision
        );
      } catch (e) {
        console.error("Failed to respond to permission:", e);
      }
    },
    [chatSession?.sessionId, chatSession?.pendingPermission]
  );

  // ---- Follow-up submit ----

  const handleFollowUp = useCallback(async () => {
    const trimmed = followUpText.trim();
    if (!trimmed || !chatSession?.sessionId) return;
    setFollowUpText("");
    try {
      await api.sendChatMessage(chatSession.sessionId, trimmed);
    } catch (e) {
      console.error("Failed to send follow-up:", e);
    }
  }, [followUpText, chatSession?.sessionId]);

  const handleFollowUpKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleFollowUp();
      }
    },
    [handleFollowUp]
  );

  // ---- Destructure session state with defaults ----

  const messages = chatSession?.messages ?? [];
  const streamingText = chatSession?.streamingText ?? "";
  const status = chatSession?.status ?? "idle";
  const pendingPermission = chatSession?.pendingPermission ?? null;
  const costUsd = chatSession?.costUsd ?? 0;

  // If no session at all, show nothing
  if (!chatSession) {
    return <div style={styles.emptyContainer} />;
  }

  return (
    <div style={styles.container}>
      {/* Scrollable message area */}
      <div ref={scrollRef} style={styles.messageArea}>
        {messages.map((msg) => (
          <MessageRow key={msg.id} message={msg} />
        ))}

        {/* Streaming text with blinking cursor */}
        {streamingText && (
          <div style={styles.assistantRow}>
            <div
              className="chat-markdown"
              dangerouslySetInnerHTML={{
                __html: renderMarkdown(streamingText),
              }}
            />
            <span style={styles.streamingCursor}>▎</span>
          </div>
        )}

        {/* Active streaming indicator (no text yet) */}
        {status === "streaming" && !streamingText && messages.length > 0 && (
          <div style={styles.assistantRow}>
            <span style={styles.thinkingDots}>
              <span style={{ ...styles.dot, animationDelay: "0s" }}>•</span>
              <span style={{ ...styles.dot, animationDelay: "0.15s" }}>•</span>
              <span style={{ ...styles.dot, animationDelay: "0.3s" }}>•</span>
            </span>
          </div>
        )}

        {/* Permission prompt */}
        {pendingPermission && status === "waiting_permission" && (
          <PermissionPrompt
            permission={pendingPermission}
            onRespond={handlePermissionResponse}
          />
        )}

        {/* Completion info */}
        {status === "complete" && costUsd > 0 && (
          <div style={styles.costRow}>
            Cost: ${costUsd.toFixed(4)}
            {chatSession.numTurns > 0 &&
              ` · ${chatSession.numTurns} turn${chatSession.numTurns !== 1 ? "s" : ""}`}
          </div>
        )}

        {/* Error message */}
        {status === "error" && chatSession.errorMessage && (
          <div style={styles.errorRow}>{chatSession.errorMessage}</div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Follow-up input (visible when session is complete) */}
      {status === "complete" && (
        <div style={styles.followUpBar}>
          <textarea
            ref={(el) => {
              (
                followUpRef as React.MutableRefObject<HTMLTextAreaElement | null>
              ).current = el;
              if (el) {
                el.style.height = "auto";
                el.style.height = el.scrollHeight + "px";
              }
            }}
            value={followUpText}
            onChange={(e) => {
              setFollowUpText(e.target.value);
              requestAnimationFrame(autoResize);
            }}
            onKeyDown={handleFollowUpKeyDown}
            placeholder="Send a follow-up…"
            style={styles.followUpInput}
            rows={1}
            autoFocus
          />
          <button
            style={{
              ...styles.followUpSendBtn,
              opacity: followUpText.trim() ? 1 : 0.3,
            }}
            onClick={handleFollowUp}
            disabled={!followUpText.trim()}
            title="Send"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M8 12V4M5 5l3-3 3 3"
                stroke="#ddd"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    background: "#1b1b1b",
  },
  emptyContainer: {
    flex: 1,
    background: "#1b1b1b",
  },
  messageArea: {
    flex: 1,
    overflowY: "auto",
    padding: "16px 20px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },

  // User message
  userRow: {
    display: "flex",
    justifyContent: "flex-end",
    marginBottom: 4,
  },
  userBubble: {
    maxWidth: "80%",
    background: "rgba(255,255,255,0.08)",
    borderRadius: 12,
    padding: "8px 14px",
  },
  userText: {
    fontSize: 14,
    color: "#e0e0e0",
    lineHeight: 1.5,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
  },

  // Assistant message
  assistantRow: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    maxWidth: "100%",
    marginBottom: 4,
  },

  // Streaming cursor
  streamingCursor: {
    display: "inline",
    color: "#e0e0e0",
    animation: "blink 1s step-end infinite",
    fontSize: 16,
    lineHeight: 1,
    verticalAlign: "text-bottom",
  },

  // Thinking block
  thinkingBlock: {
    borderLeft: "2px solid #555",
    paddingLeft: 10,
    margin: "4px 0",
  },
  thinkingLabel: {
    fontSize: 12,
    color: "#bbb",
    fontWeight: 500,
    fontStyle: "italic",
  },
  thinkingBody: {
    paddingTop: 4,
    color: "#bbb",
    fontSize: 13,
  },
  thinkingDots: {
    display: "inline-flex",
    gap: 3,
    marginLeft: 4,
  },
  dot: {
    fontSize: 16,
    color: "#e0e0e0",
    animation: "pulse 1.4s ease-in-out infinite",
  },

  // Collapsible headers
  collapsibleHeader: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: "2px 0",
    color: "#e0e0e0",
    fontSize: 13,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    textAlign: "left" as const,
    width: "100%",
  },
  chevron: {
    fontSize: 10,
    color: "#bbb",
    width: 10,
    flexShrink: 0,
  },

  // Tool use
  toolUseBlock: {
    background: "rgba(255,255,255,0.03)",
    border: "1px solid #333",
    borderRadius: 6,
    padding: "4px 8px",
    margin: "2px 0",
  },
  toolName: {
    fontFamily: "SF Mono, Menlo, Consolas, monospace",
    fontWeight: 600,
    fontSize: 12,
    color: "#e0e0e0",
  },
  toolSummary: {
    fontFamily: "SF Mono, Menlo, Consolas, monospace",
    fontSize: 12,
    color: "#bbb",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    flex: 1,
    minWidth: 0,
  },
  toolInputPre: {
    fontSize: 12,
    fontFamily: "SF Mono, Menlo, Consolas, monospace",
    color: "#ccc",
    background: "rgba(0,0,0,0.3)",
    borderRadius: 4,
    padding: 8,
    margin: "4px 0 2px",
    overflowX: "auto" as const,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-all" as const,
    maxHeight: 300,
    overflowY: "auto" as const,
  },

  // Tool result
  toolResultBlock: {
    borderLeft: "3px solid #444",
    paddingLeft: 10,
    margin: "2px 0",
  },
  toolResultLabel: {
    fontSize: 12,
    color: "#bbb",
  },
  toolResultPre: {
    fontSize: 12,
    fontFamily: "SF Mono, Menlo, Consolas, monospace",
    color: "#ccc",
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-all" as const,
    margin: "2px 0",
    maxHeight: 300,
    overflowY: "auto" as const,
  },

  // Permission prompt — frosted glass
  permissionCard: {
    background: "rgba(40, 40, 40, 0.85)",
    backdropFilter: "blur(20px) saturate(150%)",
    WebkitBackdropFilter: "blur(20px) saturate(150%)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 10,
    padding: 14,
    margin: "8px 0",
  },
  permissionHeader: {
    marginBottom: 8,
  },
  permissionTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "#fff",
  },
  permissionBody: {
    marginBottom: 10,
  },
  permissionToolName: {
    fontFamily: "SF Mono, Menlo, Consolas, monospace",
    fontSize: 13,
    fontWeight: 600,
    color: "#e0e0e0",
    display: "block",
    marginBottom: 6,
  },
  permissionInput: {
    fontSize: 12,
    fontFamily: "SF Mono, Menlo, Consolas, monospace",
    color: "#ccc",
    background: "rgba(0,0,0,0.3)",
    borderRadius: 4,
    padding: 8,
    overflowX: "auto" as const,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-all" as const,
    maxHeight: 200,
    overflowY: "auto" as const,
    margin: 0,
  },
  permissionActions: {
    display: "flex",
    gap: 8,
  },
  permissionBtnAllow: {
    padding: "5px 16px",
    borderRadius: 6,
    border: "1px solid rgba(255,255,255,0.15)",
    background: "rgba(255,255,255,0.1)",
    color: "#e0e0e0",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  permissionBtnDeny: {
    padding: "5px 16px",
    borderRadius: 6,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "transparent",
    color: "#bbb",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },

  // Cost row
  costRow: {
    fontSize: 12,
    color: "#bbb",
    textAlign: "center" as const,
    padding: "8px 0",
    borderTop: "1px solid #333",
    marginTop: 8,
  },

  // Error row
  errorRow: {
    fontSize: 13,
    color: "#e88",
    padding: "8px 10px",
    background: "rgba(200,60,60,0.1)",
    borderRadius: 6,
    marginTop: 4,
  },

  // Follow-up input bar
  followUpBar: {
    display: "flex",
    alignItems: "center",
    padding: "8px 16px",
    borderTop: "1px solid #333",
    background: "#1e1e1e",
    gap: 8,
    flexShrink: 0,
  },
  followUpInput: {
    flex: 1,
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 8,
    padding: "8px 12px",
    fontSize: 13,
    color: "#e0e0e0",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    outline: "none",
    resize: "none",
    lineHeight: 1.4,
    maxHeight: 120,
    overflowY: "auto",
  },
  followUpSendBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 30,
    height: 30,
    borderRadius: 8,
    border: "none",
    background: "rgba(255,255,255,0.1)",
    cursor: "pointer",
    flexShrink: 0,
    padding: 0,
  },
};
