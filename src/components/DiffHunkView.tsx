import React, { useMemo } from "react";
import type { DiffHunk, DiffLine } from "../lib/diffParser";
import { highlightLine, getLangForPath } from "../lib/syntaxHighlight";

// --- Display segment types ---

type DisplaySegment =
  | { type: "unmodified"; lineCount: number; position: "top" | "middle" | "bottom" }
  | { type: "change-group"; lines: DiffLine[]; hunkIndex: number }
  | { type: "context"; lines: DiffLine[] };

/** Build display segments from a list of hunks. */
function buildSegments(hunks: DiffHunk[], totalOldLines?: number): DisplaySegment[] {
  if (hunks.length === 0) return [];

  const segments: DisplaySegment[] = [];

  for (let hi = 0; hi < hunks.length; hi++) {
    const hunk = hunks[hi];
    const prevHunk = hi > 0 ? hunks[hi - 1] : null;

    // Compute unmodified gap before this hunk
    if (hi === 0 && hunk.oldStart > 1) {
      // Gap before first hunk: lines 1..(oldStart - 1) minus the leading context
      const contextCount = hunk.lines.findIndex((l) => l.type !== "context");
      const leadingContext = contextCount === -1 ? hunk.lines.length : contextCount;
      const gap = hunk.oldStart - 1 - leadingContext;
      if (gap > 0) {
        segments.push({ type: "unmodified", lineCount: gap, position: "top" });
      }
    } else if (prevHunk) {
      // Gap between hunks
      const prevEnd = computeHunkOldEnd(prevHunk);
      // Leading context of current hunk
      const contextCount = hunk.lines.findIndex((l) => l.type !== "context");
      const leadingContext = contextCount === -1 ? hunk.lines.length : contextCount;
      const gap = hunk.oldStart - prevEnd - leadingContext;
      if (gap > 0) {
        segments.push({ type: "unmodified", lineCount: gap, position: "middle" });
      }
    }

    // Process lines within the hunk into context + change-group segments
    let i = 0;
    const lines = hunk.lines;
    while (i < lines.length) {
      if (lines[i].type === "context") {
        // Collect consecutive context lines
        const start = i;
        while (i < lines.length && lines[i].type === "context") i++;
        segments.push({ type: "context", lines: lines.slice(start, i) });
      } else {
        // Collect consecutive add/delete lines as a change group
        const start = i;
        while (i < lines.length && lines[i].type !== "context") i++;
        segments.push({ type: "change-group", lines: lines.slice(start, i), hunkIndex: hi });
      }
    }
  }

  // Gap after last hunk
  if (totalOldLines !== undefined && hunks.length > 0) {
    const lastHunk = hunks[hunks.length - 1];
    const lastEnd = computeHunkOldEnd(lastHunk);
    // Trailing context of last hunk
    let trailingContext = 0;
    for (let i = lastHunk.lines.length - 1; i >= 0; i--) {
      if (lastHunk.lines[i].type === "context") trailingContext++;
      else break;
    }
    const gap = totalOldLines - lastEnd + 1 - trailingContext;
    if (gap > 0) {
      segments.push({ type: "unmodified", lineCount: gap, position: "bottom" });
    }
  }

  return segments;
}

function computeHunkOldEnd(hunk: DiffHunk): number {
  let count = 0;
  for (const line of hunk.lines) {
    if (line.type === "context" || line.type === "delete") count++;
  }
  return hunk.oldStart + count;
}

// --- Components ---

interface DiffFileViewProps {
  hunks: DiffHunk[];
  filePath: string;
  tab: "unstaged" | "staged" | "pr";
}

export function DiffFileView({
  hunks,
  filePath,
  tab,
}: DiffFileViewProps) {
  const lang = useMemo(() => getLangForPath(filePath), [filePath]);
  const segments = useMemo(() => buildSegments(hunks), [hunks]);

  if (segments.length === 0) return null;

  return (
    <div style={styles.container}>
      {segments.map((seg, i) => {
        if (seg.type === "unmodified") {
          return (
            <UnmodifiedBar
              key={`unmod-${i}`}
              lineCount={seg.lineCount}
              position={seg.position}
            />
          );
        }
        if (seg.type === "change-group") {
          return (
            <ChangeGroup
              key={`cg-${i}`}
              lines={seg.lines}
              lang={lang}
            />
          );
        }
        // context
        return (
          <ContextLines key={`ctx-${i}`} lines={seg.lines} lang={lang} />
        );
      })}
    </div>
  );
}

function UnmodifiedBar({
  lineCount,
  position,
}: {
  lineCount: number;
  position: "top" | "middle" | "bottom";
}) {
  return (
    <div style={styles.unmodifiedBar}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, opacity: 0.5 }}>
        {position === "top" ? (
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        ) : position === "bottom" ? (
          <path d="M4 10l4-4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <>
            <path d="M4 5l4-3 4 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 11l4 3 4-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </>
        )}
      </svg>
      <span>{lineCount} unmodified line{lineCount !== 1 ? "s" : ""}</span>
    </div>
  );
}

function ChangeGroup({
  lines,
  lang,
}: {
  lines: DiffLine[];
  lang: string | null;
}) {
  return (
    <div style={styles.changeGroup}>
      {lines.map((line, i) => (
        <DiffLineRow key={i} line={line} lang={lang} />
      ))}
    </div>
  );
}

function ContextLines({
  lines,
  lang,
}: {
  lines: DiffLine[];
  lang: string | null;
}) {
  return (
    <>
      {lines.map((line, i) => (
        <DiffLineRow key={i} line={line} lang={lang} />
      ))}
    </>
  );
}

function DiffLineRow({
  line,
  lang,
}: {
  line: DiffLine;
  lang: string | null;
}) {
  const bg =
    line.type === "add"
      ? "rgba(63, 185, 80, 0.12)"
      : line.type === "delete"
        ? "rgba(248, 81, 73, 0.12)"
        : "transparent";
  const lineNum =
    line.type === "add"
      ? line.newLineNumber
      : line.oldLineNumber;
  const barColor =
    line.type === "add"
      ? "rgba(63, 185, 80, 0.55)"
      : line.type === "delete"
        ? "rgba(248, 81, 73, 0.55)"
        : "transparent";

  return (
    <div style={{ ...styles.line, background: bg }}>
      <span style={{ ...styles.bar, background: barColor }} />
      <span style={styles.lineNum}>{lineNum ?? ""}</span>
      <span
        style={styles.lineContent}
        dangerouslySetInnerHTML={{
          __html: highlightLine(line.content, lang),
        }}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
    fontSize: 12,
    lineHeight: "20px",
  },
  unmodifiedBar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "4px 12px",
    background: "#1a1a1a",
    color: "#6e7681",
    fontSize: 12,
    userSelect: "none",
  },
  changeGroup: {
    position: "relative",
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
  bar: {
    width: 4,
    minWidth: 4,
    flexShrink: 0,
    alignSelf: "stretch",
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
