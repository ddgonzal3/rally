import { api } from "./tauri";
import type { ThemeName } from "./types";

/**
 * Tie the native frost to Rally's theme, then tell CSS whether it renders.
 * `data-frost="on"` switches the sidebar to its translucent tint; anything
 * else keeps it on the app background.
 */
export async function syncWindowBackdrop(theme: ThemeName): Promise<void> {
  const frosted = await api.syncWindowBackdrop(theme !== "light").catch((e) => {
    console.error("[rally] syncWindowBackdrop failed:", e);
    return false;
  });
  document.documentElement.dataset.frost = frosted ? "on" : "off";
}
