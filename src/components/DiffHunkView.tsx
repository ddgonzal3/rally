import React, { useMemo } from "react";
import type { DiffHunk } from "../lib/diffParser";
import { highlightLine, getLangForPath } from "../lib/syntaxHighlight";

export function DiffHunkView({
  hunk,
  filePath,
}: {
  hunk: DiffHunk;
  filePath: string;
}) {
  const lang = useMemo(() => getLangForPath(filePath), [filePath]);

  return (
    <div style={styles.hunk}>
      <div style={styles.hunkHeader}>{hunk.header}</div>
      {hunk.lines.map((line, i) => {
        const bg =
          line.type === "add"
            ? "rgba(63, 185, 80, 0.12)"
            : line.type === "delete"
              ? "rgba(248, 81, 73, 0.12)"
              : "transparent";
        const lineNum =
          line.type === "add"
            ? line.newLineNumber
            : line.type === "delete"
              ? line.oldLineNumber
              : line.oldLineNumber;
        const marker =
          line.type === "add" ? "+" : line.type === "delete" ? "-" : " ";
        const markerColor =
          line.type === "add"
            ? "#3fb950"
            : line.type === "delete"
              ? "#f85149"
              : "#888";

        return (
          <div key={i} style={{ ...styles.line, background: bg }}>
            <span style={styles.lineNum}>{lineNum ?? ""}</span>
            <span style={{ ...styles.marker, color: markerColor }}>
              {marker}
            </span>
            <span
              style={styles.lineContent}
              dangerouslySetInnerHTML={{
                __html: highlightLine(line.content, lang),
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  hunk: {
    fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
    fontSize: 12,
    lineHeight: "20px",
    borderRadius: 6,
    overflow: "hidden",
    border: "1px solid #2a2a2a",
    marginTop: 4,
    marginBottom: 8,
  },
  hunkHeader: {
    padding: "4px 12px",
    background: "#1e2a3a",
    color: "#8b949e",
    fontSize: 11,
    borderBottom: "1px solid #2a2a2a",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  line: {
    display: "flex",
    alignItems: "flex-start",
    minHeight: 20,
  },
  lineNum: {
    width: 44,
    minWidth: 44,
    textAlign: "right",
    paddingRight: 8,
    color: "#6e7681",
    userSelect: "none",
    flexShrink: 0,
  },
  marker: {
    width: 16,
    minWidth: 16,
    textAlign: "center",
    userSelect: "none",
    flexShrink: 0,
    fontWeight: 600,
  },
  lineContent: {
    flex: 1,
    minWidth: 0,
    paddingRight: 12,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    color: "#e6edf3",
  },
};
