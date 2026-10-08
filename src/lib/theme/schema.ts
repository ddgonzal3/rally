/**
 * Every customizable theme setting, in the order the theme builder shows it.
 *
 * Colors and fonts are applied as CSS variables named `--<key>`; components
 * read them with `var(--<key>)`. Adding a setting here (plus a default in each
 * built-in theme) is all it takes for the builder to show a control for it.
 */

export type SettingKind = "color" | "font" | "number" | "toggle" | "choice" | "image";

export interface SettingDef {
  key: string;
  label: string;
  group: string;
  kind: SettingKind;
  /** Short help shown under the label. */
  hint?: string;
  /** `font` settings: offer monospace-friendly fonts first. */
  mono?: boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: string; label: string }[];
}

export type ThemeValue = string | number | boolean;
export type ThemeValues = Record<string, ThemeValue>;

export interface Theme {
  version: 1;
  id: string;
  name: string;
  values: ThemeValues;
}

const color = (group: string, key: string, label: string, hint?: string): SettingDef => ({ key, label, group, kind: "color", hint });

const ANSI: [string, string][] = [
  ["black", "Black"],
  ["red", "Red"],
  ["green", "Green"],
  ["yellow", "Yellow"],
  ["blue", "Blue"],
  ["magenta", "Magenta"],
  ["cyan", "Cyan"],
  ["white", "White"],
];

