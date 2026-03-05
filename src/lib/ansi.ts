/** Strip ANSI escape codes from terminal output for clean text display. */
export const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\[[0-9;?]*[hlm]|\x1b\].*?\x07|\x1b[()][A-Z0-9]|\x0f/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}
