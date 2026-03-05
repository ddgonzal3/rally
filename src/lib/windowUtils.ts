import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { addToast } from "../components/ToastContainer";

function attachWindowErrorHandler(w: WebviewWindow, context: string) {
  w.once("tauri://error", (e) => {
    const payload = e?.payload;
    const detail =
      typeof payload === "string"
        ? payload
        : payload && typeof payload === "object" && "message" in payload
          ? String((payload as { message?: unknown }).message ?? "")
          : "";
    console.error(`Failed to create window (${context}):`, e);
    addToast({
      type: "warning",
      title: "Window open failed",
      message: detail
        ? `Could not open ${context}. ${detail}`
        : `Could not open ${context}.`,
    });
  });
}

/**
 * Open a URL or local file in a standalone browser-like window.
 * Works for localhost URLs, remote URLs, and local file paths.
 */
export function openInNewWindow(url: string, title?: string) {
  const label = `rally-view-${crypto.randomUUID()}`;

  // For localhost/http URLs, load directly. For file paths, use a file:// URL.
  let loadUrl = url;
  if (url.startsWith("/")) {
    loadUrl = `file://${url}`;
  } else if (!url.startsWith("http")) {
    loadUrl = `http://${url}`;
  }

  const displayTitle = title || url;

  const w = new WebviewWindow(label, {
    url: loadUrl,
    title: displayTitle,
    width: 1200,
    height: 800,
    resizable: true,
    fullscreen: false,
    decorations: true,
  });

  attachWindowErrorHandler(w, "window");
}

export function openWindow(opts?: {
  workspaceId?: string;
  blankWorkspace?: boolean;
}) {
  const label = `rally-${crypto.randomUUID()}`;
  const params = new URLSearchParams();
  if (opts?.workspaceId) {
    params.set("workspaceId", opts.workspaceId);
  } else if (opts?.blankWorkspace) {
    params.set("blankWorkspace", "1");
  }
  const query = params.toString();
  const url = query ? `/?${query}` : "/";

  const w = new WebviewWindow(label, {
    url,
    title: "Rally",
    width: 1400,
    height: 900,
    resizable: true,
    fullscreen: false,
    decorations: true,
    titleBarStyle: "overlay",
    hiddenTitle: true,
  });

  attachWindowErrorHandler(w, "a new window");
}
