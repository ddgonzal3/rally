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
        color: "#888",
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.1s ease",
      }}
    >
      <path d="M6 4l4 4-4 4z" />
    </svg>
  );
}

/** File/folder icon based on name and type. */
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
  const color = getFileColor(name);
  return <DocumentIcon color={color} />;
}

function FolderIcon({ open }: { open?: boolean }) {
  if (open) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={iconStyle}>
        <path
          d="M1.5 3.5h4l1.5 1.5H14.5v1H2.5l-1 6h11l1.5-5H6L4.5 5.5H1.5z"
          fill="#C09553"
          opacity={0.85}
        />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={iconStyle}>
      <path
        d="M1.5 3h4.5l1.5 1.5h6v8.5h-12z"
        fill="#C09553"
        opacity={0.85}
      />
    </svg>
  );
}

function DocumentIcon({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={iconStyle}>
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

const iconStyle: React.CSSProperties = {
  flexShrink: 0,
};

function getFileColor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "#3178C6";
  if (lower.endsWith(".js") || lower.endsWith(".jsx")) return "#F0DB4F";
  if (lower.endsWith(".rs")) return "#DEA584";
  if (lower.endsWith(".c") || lower.endsWith(".h")) return "#A8B4CE";
  if (lower.endsWith(".cpp") || lower.endsWith(".cc") || lower.endsWith(".cxx") || lower.endsWith(".hpp") || lower.endsWith(".hh")) return "#F34B7D";
  if (lower.endsWith(".json")) return "#A8B065";
  if (lower.endsWith(".md")) return "#519ABA";
  if (lower.endsWith(".css") || lower.endsWith(".scss")) return "#56B6C2";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "#E37933";
  if (lower.endsWith(".toml")) return "#9B9B9B";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "#CB171E";
  if (lower.endsWith(".py")) return "#3572A5";
  if (lower.endsWith(".go")) return "#00ADD8";
  if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) return "#89E051";
  if (lower === ".gitignore" || lower === ".dockerignore") return "#6B6B6B";
  return "#888888";
}
