import React from "react";

/** Expandable chevron for directory nodes. Rotates 90° when open. */
export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      style={{
        flexShrink: 0,
        color: "var(--text-dim)",
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.1s ease",
      }}
    >
      <path d="M6 4l4 4-4 4z" />
    </svg>
  );
}

// ─── Shared file type data ────────────────────────────────────

interface FileTypeInfo {
  label: string;
  color: string;
  /** If true, render at a slightly smaller font to fit 3+ char labels. */
  compact?: boolean;
}

function getFileTypeInfo(name: string): FileTypeInfo | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx"))
    return { label: "TS", color: "#3178C6" };
  if (lower.endsWith(".js") || lower.endsWith(".jsx"))
    return { label: "JS", color: "#F0DB4F" };
  if (lower.endsWith(".rs")) return { label: "RS", color: "#DEA584" };
  if (lower.endsWith(".py")) return { label: "PY", color: "#3572A5" };
  if (lower.endsWith(".go")) return { label: "GO", color: "#00ADD8" };
  if (lower.endsWith(".json")) return { label: "{ }", color: "#A8B065" };
  if (lower.endsWith(".md")) return { label: "M↓", color: "#519ABA" };
  if (lower.endsWith(".css") || lower.endsWith(".scss"))
    return { label: "CSS", color: "#56B6C2", compact: true };
  if (lower.endsWith(".html") || lower.endsWith(".htm"))
    return { label: "</>", color: "#E37933" };
  if (lower.endsWith(".yaml") || lower.endsWith(".yml"))
    return { label: "YML", color: "#CB171E", compact: true };
  if (lower.endsWith(".toml")) return { label: "TM", color: "#9B9B9B" };
  if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh"))
    return null; // handled by TerminalPromptIcon
  if (lower.endsWith(".c") || lower.endsWith(".h"))
    return { label: "C", color: "#A8B4CE" };
  if (
    lower.endsWith(".cpp") ||
    lower.endsWith(".cc") ||
    lower.endsWith(".cxx") ||
    lower.endsWith(".hpp")
  )
    return { label: "C+", color: "#F34B7D" };
  if (lower.endsWith(".swift")) return { label: "SW", color: "#F05138" };
  if (lower.endsWith(".rb")) return { label: "RB", color: "#CC342D" };
  if (lower.endsWith(".java")) return { label: "JA", color: "#B07219" };
  if (lower.endsWith(".kt") || lower.endsWith(".kts"))
    return { label: "KT", color: "#A97BFF" };
  if (lower.endsWith(".sql")) return { label: "SQ", color: "#e38c00" };
  if (lower === ".gitignore" || lower === ".dockerignore")
    return { label: "·I", color: "#6B6B6B" };
  if (lower.endsWith(".lock"))
    return { label: "LK", color: "#6B6B6B" };
  return null;
}

function getFileColor(name: string): string {
  const info = getFileTypeInfo(name);
  return info?.color ?? "var(--text-dim)";
}

// ─── Shared text-label icon (used for both tabs and file explorer) ──────

/** Renders a colored text label (e.g. "TS", "JS") as an icon. */
function FileTypeLabel({
  info,
  size,
}: {
  info: FileTypeInfo;
  size: number;
}) {
  const fontSize = info.compact ? size * 0.55 : size * 0.62;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        fontSize,
        fontWeight: 800,
        color: info.color,
        fontFamily: "system-ui, -apple-system, sans-serif",
        lineHeight: 1,
        flexShrink: 0,
        letterSpacing: info.compact ? -0.5 : 0,
      }}
    >
      {info.label}
    </span>
  );
}

// ─── File explorer icons (16×16) ──────────────────────────────

/** File/folder icon based on name and type — used in the file explorer. */
export function FileIcon({
  name,
  isDir,
  isOpen,
}: {
  name: string;
  isDir: boolean;
  isOpen?: boolean;
}) {
  if (isDir) return <FolderIcon open={isOpen} />;
  if (isScriptFile(name)) return <TerminalPromptIcon size={16} />;
  const info = getFileTypeInfo(name);
  if (info) return <FileTypeLabel info={info} size={16} />;
  return <DocumentIcon color="var(--text-dim)" />;
}

