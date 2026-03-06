import React, { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../lib/tauri";
import { TerminalLinkProvider, type OnFileOpen } from "../lib/terminalLinkProvider";
import { useWorkspaceStore, shipOutputBuffer, scriptOutputBuffers, appendPtyBuffer, clearPtyBuffer, ptyOutputBuffers } from "../stores/workspaceStore";
import { showContextMenu } from "../lib/contextMenu";
import type { ThemeName, DetectedPort } from "../lib/types";
import { detectPorts } from "../lib/portDetection";
import { getXtermTheme, getCssVar } from "../lib/xtermTheme";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  cwd: string;
  command?: string;
  initialInput?: string;
  ptyId?: string;  // Connect to existing PTY instead of spawning
  /** Lock columns to 80 — only for ship dock terminals where SIGWINCH
   *  col changes cause rich TUI garble. Regular terminals should NOT lock. */
  lockCols?: boolean;
  /** Key into scriptOutputBuffers to replay buffered output on attach */
  scriptBufferKey?: string;
  /** Workspace ID for port detection — detected localhost URLs are registered here */
  workspaceId?: string;
  /** Called after a new PTY is spawned — lets the parent persist the ptyId
   *  so it survives React remounts (layout restructuring). When provided,
   *  the Terminal will NOT kill the PTY on unmount — the store manages it. */
  onPtySpawned?: (ptyId: string) => void;
  /** Called when the shell reports its CWD via OSC 7 escape sequence */
  onCwdChanged?: (cwd: string) => void;
  /** Called when the terminal title changes (OSC 0/2 sequence) */
  onTitleChange?: (title: string) => void;
  /** Called when user Cmd+clicks a file path in terminal output */
  onFileOpen?: OnFileOpen;
  /** Called when user right-clicks → Kill Terminal. Lets the parent do
   *  proper cleanup (close pane, stop script, etc.) instead of just killing the PTY. */
  onKill?: () => void;
}

