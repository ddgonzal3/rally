import { api } from "./tauri";

/**
 * Pin the native window appearance to the theme, then tell CSS whether the
 * frost renders. `data-frost="on"` switches the sidebar to its translucent
 * tint; anything else keeps it on the app background (frost turned off in
 * the theme, or Reduce transparency on in System Settings).
 */
export async function syncWindowBackdrop(dark: boolean, frost: boolean): Promise<void> {
  const rendered = await api.syncWindowBackdrop(dark).catch((e) => {
    console.error("[rally] syncWindowBackdrop failed:", e);
    return false;
  });
  document.documentElement.dataset.frost = frost && rendered ? "on" : "off";
}
