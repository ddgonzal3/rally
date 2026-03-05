import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { addToast } from "../components/ToastContainer";

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

  w.once("tauri://error", (e) => {
    const payload = e?.payload;
    const detail =
      typeof payload === "string"
        ? payload
        : payload && typeof payload === "object" && "message" in payload
          ? String((payload as { message?: unknown }).message ?? "")
          : "";
    console.error("Failed to create window:", e);
    addToast({
      type: "warning",
      title: "Window open failed",
      message: detail
        ? `Could not open a new window. ${detail}`
        : "Could not open a new window.",
    });
  });
}