export const SETTINGS: SettingDef[] = [
  // Window
  {
    key: "appearance",
    label: "Appearance",
    group: "Window",
    kind: "choice",
    hint: "Dark or light system controls, scrollbars and editor base.",
    options: [
      { value: "dark", label: "Dark" },
      { value: "light", label: "Light" },
    ],
  },
  { key: "frost", label: "Frosted sidebar", group: "Window", kind: "toggle", hint: "Blur the desktop behind the sidebar and title strip." },
  { key: "sidebar-opacity", label: "Sidebar tint strength", group: "Window", kind: "number", min: 0, max: 100, step: 1, unit: "%", hint: "Lower shows more of the desktop through the frost." },
  color("Window", "sidebar-tint", "Sidebar tint"),

  // Background
  { key: "background-image", label: "Image", group: "Background", kind: "image", hint: "Shown behind Rally instead of the desktop. See-through surfaces show it." },
  {
    key: "background-fit",
    label: "Fit",
    group: "Background",
    kind: "choice",
    options: [
      { value: "cover", label: "Fill" },
      { value: "contain", label: "Fit" },
      { value: "tile", label: "Tile" },
    ],
  },
  { key: "background-dim", label: "Dim", group: "Background", kind: "number", min: 0, max: 90, step: 1, unit: "%" },
  { key: "background-blur", label: "Image blur", group: "Background", kind: "number", min: 0, max: 40, step: 1, unit: "px" },
  { key: "frost-blur", label: "Frost strength", group: "Background", kind: "number", min: 0, max: 60, step: 1, unit: "px", hint: "How much the sidebar and see-through terminals blur the image behind them." },

  // Backgrounds
  color("Backgrounds", "bg-app", "App background"),
  color("Backgrounds", "bg-surface", "Panels"),
  color("Backgrounds", "bg-elevated", "Raised surfaces"),
  color("Backgrounds", "bg-input", "Inputs"),
  color("Backgrounds", "bg-hover", "Hover"),
  color("Backgrounds", "bg-active", "Pressed and selected"),
  color("Backgrounds", "pill-bg", "Pills"),
  color("Backgrounds", "frosted-bg", "Popovers"),
  color("Backgrounds", "shadow", "Shadows"),
  color("Backgrounds", "drop-preview-bg", "Drop preview fill"),
  color("Backgrounds", "drop-preview-border", "Drop preview edge"),
  color("Backgrounds", "dialog-bg", "Dialogs", "The new-task launcher card."),
  color("Backgrounds", "list-selection-bg", "Selected result", "Highlighted row in Quick Open."),

  // Text
  color("Text", "text-primary", "Primary"),
  color("Text", "text-secondary", "Secondary"),
  color("Text", "text-dim", "Dim"),
  color("Text", "match-highlight", "Search matches", "Matched letters in Quick Open."),

  // Lines
  color("Lines", "border", "Borders"),
  color("Lines", "border-subtle", "Subtle borders"),
  color("Lines", "resize-hover", "Resize handle hover"),
  color("Lines", "tab-indicator", "Active tab marker"),
  color("Lines", "scrollbar-thumb", "Scrollbar"),
  color("Lines", "scrollbar-thumb-hover", "Scrollbar hover"),
  color("Lines", "tint", "Faint lines and fills", "Mixed in at low strength for dividers, outlines and soft button fills. White on dark themes, black on light."),
  color("Lines", "focus-border", "Focused input edge"),

  // Status
  color("Status", "status-green", "Success"),
  color("Status", "status-red", "Error"),
  color("Status", "status-amber", "Working and warning"),
  color("Status", "status-blue", "Info"),
  color("Status", "accent", "Accent", "Switches that are on, info notices and count badges."),
  color("Status", "success-text", "Approved", "Approved reviews, new files and no-conflict labels in PR review."),
  color("Status", "warning-text", "Confirm prompts", "Text of are-you-sure prompts before destructive actions."),
  color("Status", "notice-success", "Success notices"),
  color("Status", "notice-warning", "Warning notices"),

  // Buttons
  color("Buttons", "button-primary-bg", "Primary button"),
  color("Buttons", "button-primary-text", "Primary button text"),
  color("Buttons", "button-danger-bg", "Destructive button"),
  color("Buttons", "toggle-on", "Switch on", "Settings switches; mixed in at partial strength."),

  // Git
  color("Git", "change-added", "Added files", "Change letters in the file explorer."),
  color("Git", "change-modified", "Modified files"),
  color("Git", "change-deleted", "Deleted files"),
  color("Git", "change-renamed", "Renamed files"),
  color("Git", "pr-draft", "Draft pull request"),

  // Diffs
  color("Diffs", "diff-added", "Added lines", "Line backgrounds and change bars are tinted from this."),
  color("Diffs", "diff-removed", "Removed lines"),
  color("Diffs", "diff-renamed", "Renamed file marker"),

  // Canvas
  color("Canvas", "canvas-pod-footer", "Pod footer"),
  color("Canvas", "canvas-selection", "Selection", "Selected pod outline and drag-select box."),

  // Fonts
  { key: "font-ui", label: "Interface font", group: "Fonts", kind: "font" },
  { key: "font-mono", label: "Code font", group: "Fonts", kind: "font", mono: true, hint: "Diffs, editors and inline code." },

  // Terminal
  { key: "terminal-font", label: "Font", group: "Terminal", kind: "font", mono: true },
  { key: "terminal-font-size", label: "Font size", group: "Terminal", kind: "number", min: 9, max: 24, step: 1, unit: "px" },
  { key: "terminal-line-height", label: "Line spacing", group: "Terminal", kind: "number", min: 1, max: 2, step: 0.05 },
  color("Terminal", "terminal-bg", "Background"),
  color("Terminal", "terminal-popup-bg", "Script output background"),
  color("Terminal", "terminal-fg", "Text"),
  color("Terminal", "terminal-cursor", "Cursor"),
  color("Terminal", "terminal-selection", "Selection"),
  ...ANSI.map(([k, l]) => color("Terminal colors", `ansi-${k}`, l)),
  ...ANSI.map(([k, l]) => color("Terminal colors", `ansi-bright-${k}`, `Bright ${l.toLowerCase()}`)),

  // Code
  color("Code", "editor-bg", "Editor background"),
  color("Code", "syn-comment", "Comments"),
  color("Code", "syn-string", "Strings"),
  color("Code", "syn-keyword", "Keywords"),
  color("Code", "syn-literal", "Literals"),
  color("Code", "syn-number", "Numbers"),
];

export const SETTINGS_BY_KEY: Record<string, SettingDef> = Object.fromEntries(SETTINGS.map((s) => [s.key, s]));

/** Groups in display order. */
export const SETTING_GROUPS: string[] = [...new Set(SETTINGS.map((s) => s.group))];

/** Settings applied directly as `--<key>` CSS variables. */
export function isCssSetting(def: SettingDef): boolean {
  return def.kind === "color" || def.kind === "font";
}
