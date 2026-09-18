import type { IDisposable, Terminal } from "@xterm/xterm";
import { api } from "./tauri";

/** Quiet period after the last selection change before the copy fires. Long
 *  enough to skip most mid-drag states, short enough to feel instant on mouseup. */
const SETTLE_MS = 50;

/**
 * Copy the terminal selection to the clipboard whenever it settles (macOS
 * Terminal-style copy on select). Goes through pbcopy: WKWebView rejects
 * navigator.clipboard.writeText() from a timer callback.
 */
export function installCopyOnSelect(term: Terminal): IDisposable {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastCopied = "";
  const sub = term.onSelectionChange(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const sel = term.getSelection();
      if (!sel || sel === lastCopied) return;
      lastCopied = sel;
      api.writeClipboardText(sel).catch(() => {
        /* clipboard unavailable */
      });
    }, SETTLE_MS);
  });
  return {
    dispose() {
      clearTimeout(timer);
      sub.dispose();
    },
  };
}
