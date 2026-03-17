import type { Terminal, ILinkProvider, ILink, IBufferRange } from "@xterm/xterm";
import { api, openUrl } from "./tauri";

// --- Regex patterns ---

// Web URLs: match http(s)://... stopping at common delimiters
const URL_REGEX = /https?:\/\/[^\s'")\]}>]+/g;

// File paths: supports absolute (/foo), relative with prefix (./foo, ../foo),
// implicit relative with slash (src/foo.ts), and bare filenames (foo.ts).
// Must end with a file extension. Optional :line or :line:col suffix.
// Also matches directory paths ending with /
const FILE_PATH_REGEX = /(?:\.\.?\/|\/|[a-zA-Z0-9_@.-]+\/)[^\s'"()[\]{}<>,;!?`|]+\.[a-zA-Z0-9]{1,10}(?::\d+(?::\d+)?)?/g;
// Directory paths: must start with a path prefix and end with /
const DIR_PATH_REGEX = /(?:\.\.?\/|\/|[a-zA-Z0-9_@.-]+\/)[^\s'"()[\]{}<>,;!?`|]*\//g;
const BARE_FILE_REGEX = /(?<![/\w.-])[a-zA-Z0-9_@.-]+\.[a-zA-Z0-9]{1,10}(?::\d+(?::\d+)?)?(?![/\w.-])/g;

interface LinkMatch {
  text: string;
  startIndex: number;
  kind: "url" | "file";
}

/** Find all link matches in a line of text. */
function findLinksInText(text: string): LinkMatch[] {
  const matches: LinkMatch[] = [];

  URL_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_REGEX.exec(text)) !== null) {
    // Strip trailing punctuation that's likely not part of the URL
    let url = m[0];
    while (url.length > 0 && /[.,;:!?)>}\]']$/.test(url)) {
      url = url.slice(0, -1);
    }
    if (url.length > 10) {
      matches.push({ text: url, startIndex: m.index, kind: "url" });
    }
  }

  FILE_PATH_REGEX.lastIndex = 0;
  while ((m = FILE_PATH_REGEX.exec(text)) !== null) {
    const matchText = m[0];
    const startIdx = m.index;

    // Skip if this range overlaps with a URL match
    const endIdx = startIdx + matchText.length;
    const overlapsUrl = matches.some(
      (um) => um.kind === "url" && startIdx < um.startIndex + um.text.length && endIdx > um.startIndex
    );
    if (overlapsUrl) continue;

    matches.push({ text: matchText, startIndex: startIdx, kind: "file" });
  }

  // Directory paths (ending with /) — matched separately so they don't
  // interfere with file path matching (greedy / would eat file extensions)
  DIR_PATH_REGEX.lastIndex = 0;
  while ((m = DIR_PATH_REGEX.exec(text)) !== null) {
    const matchText = m[0];
    const startIdx = m.index;
    const endIdx = startIdx + matchText.length;

    // Skip if overlaps with any existing match
    const overlaps = matches.some(
      (um) => startIdx < um.startIndex + um.text.length && endIdx > um.startIndex
    );
    if (overlaps) continue;

    matches.push({ text: matchText, startIndex: startIdx, kind: "file" });
  }

  // Bare filenames (e.g. "config.yaml:1") — no slash required
  BARE_FILE_REGEX.lastIndex = 0;
  while ((m = BARE_FILE_REGEX.exec(text)) !== null) {
    const matchText = m[0];
    const startIdx = m.index;
    const endIdx = startIdx + matchText.length;

    // Skip if overlaps with any existing match
    const overlaps = matches.some(
      (um) => startIdx < um.startIndex + um.text.length && endIdx > um.startIndex
    );
    if (overlaps) continue;

    matches.push({ text: matchText, startIndex: startIdx, kind: "file" });
  }

  return matches;
}

/** Parse a file path match, extracting the path and optional line:col suffix. */
function parseFilePath(text: string): { path: string; line?: number; col?: number } {
  const colonMatch = text.match(/^(.+?):(\d+)(?::(\d+))?$/);
  if (colonMatch) {
    return {
      path: colonMatch[1],
      line: parseInt(colonMatch[2], 10),
      col: colonMatch[3] ? parseInt(colonMatch[3], 10) : undefined,
    };
  }
  return { path: text };
}

/** Resolve a possibly-relative path against a CWD. */
function resolvePath(filePath: string, cwd: string): string {
  if (filePath.startsWith("/")) return filePath;

  // Join with CWD
  const base = cwd.endsWith("/") ? cwd : cwd + "/";
  let resolved = base + filePath;

  // Normalize: collapse /./  and resolve /../
  resolved = resolved.replace(/\/\.\//g, "/");
  // Resolve .. segments
  const parts = resolved.split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      normalized.pop();
    } else if (part !== ".") {
      normalized.push(part);
    }
  }
  return normalized.join("/");
}

