import { parseColor } from "./theme/color";

function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

/**
 * xterm.js theme from the active Rally theme's CSS variables (see
 * src/lib/theme/schema.ts). Read at call time, so callers re-run it when the
 * theme store changes.
 */
export function getXtermTheme(variant?: 'popup'): Record<string, string> {
  const theme: Record<string, string> = {
    // A see-through color is painted once by the terminal's container div.
    // xterm paints its background on several layers, which would compound it.
    background: needsTransparency(variant) ? 'rgba(0, 0, 0, 0)' : getCssVar(variant === 'popup' ? '--terminal-popup-bg' : '--terminal-bg'),
    foreground: getCssVar('--terminal-fg'),
    cursor: getCssVar('--terminal-cursor'),
    selectionBackground: getCssVar('--terminal-selection'),
  };
  for (const name of ANSI) {
    theme[name] = getCssVar(`--ansi-${name}`);
    theme[`bright${name[0].toUpperCase()}${name.slice(1)}`] = getCssVar(`--ansi-bright-${name}`);
  }
  return theme;
}

/**
 * xterm forces every background opaque unless `allowTransparency` is on, so a
 * see-through terminal color renders black. Turn it on only when needed: with
 * it on, glyphs are drawn without the background behind them.
 */
export function needsTransparency(variant?: 'popup'): boolean {
  const bg = parseColor(getCssVar(variant === 'popup' ? '--terminal-popup-bg' : '--terminal-bg'));
  return !!bg && bg.a < 1;
}

export { getCssVar };
