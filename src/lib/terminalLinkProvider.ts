import type { Terminal, ILinkProvider, ILink, IBufferRange } from "@xterm/xterm";
import { api, openUrl } from "./tauri";

// --- Regex patterns ---

// Web URLs: match http(s)://... stopping at common delimiters
const URL_REGEX = /https?:\/\/[^\s'")\]}>]+/g;

// File paths: must contain at least one `/` and end with a file extension.
// Supports absolute, relative with prefix (./ ../), and implicit relative paths.
// Optional :line or :line:col suffix.
const FILE_PATH_REGEX = /(?:\.\.?\/|\/)[^\s'"()[\]{}<>,;!?`|]+?\.[a-zA-Z0-9]{1,10}(?::\d+(?::\d+)?)?/g;

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

    const text = line.translateToString(true);
    const matches = findLinksInText(text);
    if (matches.length === 0) {
      callback(undefined);
      return;
    }

    const links: ILink[] = matches.map((match) => {
      const range: IBufferRange = {
        start: { x: match.startIndex + 1, y: bufferLineNumber },
        end: { x: match.startIndex + match.text.length + 1, y: bufferLineNumber },
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

          if (match.kind === "url") {
            openUrl(linkText);
          } else {
            const { path, line: ln, col } = parseFilePath(linkText);
            const resolved = resolvePath(path, this.getCwd());
            api.fileExists(resolved).then((exists) => {
              if (exists) {
                this.onFileOpen(resolved, ln, col);
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
