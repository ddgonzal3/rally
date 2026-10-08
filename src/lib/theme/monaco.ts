import * as monaco from "monaco-editor";
import type { ThemeValues } from "./schema";
import { hex8, parseColor } from "./color";

/** Every Monaco editor and diff view uses this one theme, rebuilt whenever the Rally theme changes. */
export const MONACO_THEME = "rally";

const SHELL_RULES = {
  dark: [
    { token: "comment.shell", foreground: "6a9955", fontStyle: "italic" },
    { token: "keyword.shell", foreground: "c586c0" },
    { token: "string.shell", foreground: "ce9178" },
    { token: "string.escape.shell", foreground: "d7ba7d" },
    { token: "variable.shell", foreground: "9cdcfe" },
    { token: "variable.special.shell", foreground: "4fc1ff" },
    { token: "number.shell", foreground: "b5cea8" },
    { token: "operator.shell", foreground: "d4d4d4" },
    { token: "delimiter.shell", foreground: "d4d4d4" },
    { token: "builtin.shell", foreground: "dcdcaa" },
    { token: "command.shell", foreground: "4ec9b0" },
    { token: "flag.shell", foreground: "9cdcfe" },
    { token: "shebang.shell", foreground: "6a9955", fontStyle: "italic" },
  ],
  light: [
    { token: "comment.shell", foreground: "4e7a3e", fontStyle: "italic" },
    { token: "keyword.shell", foreground: "8b2e8b" },
    { token: "string.shell", foreground: "a44a1f" },
    { token: "string.escape.shell", foreground: "8a6914" },
    { token: "variable.shell", foreground: "1a6090" },
    { token: "variable.special.shell", foreground: "0070a0" },
    { token: "number.shell", foreground: "4a7030" },
    { token: "operator.shell", foreground: "333333" },
    { token: "delimiter.shell", foreground: "333333" },
    { token: "builtin.shell", foreground: "795e26" },
    { token: "command.shell", foreground: "267f6e" },
    { token: "flag.shell", foreground: "1a6090" },
    { token: "shebang.shell", foreground: "4e7a3e", fontStyle: "italic" },
  ],
};

function hex(values: ThemeValues, key: string): string | undefined {
  const c = parseColor(String(values[key] ?? ""));
  return c ? hex8(c) : undefined;
}

export function syncMonacoTheme(values: ThemeValues): void {
  const light = values.appearance === "light";
  const colors: Record<string, string | undefined> = {
    "editor.background": hex(values, "editor-bg"),
    "editor.foreground": hex(values, "terminal-fg"),
    "editorLineNumber.foreground": hex(values, "text-dim"),
    "editorCursor.foreground": hex(values, "terminal-cursor"),
  };
  // The dark base already has tuned selection and widget colors; the light
  // base needs them pulled toward Rally's greys.
  if (light) {
    colors["editor.selectionBackground"] = hex(values, "terminal-selection");
    colors["editor.lineHighlightBackground"] = hex(values, "bg-hover");
    colors["editorWidget.background"] = hex(values, "bg-surface");
  }
  monaco.editor.defineTheme(MONACO_THEME, {
    base: light ? "vs" : "vs-dark",
    inherit: true,
    rules: SHELL_RULES[light ? "light" : "dark"],
    colors: Object.fromEntries(Object.entries(colors).filter((e): e is [string, string] => !!e[1])),
  });
  monaco.editor.setTheme(MONACO_THEME);
}
