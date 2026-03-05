import type { ThemeName } from "./types";

function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ANSI colors per theme — these have no CSS variable equivalents.
// Background/foreground/cursor/selection are read from CSS variables
// so theme tweaks in index.html automatically apply everywhere.
const xtermAnsiColors: Record<ThemeName, Record<string, string>> = {
  dark: {
    black: '#1e1e1e',
    red: '#df7d7d',
    green: '#7ddf7d',
    yellow: '#dfdf7d',
    blue: '#7d7ddf',
    magenta: '#df7ddf',
    cyan: '#7ddfdf',
    white: '#e0e0e0',
  },
  dimmed: {
    black: '#252525',
    red: '#c87070',
    green: '#70c870',
    yellow: '#c8c870',
    blue: '#7070c8',
    magenta: '#c870c8',
    cyan: '#70c8c8',
    white: '#d2d2d2',
  },
  light: {
    black: '#111',
    red: '#a83224',
    green: '#1f8c4e',
    yellow: '#c47e0e',
    blue: '#20659a',
    magenta: '#73388e',
    cyan: '#128268',
    white: '#555',
    brightBlack: '#666',
    brightWhite: '#333',
  },
};

export function getXtermTheme(theme: ThemeName): Record<string, string> {
  return {
    background: getCssVar('--terminal-bg'),
    foreground: getCssVar('--terminal-fg'),
    cursor: getCssVar('--terminal-cursor'),
    selectionBackground: getCssVar('--terminal-selection'),
    ...xtermAnsiColors[theme],
  };
}

export { getCssVar };
