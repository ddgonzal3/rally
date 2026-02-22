export interface DiffFile {
  oldPath: string;
  newPath: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  isNew: boolean;
  isDeleted: boolean;
  isRenamed: boolean;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "add" | "delete" | "context";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

/**
 * Parse a unified diff string (output of `git diff`) into structured DiffFile objects.
 */
export function parseUnifiedDiff(raw: string): DiffFile[] {
  if (!raw.trim()) return [];

  const files: DiffFile[] = [];
  const fileSections = raw.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const lines = section.split("\n");
    const pathMatch = lines[0]?.match(/^a\/(.*?) b\/(.*)$/);
    if (!pathMatch) continue;

    const file: DiffFile = {
      oldPath: pathMatch[1],
      newPath: pathMatch[2],
      additions: 0,
      deletions: 0,
      hunks: [],
      isNew: false,
      isDeleted: false,
      isRenamed: pathMatch[1] !== pathMatch[2],
    };

    for (const line of lines.slice(1, 6)) {
      if (line.startsWith("new file")) file.isNew = true;
      if (line.startsWith("deleted file")) file.isDeleted = true;
    }

    let currentHunk: DiffHunk | null = null;
    let oldLine = 0;
    let newLine = 0;

    for (const line of lines) {
      const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      if (hunkMatch) {
        currentHunk = {
          header: line,
          oldStart: parseInt(hunkMatch[1], 10),
          newStart: parseInt(hunkMatch[2], 10),
          lines: [],
        };
        oldLine = currentHunk.oldStart;
        newLine = currentHunk.newStart;
        file.hunks.push(currentHunk);
        continue;
      }

      if (!currentHunk) continue;

      if (line.startsWith("+")) {
        currentHunk.lines.push({
          type: "add",
          content: line.slice(1),
          newLineNumber: newLine++,
        });
        file.additions++;
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({
          type: "delete",
          content: line.slice(1),
          oldLineNumber: oldLine++,
        });
        file.deletions++;
      } else if (line.startsWith(" ")) {
        currentHunk.lines.push({
          type: "context",
          content: line.slice(1),
          oldLineNumber: oldLine++,
          newLineNumber: newLine++,
        });
      }
    }

    files.push(file);
  }

  return files;
}