export type OnFileOpen = (path: string, line?: number, col?: number) => void;

/** Custom event to request the file explorer to expand/reveal a folder path. */
export const EXPAND_FOLDER_EVENT = "rally:expand-folder";

/**
 * Custom link provider for xterm.js that handles both web URLs and file paths.
 * Decorations (underline + pointer cursor) only appear when Cmd is held.
 */
export class TerminalLinkProvider implements ILinkProvider {
  private _cmdHeld = false;
  private _activeLinks = new Set<ILink>();

  constructor(
    private terminal: Terminal,
    private getCwd: () => string,
    private onFileOpen: OnFileOpen,
  ) {}

  get cmdHeld(): boolean {
    return this._cmdHeld;
  }

  set cmdHeld(value: boolean) {
    if (this._cmdHeld === value) return;
    this._cmdHeld = value;
    // Update decorations on all active links
    for (const link of this._activeLinks) {
      if (link.decorations) {
        link.decorations.pointerCursor = value;
        link.decorations.underline = value;
      }
    }
  }

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    const buffer = this.terminal.buffer.active;
    const line = buffer.getLine(bufferLineNumber - 1);
    if (!line) {
      callback(undefined);
      return;
    }

    // Collect wrapped lines: join current line with any continuation lines below.
    // xterm marks continuation lines with isWrapped=true.
    const lineTexts: string[] = [];
    const lineWidths: number[] = [];
    const startLineIdx = bufferLineNumber - 1;

    lineTexts.push(line.translateToString(true));
    lineWidths.push(lineTexts[0].length);

    // Gather subsequent wrapped lines
    for (let i = startLineIdx + 1; i < buffer.length; i++) {
      const nextLine = buffer.getLine(i);
      if (!nextLine || !nextLine.isWrapped) break;
      const nextText = nextLine.translateToString(true);
      lineTexts.push(nextText);
      lineWidths.push(nextText.length);
    }

    const fullText = lineTexts.join("");
    const matches = findLinksInText(fullText);
    if (matches.length === 0) {
      callback(undefined);
      return;
    }

    // Helper: convert a character offset in the combined text to {line, col}
    function offsetToPosition(offset: number): { line: number; col: number } {
      let remaining = offset;
      for (let i = 0; i < lineWidths.length; i++) {
        if (remaining < lineWidths[i]) {
          return { line: bufferLineNumber + i, col: remaining + 1 };
        }
        remaining -= lineWidths[i];
      }
      // Past end — clamp to last line
      const lastIdx = lineWidths.length - 1;
      return { line: bufferLineNumber + lastIdx, col: lineWidths[lastIdx] + 1 };
    }

    const links: ILink[] = matches.map((match) => {
      const startPos = offsetToPosition(match.startIndex);
      const endPos = offsetToPosition(match.startIndex + match.text.length);
      const range: IBufferRange = {
        start: { x: startPos.col, y: startPos.line },
        end: { x: endPos.col, y: endPos.line },
      };

      const link: ILink = {
        range,
        text: match.text,
        decorations: {
          pointerCursor: this._cmdHeld,
          underline: this._cmdHeld,
        },
        activate: (_event: MouseEvent, linkText: string) => {
          // Only activate when Cmd is held. We use our own cmdHeld state
          // (tracked via keydown/keyup) instead of event.metaKey because
          // WebKit in Tauri's webview doesn't reliably set metaKey on
          // the mouseup event that xterm passes to activate().
          if (!this._cmdHeld) return;

          // Use the original match text, not xterm's linkText — xterm may
          // truncate it for wrapped links or modify whitespace.
          const fullText = match.text;
          console.log("[rally-link] activate:", { fullText, linkText, kind: match.kind, cmdHeld: this._cmdHeld, cwd: this.getCwd() });

          if (match.kind === "url") {
            openUrl(fullText);
          } else {
            const { path, line: ln, col } = parseFilePath(fullText);
            const resolved = resolvePath(path, this.getCwd());
            // Try the resolved path first; if it doesn't exist, try
            // with the raw text as-is (handles absolute paths and edge cases)
            api.pathStatus(resolved).then((status) => {
              console.log("[rally-link] pathStatus:", { resolved, path, status });
              if (status.exists) {
                if (status.is_dir) {
                  document.dispatchEvent(new CustomEvent(EXPAND_FOLDER_EVENT, {
                    detail: { path: resolved },
                  }));
                } else {
                  this.onFileOpen(resolved, ln, col);
                }
              } else {
                // Fallback: try the raw path without resolution
                api.pathStatus(path).then((s2) => {
                  if (s2.exists && !s2.is_dir) {
                    this.onFileOpen(path, ln, col);
                  }
                }).catch(() => {});
              }
            }).catch(() => {});
          }
        },
        dispose: () => {
          this._activeLinks.delete(link);
        },
      };

      this._activeLinks.add(link);
      return link;
    });

    callback(links);
  }
}
