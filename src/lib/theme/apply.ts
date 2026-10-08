import { SETTINGS, isCssSetting, type ThemeValues } from "./schema";
import { syncMonacoTheme } from "./monaco";
import { syncWindowBackdrop } from "../windowBackdrop";

/**
 * Tileable film grain: grey fractal noise at the given opacity (0–1). Drawn
 * on the background and on top of each frosted surface's own color, because
 * the frost blur would otherwise smooth the background's grain away.
 */
function grainImage(opacity: number): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(#n)' opacity='${opacity}'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** True when Rally paints its own background (image or gradient) instead of showing the desktop. */
export function hasPaintedBackground(values: ThemeValues): boolean {
  return !!values["background-image"] || values["background-gradient"] === true;
}

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
  // macOS frost only blurs the desktop. Over Rally's own background (image or
  // gradient), see-through surfaces (sidebar, terminals) blur it themselves.
  const backdrop = hasPaintedBackground(values);
  const dots = values["canvas-dots"];
  const showDots = dots === "on" || (dots !== "off" && !backdrop);
  root.style.setProperty("--canvas-dots-display", showDots ? "block" : "none");
  const grain = Number(values["background-grain"]) / 100;
  root.style.setProperty("--surface-grain", backdrop && grain > 0 ? grainImage(grain * 0.5) : "none");
  root.style.setProperty(
    "--surface-frost",
    backdrop ? `blur(${Number(values["frost-blur"])}px) saturate(160%)` : "none",
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