function FolderIcon({ open }: { open?: boolean }) {
  // Matches icons8 folder style: rounded rect with a small smooth tab
  const d = open
    ? "M3 4C3 3.17 3.67 2.5 4.5 2.5H8L9.5 4H12.5C13.33 4 14 4.67 14 5.5V6H4.5L3 12H12.5C13.33 12 14 11.33 14 10.5V6"
    : "M3 4C3 3.17 3.67 2.5 4.5 2.5H8L9.5 4H12.5C13.33 4 14 4.67 14 5.5V11C14 11.83 13.33 12.5 12.5 12.5H4.5C3.67 12.5 3 11.83 3 11Z";
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={svgIconStyle}>
      <path
        d={d}
        stroke="var(--text-dim)"
        strokeWidth="1.3"
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function isScriptFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh");
}

/** Terminal prompt icon (>_) for script files. Shared by file explorer, tabs, and TaskPanel. */
export function TerminalPromptIcon({ size, color = "#89E051" }: { size: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <path
        d="M3 4.5L7 8L3 11.5"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9 11.5H13"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DocumentIcon({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={svgIconStyle}>
      <path
        d="M4 1.5h5.5L13 5v9.5H4z"
        stroke={color}
        strokeWidth="1"
        fill="none"
        opacity={0.8}
      />
      <path d="M9.5 1.5V5H13" stroke={color} strokeWidth="1" opacity={0.8} />
    </svg>
  );
}

const svgIconStyle: React.CSSProperties = {
  flexShrink: 0,
};

// ─── Tab icons (14×14) ────────────────────────────────────────

/** Returns the appropriate tab icon for a given pane type and filename. */
export function PaneTabIcon({
  type,
  fileName,
  terminalTitle,
}: {
  type: string;
  fileName?: string;
  terminalTitle?: string;
}) {
  if (type === "claude" || type === "claude-launcher") return <ClaudeTabIcon />;
  if (type === "terminal") {
    if (terminalTitle) {
      const lower = terminalTitle.toLowerCase();
      if (lower === "claude" || lower.startsWith("claude "))
        return <ClaudeTabIcon />;
    }
    return <TerminalTabIcon />;
  }
  if (type === "diff") return <DiffTabIcon />;
  if (type === "editor" && fileName) {
    if (isScriptFile(fileName)) return <TerminalPromptIcon size={16} />;
    const info = getFileTypeInfo(fileName);
    if (info) return <FileTypeLabel info={info} size={16} />;
    return <SmallDocIcon color={getFileColor(fileName)} />;
  }
  return <SmallDocIcon color="var(--text-dim)" />;
}

export const CLAUDE_PATH =
  "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z";

function ClaudeTabIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="-2 -1 28 26"
      style={{ flexShrink: 0 }}
    >
      <path d={CLAUDE_PATH} fill="#D97757" fillRule="nonzero" />
    </svg>
  );
}

function TerminalTabIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 14 14" style={{ flexShrink: 0 }}>
      <path
        d="M2.5 3.5L6 7L2.5 10.5"
        stroke="#89E051"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M7.5 10.5H11.5"
        stroke="#89E051"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DiffTabIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 14 14" style={{ flexShrink: 0 }}>
      <rect
        x="1.5"
        y="2"
        width="4.5"
        height="10"
        rx="1"
        stroke="#5ba0d0"
        strokeWidth="1"
        fill="none"
        opacity={0.8}
      />
      <rect
        x="8"
        y="2"
        width="4.5"
        height="10"
        rx="1"
        stroke="#e8b930"
        strokeWidth="1"
        fill="none"
        opacity={0.8}
      />
    </svg>
  );
}

function SmallDocIcon({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 14 14" style={{ flexShrink: 0 }}>
      <path
        d="M3.5 1.5h4.5L11 4.5v8H3.5z"
        stroke={color}
        strokeWidth="0.9"
        fill="none"
        opacity={0.7}
      />
      <path
        d="M8 1.5v3h3"
        stroke={color}
        strokeWidth="0.9"
        fill="none"
        opacity={0.7}
      />
    </svg>
  );
}