// OSC 7 format: \x1b]7;file://hostname/path\x07  (or \x1b\\ as terminator)
const OSC7_REGEX = /\x1b\]7;file:\/\/[^/]*(\/[^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
const OSC7_TAIL_MAX = 4096;
const CLAUDE_LOST_POLL_THRESHOLD = 3;

function parseLatestOsc7Cwd(text: string): string | null {
  OSC7_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null = null;
  let latestPath: string | null = null;
  while ((match = OSC7_REGEX.exec(text)) !== null) {
    latestPath = match[1];
  }
  if (!latestPath) return null;
  try {
    return decodeURIComponent(latestPath);
  } catch {
    return latestPath;
  }
}

function normalizeTerminalTitle(title: string | null | undefined): string {
  return (title ?? "").trim();
}

function isClaudeCodeTitle(title: string): boolean {
  const lower = title.toLowerCase();
  return lower === "claude" || lower.startsWith("claude ");
}

const encoder = new TextEncoder();

// Minimum acceptable terminal dimensions.
// If FitAddon proposes anything smaller, we skip the resize entirely
// to prevent xterm from entering a broken state.
const MIN_COLS = 10;
const MIN_ROWS = 4;

/**
 * Safe wrapper around FitAddon.fit().
 * Uses proposeDimensions() to get the values, validates them,
 * and only applies the resize if they're reasonable.
 * This prevents xterm from ever resizing to 1-2 columns during
 * transient layout states.
 */
function safeFit(term: XTerminal, fitAddon: FitAddon): boolean {
  const dims = fitAddon.proposeDimensions();
  if (!dims) return false;
  // Guard against NaN/Infinity from incomplete layout measurements
  if (!Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return false;
  const cols = Math.round(dims.cols);
  const rows = Math.round(dims.rows);
  if (cols < MIN_COLS || rows < MIN_ROWS) return false;
  if (cols === term.cols && rows === term.rows) return false;

  // Capture viewport anchor: how far from the bottom the user has scrolled.
  // After resize, restore this distance so content stays visually pinned.
  const buf = term.buffer.active;
  const distFromBottom = buf.baseY - buf.viewportY;

  // Resize in-place without clearing the renderer first.
  // FitAddon.fit() calls _renderService.clear() before resize, but that
  // blanks the canvas for one frame — visible as flicker when sibling
  // panes are removed and the ResizeObserver fires transiently.
  // xterm's resize() reflows content correctly without a prior clear.
  term.resize(cols, rows);

  // Restore viewport position relative to the bottom.
  const newBuf = term.buffer.active;
  const targetViewport = Math.max(0, newBuf.baseY - distFromBottom);
  if (newBuf.viewportY !== targetViewport) {
    term.scrollToLine(targetViewport);
  }
  return true;
}

export function Terminal({ cwd, command, initialInput, ptyId: existingPtyId, lockCols: lockColsProp, scriptBufferKey, workspaceId, onPtySpawned, onCwdChanged, onTitleChange, onFileOpen, onKill }: TerminalProps) {
  const theme = useWorkspaceStore((s) => s.theme);
  const themeRef = useRef<ThemeName>(theme);
  themeRef.current = theme;
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const unlistenOutputRef = useRef<UnlistenFn | null>(null);
  const unlistenExitRef = useRef<UnlistenFn | null>(null);
  const lastCwdRef = useRef<string>(cwd);
  const osc7TailRef = useRef<string>("");
  const prDetectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTitleChangeRef = useRef(onTitleChange);
  const onKillRef = useRef(onKill);
  const lastPublishedTitleRef = useRef<string | null>(null);
  const claudeLikelyActiveRef = useRef(false);
  const claudeLostPollCountRef = useRef(0);
  onTitleChangeRef.current = onTitleChange;
  onKillRef.current = onKill;

  const emitTitle = useCallback((title: string) => {
    const normalized = normalizeTerminalTitle(title);
    if (normalized === lastPublishedTitleRef.current) return;
    lastPublishedTitleRef.current = normalized;
    onTitleChangeRef.current?.(normalized);
  }, []);

  useEffect(() => {
    lastCwdRef.current = cwd;
  }, [cwd]);

  // Sync xterm theme when the app theme changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = getXtermTheme(theme);
    }
  }, [theme]);

  // Poll foreground process to detect Claude Code (or other named processes).
  // Keep Claude "sticky" until several polls agree it is gone, so transient
  // shell/title updates cannot knock the tab back to zsh while Claude runs.
  useEffect(() => {
    let cancelled = false;
    let emptyCount = 0;
    const poll = async () => {
      const ptyId = ptyIdRef.current;
      if (!ptyId || cancelled) return;
      try {
        const proc = await api.getPtyForegroundProcess(ptyId);
        const name = normalizeTerminalTitle(proc);
        if (isClaudeCodeTitle(name)) {
          claudeLikelyActiveRef.current = true;
          claudeLostPollCountRef.current = 0;
          emptyCount = 0;
          // Hide cursor entirely while Claude Code manages the TUI
          const term = termRef.current;
          if (term) {
            if (term.options.cursorBlink) term.options.cursorBlink = false;
            if (term.options.theme?.cursor !== 'transparent') {
              term.options.theme = { ...term.options.theme, cursor: 'transparent' };
            }
          }
          emitTitle("claude");
          return;
        }

        if (claudeLikelyActiveRef.current) {
          // While Claude is active, require repeated non-Claude polls before
          // downgrading the title. This avoids one-sample bootstrap flicker.
          claudeLostPollCountRef.current += 1;
          if (claudeLostPollCountRef.current < CLAUDE_LOST_POLL_THRESHOLD) {
            return;
          }
          claudeLikelyActiveRef.current = false;
          claudeLostPollCountRef.current = 0;
          // Restore blinking cursor and visible cursor color now that Claude is gone
          const term = termRef.current;
          if (term) {
            if (!term.options.cursorBlink) term.options.cursorBlink = true;
            const cursorColor = getCssVar('--terminal-cursor');
            if (cursorColor) {
              term.options.theme = { ...term.options.theme, cursor: cursorColor };
            }
          }
        }

        if (!name && !claudeLikelyActiveRef.current && lastPublishedTitleRef.current === "") {
          emptyCount = 0;
          return;
        }
        // Going from a known process to empty — debounce to avoid flicker
        if (!name && lastPublishedTitleRef.current) {
          emptyCount++;
          if (emptyCount < 2) return;
          // Foreground process gone (back at shell prompt) — clear detected ports
          useWorkspaceStore.getState().removePortsByPty(ptyId);
        }
        emptyCount = 0;
        emitTitle(name);
      } catch {
        /* PTY might be dead */
      }
    };
    const interval = setInterval(poll, 3000);
    // Initial poll after a short delay (let PTY spawn first)
    const initialTimeout = setTimeout(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      clearTimeout(initialTimeout);
    };
  }, [emitTitle]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const term = termRef.current;
    const ptyId = ptyIdRef.current;

    showContextMenu(
      [
        {
          label: "Copy",
          accelerator: "CmdOrCtrl+C",
          action: () => {
            if (term) {
              const sel = term.getSelection();
              if (sel) navigator.clipboard.writeText(sel);
            }
          },
        },
        {
          label: "Paste",
          accelerator: "CmdOrCtrl+V",
          action: async () => {
            if (!ptyId) return;
            // Use Rust-side clipboard read (pbpaste) to avoid WebKit's
            // clipboard permission popup that navigator.clipboard.readText()
            // triggers in Tauri's webview. Image paste is handled separately
            // via the native paste event handler.
            try {
              const text = await api.readClipboardText();
              if (text) api.writePty(ptyId, Array.from(encoder.encode(text)));
            } catch {
              /* clipboard access failed */
            }
          },
        },
        {
          label: "Select All",
          accelerator: "CmdOrCtrl+A",
          action: () => term?.selectAll(),
        },
        "separator",
        {
          label: "Clear Terminal",
          action: () => term?.clear(),
        },
        {
          label: "Kill Terminal",
          action: () => {
            if (onKillRef.current) {
              onKillRef.current();
            } else if (ptyId) {
              api.killPty(ptyId);
            }
          },
        },
      ],
      { x: e.clientX, y: e.clientY },
    );
  }, []);

  const handleMouseDown = useCallback(() => {
    // Focus xterm's hidden textarea on click so keyboard input works.
    // Always focus — even if already active — to handle app activation
    // click-through (clicking into an inactive window should route focus
    // to the terminal that was clicked, not where focus was last).
    const textarea = containerRef.current?.querySelector(
      "textarea.xterm-helper-textarea"
    ) as HTMLTextAreaElement | null;
    if (textarea) {
      textarea.focus();
    }
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerminal({
      cols: 80,
      rows: 24,
      macOptionIsMeta: true,
      cursorInactiveStyle: "none",
      theme: getXtermTheme(themeRef.current),
      fontSize: 13,
      fontWeight: "normal",
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      allowProposedApi: true,
      fastScrollSensitivity: 5,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    term.open(containerRef.current);

    // Patch mouse-to-cell coordinate conversion to account for CSS zoom.
    // The body container uses CSS `zoom` for app-level scaling (App.tsx).
    // xterm.js computes selection coordinates as:
    //   col = (event.clientX - rect.left) / css.cell.width
    // But clientX and rect are in viewport pixels (zoomed), while
    // css.cell.width is in CSS pixels (unzoomed, from OffscreenCanvas).
    // When zoom ≠ 1.0, this gives wrong columns. Fix: divide the
    // viewport-space offset by zoom before the cell-width division.
    const mouseService = (term as any)._core?._mouseService;
    if (mouseService) {
      const origGetCoords = mouseService.getCoords.bind(mouseService);
      const origGetMouseReportCoords = mouseService.getMouseReportCoords.bind(mouseService);
      const getZoom = () => parseFloat(localStorage.getItem("rally:zoomLevel") || "1");

      mouseService.getCoords = function(
        event: { clientX: number; clientY: number },
        element: HTMLElement,
        colCount: number,
        rowCount: number,
        isSelection?: boolean,
      ): [number, number] | undefined {
        const z = getZoom();
        if (z === 1) return origGetCoords(event, element, colCount, rowCount, isSelection);

        const renderDims = (term as any)._core._renderService?.dimensions;
        const cellW = renderDims?.css?.cell?.width;
        const cellH = renderDims?.css?.cell?.height;
        if (!cellW || !cellH) return undefined;

        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const padL = parseInt(style.getPropertyValue("padding-left"));
        const padT = parseInt(style.getPropertyValue("padding-top"));

        // Convert viewport offset → CSS offset by dividing by zoom
        const relX = (event.clientX - rect.left - padL) / z;
        const relY = (event.clientY - rect.top - padT) / z;

        let col = Math.ceil((relX + (isSelection ? cellW / 2 : 0)) / cellW);
        let row = Math.ceil(relY / cellH);
        col = Math.min(Math.max(col, 1), colCount + (isSelection ? 1 : 0));
        row = Math.min(Math.max(row, 1), rowCount);
        return [col, row];
      };

      mouseService.getMouseReportCoords = function(
        event: MouseEvent,
        element: HTMLElement,
      ): { col: number; row: number; x: number; y: number } | undefined {
        const z = getZoom();
        if (z === 1) return origGetMouseReportCoords(event, element);

        const renderDims = (term as any)._core._renderService?.dimensions;
        const cellW = renderDims?.css?.cell?.width;
        const cellH = renderDims?.css?.cell?.height;
        if (!cellW || !cellH) return undefined;

        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const padL = parseInt(style.getPropertyValue("padding-left"));
        const padT = parseInt(style.getPropertyValue("padding-top"));

        let x = (event.clientX - rect.left - padL) / z;
        let y = (event.clientY - rect.top - padT) / z;
        x = Math.min(Math.max(x, 0), renderDims.css.canvas.width - 1);
        y = Math.min(Math.max(y, 0), renderDims.css.canvas.height - 1);

        return {
          col: Math.floor(x / cellW),
          row: Math.floor(y / cellH),
          x: Math.floor(x),
          y: Math.floor(y),
        };
      };
    }

    // Custom link provider: Cmd+click for file paths and URLs
    const noop: OnFileOpen = () => {};
    const linkProvider = new TerminalLinkProvider(
      term,
      () => lastCwdRef.current || cwd,
      onFileOpen || noop,
    );
    const linkDisposable = term.registerLinkProvider(linkProvider);

    // Forward OSC 0/2 title changes to the parent.
    // Ignore shell-only title updates while Claude is likely active.
    const titleDisposable = term.onTitleChange((title) => {
      const normalized = normalizeTerminalTitle(title);
      if (!normalized) return;

      if (isClaudeCodeTitle(normalized)) {
        claudeLikelyActiveRef.current = true;
        claudeLostPollCountRef.current = 0;
        // Hide cursor entirely when Claude sets the title
        if (term.options.cursorBlink) {
          term.options.cursorBlink = false;
        }
        if (term.options.theme?.cursor !== 'transparent') {
          term.options.theme = { ...term.options.theme, cursor: 'transparent' };
        }
        emitTitle("claude");
        return;
      }

      // Once Claude is active, ignore all non-Claude OSC titles.
      // Foreground-process polling decides when Claude is actually gone.
      if (claudeLikelyActiveRef.current) {
        return;
      }

      emitTitle(normalized);
    });

    // Track Cmd key for link decorations.
    // Listen on window (not termEl) so Cmd is tracked even when the terminal
    // doesn't have keyboard focus — the user may Cmd+click a link in an
    // unfocused terminal pane.
    const termEl = containerRef.current;
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === "Meta") linkProvider.cmdHeld = true; };
    const handleKeyUp = (e: KeyboardEvent) => { if (e.key === "Meta") linkProvider.cmdHeld = false; };
    const handleBlur = () => { linkProvider.cmdHeld = false; };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    // Intercept paste events to handle image data from clipboard.
    // xterm.js only handles text paste — images are silently ignored.
    // We detect image items, save to a temp file via Tauri, and write
    // the file path into the PTY so the running process can reference it.
    const handlePaste = (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      const items = e.clipboardData.items;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith("image/")) {
          e.preventDefault();
          e.stopPropagation();
          const blob = items[i].getAsFile();
          if (!blob) return;
          const mimeType = items[i].type;
          const reader = new FileReader();
          reader.onload = async () => {
            const dataUrl = reader.result as string;
            // Strip "data:image/png;base64," prefix
            const base64 = dataUrl.split(",")[1];
            if (!base64 || !ptyIdRef.current) return;
            try {
              const path = await api.saveClipboardImage(base64, mimeType);
              api.writePty(ptyIdRef.current, Array.from(encoder.encode(path)));
            } catch (err) {
              console.error("Failed to save clipboard image:", err);
            }
          };
          reader.readAsDataURL(blob);
          return; // handle first image only
        }
      }
    };
    // Use capture phase so we see the paste before xterm.js can handle it
    termEl.addEventListener("paste", handlePaste, true);

    // Handle Cmd+C (copy), Cmd+V (paste), Cmd+A (select all),
    // and Option+Arrow (word movement)
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;

      // Option+Left/Right: send ESC+b / ESC+f for word movement.
      // macOptionIsMeta makes xterm send CSI modified-key sequences
      // (e.g. \x1b[1;3D) which most shells don't bind by default.
      // Intercept and send the emacs-style sequences instead.
      if (ev.altKey && !ev.metaKey && !ev.ctrlKey) {
        if (ev.key === "ArrowLeft") {
          ev.preventDefault();
          if (ptyIdRef.current) {
            api.writePty(ptyIdRef.current, Array.from(encoder.encode("\x1bb")));
          }
          return false;
        }
        if (ev.key === "ArrowRight") {
          ev.preventDefault();
          if (ptyIdRef.current) {
            api.writePty(ptyIdRef.current, Array.from(encoder.encode("\x1bf")));
          }
          return false;
        }
      }

      // Shift+Arrow: let it bubble to the document handler for pane navigation
      if (ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        if (ev.key === "ArrowLeft" || ev.key === "ArrowRight" ||
            ev.key === "ArrowUp" || ev.key === "ArrowDown") {
          ev.preventDefault();
          term.clearSelection();
          return false;
        }
      }

      const isMeta = ev.metaKey; // Cmd on macOS
      if (!isMeta) return true;

      if (ev.key === "c") {
        const sel = term.getSelection();
        if (sel) {
          ev.preventDefault();
          navigator.clipboard.writeText(sel);
          return false; // prevent xterm from handling
        }
        // No selection → let it pass through as Ctrl+C (SIGINT)
        return true;
      }
      if (ev.key === "v") {
        // Ensure the xterm textarea is focused so the browser fires a native
        // paste event on it. Using navigator.clipboard.readText() triggers
        // WebKit's "Paste" permission popup in Tauri's webview, so we rely
        // on the native paste flow instead (no popup, no permission needed).
        term.focus();
        return true;
      }
      if (ev.key === "a") {
        term.selectAll();
        return false;
      }
      // Let Cmd+/ bubble to document for split shortcut
      if (ev.key === "/") {
        return false;
      }
      // Let Cmd+W bubble to document for close tab shortcut
      if (ev.key === "w") {
        return false;
      }
      // Let Cmd+Shift+[ / ] bubble to document for tab cycling
      if (ev.shiftKey && (ev.code === "BracketLeft" || ev.code === "BracketRight")) {
        return false;
      }
      return true;
    });

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Track whether this terminal owns the PTY (should kill on unmount)
    const ownsPty = !existingPtyId;
    // Only lock cols when explicitly requested (ship dock terminals).
    // Regular PTY reconnections after layout changes must resize freely.
    const lockCols = !!lockColsProp;
    const LOCKED_COLS = 80; // Must match ship PTY spawn size
    let ptySpawned = false;
    let rafId: number | null = null;
    const outputDecoder = new TextDecoder();

    /** Fit rows to container, keeping cols locked at LOCKED_COLS. */
    function fitRowsOnly(): boolean {
      const dims = fitAddon.proposeDimensions();
      if (!dims || !Number.isFinite(dims.rows)) return false;
      const rows = Math.max(MIN_ROWS, Math.round(dims.rows));
      if (rows === term.rows && term.cols === LOCKED_COLS) return false;
      const buf = term.buffer.active;
      const distFromBottom = buf.baseY - buf.viewportY;
      term.resize(LOCKED_COLS, rows);
      const newBuf = term.buffer.active;
      const targetViewport = Math.max(0, newBuf.baseY - distFromBottom);
      if (newBuf.viewportY !== targetViewport) {
        term.scrollToLine(targetViewport);
      }
      return true;
    }

    async function connectToPty(ptyId: string) {
      ptyIdRef.current = ptyId;
      osc7TailRef.current = "";

      unlistenOutputRef.current = await listen<{ data: number[] }>(
        `pty-output-${ptyId}`,
        (event) => {
          const chunk = new Uint8Array(event.payload.data);
          // Write to xterm FIRST — lowest latency for visible output
          term.write(chunk);
          // Buffer for replay (cheap — just array push)
          appendPtyBuffer(ptyId, chunk);
          // Defer heavier parsing to avoid blocking the render
          if (onCwdChanged) {
            queueMicrotask(() => {
              const text = outputDecoder.decode(chunk, { stream: true });
              const combined = osc7TailRef.current + text;
              osc7TailRef.current = combined.slice(-OSC7_TAIL_MAX);
              const newCwd = parseLatestOsc7Cwd(combined);
              if (newCwd && newCwd !== lastCwdRef.current) {
                lastCwdRef.current = newCwd;
                onCwdChanged(newCwd);
              }
              // Detect GitHub PR URLs in terminal output
              if (text.includes("github.com") && /\/pull\/\d+/.test(text)) {
                if (prDetectTimerRef.current) clearTimeout(prDetectTimerRef.current);
                prDetectTimerRef.current = setTimeout(() => {
                  prDetectTimerRef.current = null;
                  useWorkspaceStore.getState().refreshPrStatusForPath(cwd);
                }, 1500);
              }
              // Detect localhost ports in terminal output
              if (workspaceId && (text.includes("localhost") || text.includes("127.0.0.1") || /\bport\s+\d/i.test(text))) {
                const ports = detectPorts(text);
                const curPtyId = ptyIdRef.current;
                if (ports.length > 0 && curPtyId) {
                  const store = useWorkspaceStore.getState();
                  for (const p of ports) {
                    store.addDetectedPort(workspaceId, {
                      ...p,
                      source: { type: "pane", ptyId: curPtyId },
                      detectedAt: Date.now(),
                    });
                  }
                }
              }
            });
          }
        }
      );

      unlistenExitRef.current = await listen<{ code: number | null }>(
        `pty-exit-${ptyId}`,
        (event) => {
          const code = event.payload.code;
          term.writeln(
            `\r\n\x1b[90m[Process exited${code != null ? ` with code ${code}` : ""}]\x1b[0m`
          );
          // Clean up PTY output buffer and detected ports on exit
          clearPtyBuffer(ptyId);
          useWorkspaceStore.getState().removePortsByPty(ptyId);
        }
      );

      // Send keystrokes immediately — no batching/debouncing (matches VSCode).
      // Latency-critical: each keystroke goes directly to PTY.
      term.onData((data) => {
        if (ptyIdRef.current) {
          api.writePtyString(ptyIdRef.current, data);
        }
      });

      // Debounce horizontal (col) resize at 100ms (expensive — causes reflow),
      // but send vertical (row) resize immediately (cheap). Matches VSCode strategy.
      let lastSentCols = 0;
      let lastSentRows = 0;
      let colResizeTimer: ReturnType<typeof setTimeout> | null = null;

      term.onResize(({ cols, rows }) => {
        if (!ptyIdRef.current || cols < MIN_COLS || rows < MIN_ROWS) return;
        // Skip during split drag — PTY gets resized on drag end
        if (document.documentElement.hasAttribute("data-rally-split-drag")) return;
        const effectiveCols = lockCols ? LOCKED_COLS : cols;

        // Row change: send immediately
        if (rows !== lastSentRows) {
          lastSentRows = rows;
          lastSentCols = effectiveCols;
          if (colResizeTimer !== null) {
            clearTimeout(colResizeTimer);
            colResizeTimer = null;
          }
          api.resizePty(ptyIdRef.current!, effectiveCols, rows);
          return;
        }

        // Col-only change: debounce 100ms
        if (effectiveCols !== lastSentCols) {
          if (colResizeTimer !== null) clearTimeout(colResizeTimer);
          colResizeTimer = setTimeout(() => {
            colResizeTimer = null;
            if (ptyIdRef.current) {
              lastSentCols = effectiveCols;
              lastSentRows = rows;
              api.resizePty(ptyIdRef.current, effectiveCols, rows);
            }
          }, 100);
        }
      });
    }

    async function attachExistingPty() {
      if (ptySpawned || !existingPtyId) return;
      ptySpawned = true;

      try {
        if (lockCols) {
          fitRowsOnly();
        } else {
          safeFit(term, fitAddon);
        }

        // Replay buffered output from ship session or script run
        if (lockCols) {
          const session = useWorkspaceStore.getState().shipSession;
          if (session && session.ptyId === existingPtyId) {
            for (const chunk of shipOutputBuffer) {
              term.write(chunk);
            }
          }
        }
        if (scriptBufferKey) {
          const buf = scriptOutputBuffers.get(scriptBufferKey);
          if (buf) {
            for (const chunk of buf) {
              term.write(chunk);
            }
          }
        }

        // Replay general PTY output buffer (for regular terminals after layout changes)
        if (!lockCols && !scriptBufferKey) {
          const buf = ptyOutputBuffers.get(existingPtyId);
          if (buf) {
            for (const chunk of buf) {
              term.write(chunk);
            }
          }
        }

        await connectToPty(existingPtyId);

        // After replaying buffered content, clear the renderer cache so that
        // mouse-to-cell coordinate mapping is recalculated. Without this,
        // text selection can appear offset (selecting rows above the cursor).
        const core = (term as any)._core;
        if (core?._renderService) core._renderService.clear();

        // Sync PTY dimensions — this sends SIGWINCH which makes TUI apps redraw
        if (lockCols) {
          fitRowsOnly();
          if (term.rows >= MIN_ROWS) {
            api.resizePty(existingPtyId, LOCKED_COLS, term.rows);
          }
        } else {
          safeFit(term, fitAddon);
          if (term.cols >= MIN_COLS && term.rows >= MIN_ROWS) {
            api.resizePty(existingPtyId, term.cols, term.rows);
          }
        }
      } catch (e) {
        term.writeln(`\x1b[31mFailed to attach to terminal: ${e}\x1b[0m`);
      }
    }

    async function spawnPty() {
      if (ptySpawned) return;
      ptySpawned = true;

      try {
        safeFit(term, fitAddon);
        // Ensure at least 80x24 — protects against xterm auto-sizing to
        // a tiny container during initial layout settling
        const spawnCols = Math.max(term.cols, 80);
        const spawnRows = Math.max(term.rows, 24);
        const ptyId = await api.spawnPty(cwd, command ?? null, spawnCols, spawnRows);

        // Persist ptyId so it survives layout-induced remounts
        onPtySpawned?.(ptyId);

        await connectToPty(ptyId);

        // Send initialInput after a delay to let the command start
        if (initialInput) {
          setTimeout(() => {
            if (ptyIdRef.current) {
              api.writePty(
                ptyIdRef.current,
                Array.from(encoder.encode(initialInput + "\r"))
              );
            }
          }, 1500);
        }

        // Sync dimensions after the async gap — a resize may have occurred
        // during the await (before onResize was registered), leaving the
        // PTY at stale dimensions.
        // Clear renderer cache first to ensure mouse-to-cell mapping stays correct.
        const core = (term as any)._core;
        if (core?._renderService) core._renderService.clear();
        if (safeFit(term, fitAddon)) {
          // safeFit resized xterm, but onResize already forwarded it.
          // No extra action needed.
        } else {
          // xterm may already be at a different size than what we spawned with.
          const currentCols = term.cols;
          const currentRows = term.rows;
          if (
            currentCols >= MIN_COLS &&
            currentRows >= MIN_ROWS &&
            (currentCols !== spawnCols || currentRows !== spawnRows)
          ) {
            api.resizePty(ptyId, currentCols, currentRows);
          }
        }
      } catch (e) {
        term.writeln(`\x1b[31mFailed to start terminal: ${e}\x1b[0m`);
      }
    }

    const initFn = existingPtyId ? attachExistingPty : spawnPty;

    const el = containerRef.current;

    // xterm fit runs normally during drag (content must render in real-time).
    // The expensive PTY resize IPC is already skipped in term.onResize during drag.
    const observer = new ResizeObserver(() => {
      if (el.clientWidth < 100 || el.clientHeight < 50) return;

      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!ptySpawned) {
          initFn();
        } else {
          lockCols ? fitRowsOnly() : safeFit(term, fitAddon);
        }
      });
    });
    observer.observe(el);

    // After split drag ends, send a final PTY resize (skipped during drag)
    const onDragEnd = () => {
      if (el.clientWidth < 100 || el.clientHeight < 50) return;
      if (ptyIdRef.current) {
        const cols = lockCols ? LOCKED_COLS : term.cols;
        api.resizePty(ptyIdRef.current, cols, term.rows);
      }
    };
    document.addEventListener("rally:split-resize-end", onDragEnd);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
      document.removeEventListener("rally:split-resize-end", onDragEnd);
      linkDisposable.dispose();
      titleDisposable.dispose();
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
      termEl.removeEventListener("paste", handlePaste, true);
      // Kill PTY on unmount ONLY if we own it AND the store isn't managing it.
      // When onPtySpawned is provided, the store persists the ptyId and handles
      // cleanup in closePane/closeGroup — so we must not kill here (the component
      // may just be remounting due to layout restructuring).
      if (ptyIdRef.current && ownsPty && !onPtySpawned) {
        clearPtyBuffer(ptyIdRef.current);
        api.killPty(ptyIdRef.current);
      }
      ptyIdRef.current = null;
      unlistenOutputRef.current?.();
      unlistenExitRef.current?.();
      if (prDetectTimerRef.current) clearTimeout(prDetectTimerRef.current);
      term.dispose();
    };
    // `existingPtyId` and `cwd` are intentionally excluded:
    // - `existingPtyId` is only for initial spawn/attach decision at mount.
    // - `cwd` changes as the user runs `cd`; remounting on every cwd update
    //   tears down the live terminal and can leave a blank surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command, initialInput]);

  return (
    <div
      style={{ ...styles.container, background: 'var(--terminal-bg)', padding: '4px 4px 0 4px' }}
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
    >
      <div ref={containerRef} style={styles.terminal} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
  },
  terminal: {
    flex: 1,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    justifyContent: "flex-end",
  },
};
