/**
 * Terminal-derived activity signals, keyed by PTY id.
 *
 * Fed from raw PTY output (every chunk that reaches `appendPtyBuffer`, so it
 * keeps working while a pod is hidden) and from user keystrokes. These are
 * fallbacks and hints — the authoritative "busy / waiting / idle" for a
 * Claude session comes from `~/.claude/sessions/<pid>.json` via
 * `agentStore`. Never treat quiet output as a finished task.
 *
 * Signals:
 *  - OSC 0/2 window title. Claude Code sets `"<prefix> <topic>"` where the
 *    prefix is `✳` at rest and a braille spinner (`⠂`/`⠐`) while a turn is
 *    running. The topic is a short auto-generated task title — a good
 *    default description when the user typed nothing.
 *  - Standalone BEL (0x07 outside an OSC sequence). Claude Code rings it
 *    when it needs attention and the notification channel is the terminal.
 *  - Last user input time, so a bell can be cleared once the user responds.
 */

export interface TerminalTitle {
  /** Title text without the Claude Code prefix glyph. */
  title: string;
  /** `busy` when the prefix was a spinner frame, `idle` for `✳`, `none` when
   *  the title did not come from Claude Code. */
  claude: "busy" | "idle" | "none";
  at: number;
}

export const ptyTerminalTitles = new Map<string, TerminalTitle>();
export const ptyBellAt = new Map<string, number>();
export const ptyLastInputAt = new Map<string, number>();

const CLAUDE_BUSY_PREFIXES = new Set(["⠂", "⠐"]);
const CLAUDE_IDLE_PREFIX = "✳";

/** Parse a raw title into a TerminalTitle. Exported for tests. */
export function classifyTitle(raw: string, at: number): TerminalTitle {
  const trimmed = raw.trim();
  const space = trimmed.indexOf(" ");
  if (space > 0) {
    const prefix = trimmed.slice(0, space);
    const rest = trimmed.slice(space + 1).trim();
    if (CLAUDE_BUSY_PREFIXES.has(prefix)) return { title: rest, claude: "busy", at };
    if (prefix === CLAUDE_IDLE_PREFIX) return { title: rest, claude: "idle", at };
  }
  return { title: trimmed, claude: "none", at };
}

const ESC = 0x1b;
const BEL = 0x07;
const BACKSLASH = 0x5c;
const RBRACKET = 0x5d;
const MAX_OSC = 512;

interface ScanState {
  /** 0 = text, 1 = saw ESC, 2 = inside OSC, 3 = OSC saw ESC (maybe ST) */
  mode: 0 | 1 | 2 | 3;
  osc: number[];
}

const scanners = new Map<string, ScanState>();
const decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * Scan one output chunk for titles and bells. Stateful per PTY so OSC
 * sequences split across chunk boundaries still parse.
 */
export function observePtyOutput(ptyId: string, chunk: Uint8Array, now: number = Date.now()): void {
  let st = scanners.get(ptyId);
  if (!st) {
    st = { mode: 0, osc: [] };
    scanners.set(ptyId, st);
  }
  for (let i = 0; i < chunk.length; i++) {
    const b = chunk[i];
    switch (st.mode) {
      case 0:
        if (b === ESC) st.mode = 1;
        else if (b === BEL) ptyBellAt.set(ptyId, now);
        break;
      case 1:
        if (b === RBRACKET) {
          st.mode = 2;
          st.osc = [];
        } else {
          st.mode = 0;
          // An ESC followed by BEL is not a bell we care about; ignore.
        }
        break;
      case 2:
        if (b === BEL) {
          finishOsc(ptyId, st, now);
        } else if (b === ESC) {
          st.mode = 3;
        } else {
          if (st.osc.length < MAX_OSC) st.osc.push(b);
          else {
            // Runaway sequence (binary noise) — abandon it.
            st.mode = 0;
            st.osc = [];
          }
        }
        break;
      case 3:
        if (b === BACKSLASH) {
          finishOsc(ptyId, st, now);
        } else {
          // ESC inside OSC that isn't ST — treat as a new escape.
          st.mode = b === RBRACKET ? 2 : 0;
          st.osc = [];
        }
        break;
    }
  }
}

function finishOsc(ptyId: string, st: ScanState, now: number): void {
  const body = decoder.decode(new Uint8Array(st.osc));
  st.mode = 0;
  st.osc = [];
  const semi = body.indexOf(";");
  if (semi < 0) return;
  const code = body.slice(0, semi);
  if (code !== "0" && code !== "2") return;
  const title = body.slice(semi + 1);
  if (!title.trim()) return;
  ptyTerminalTitles.set(ptyId, classifyTitle(title, now));
}

export function markPtyInput(ptyId: string, now: number = Date.now()): void {
  ptyLastInputAt.set(ptyId, now);
}

export function clearPtyActivity(ptyId: string): void {
  ptyTerminalTitles.delete(ptyId);
  ptyBellAt.delete(ptyId);
  ptyLastInputAt.delete(ptyId);
  scanners.delete(ptyId);
}

/** True when a bell rang after the user last typed into this PTY. */
export function hasUnansweredBell(ptyId: string): boolean {
  const bell = ptyBellAt.get(ptyId);
  if (bell === undefined) return false;
  const input = ptyLastInputAt.get(ptyId) ?? 0;
  return bell > input;
}
