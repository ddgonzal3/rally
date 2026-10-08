import { SETTINGS, isCssSetting, type ThemeValues } from "./schema";
import { syncMonacoTheme } from "./monaco";
import { syncWindowBackdrop } from "../windowBackdrop";

/** Push resolved theme values into this window: CSS variables, frost, Monaco. */
export function applyTheme(values: ThemeValues): void {
  const root = document.documentElement;
  for (const def of SETTINGS) {
    if (isCssSetting(def)) root.style.setProperty(`--${def.key}`, String(values[def.key]));
  }
  root.style.setProperty(
    "--sidebar-frost-bg",
    `color-mix(in srgb, ${values["sidebar-tint"]} ${Number(values["sidebar-opacity"])}%, transparent)`,
  );
  root.style.colorScheme = values.appearance === "light" ? "light" : "dark";
  // macOS frost only blurs the desktop. Over a background image, see-through
  // surfaces (sidebar, terminals) blur the image themselves.
  root.style.setProperty(
    "--surface-frost",
    values["background-image"] ? `blur(${Number(values["frost-blur"])}px) saturate(160%)` : "none",
  );
  syncBackdrop(values);
  syncMonacoTheme(values);
}

/** Also re-run on window focus: Reduce transparency changes outside Rally. */
export function syncBackdrop(values: ThemeValues): void {
  void syncWindowBackdrop(values.appearance !== "light", values.frost === true);
}

/**
 * WebKit can keep stale backdrop-filter layers after a theme switch. Toggling
 * display forces a full layout invalidation. Only on switching themes, never
 * per edit: it reflows the whole window.
 */
export function repaintBackdropFilters(): void {
  document.body.style.display = "none";
  void document.body.offsetHeight;
  document.body.style.display = "";
}
