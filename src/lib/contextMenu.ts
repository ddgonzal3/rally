import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/dpi";

export interface MenuAction {
  label: string;
  action: () => void;
  accelerator?: string;
  disabled?: boolean;
}

// macOS quirk: dismissing a native popup menu by clicking elsewhere can
// re-dispatch the click as a contextmenu event on the element under the
// cursor. We use a persistent capture-phase listener + flag to suppress
// the very next contextmenu event after a popup is shown.
let _suppressNext = false;

document.addEventListener(
  "contextmenu",
  (e) => {
    if (_suppressNext) {
      _suppressNext = false;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  },
  true,
);

export async function showContextMenu(
  actions: (MenuAction | "separator")[],
  at?: { x: number; y: number },
) {
  // Clear any stale suppression — this call is a legitimate context menu
  _suppressNext = false;

  const items = await Promise.all(
    actions.map((a) =>
      a === "separator"
        ? PredefinedMenuItem.new({ item: "Separator" })
        : MenuItem.new({ text: a.label, action: a.action, accelerator: a.accelerator ?? undefined, enabled: !a.disabled })
    )
  );
  const menu = await Menu.new({ items });

  // Arm the suppressor synchronously BEFORE popup(). This is safe because
  // the current contextmenu event (which triggered this call) has already
  // finished its capture+bubble phases by the time we're here. The flag
  // will only affect the NEXT contextmenu event — the ghost one that macOS
  // dispatches when the user clicks elsewhere to dismiss the native menu.
  //
  // The ghost event fires BEFORE popup() resolves because NSMenu blocks
  // the main thread and the click-to-dismiss event is dispatched to the
  // webview before NSMenu returns. So we MUST set this before popup().
  _suppressNext = true;

  if (at) {
    await menu.popup(new LogicalPosition(at.x, at.y));
  } else {
    await menu.popup();
  }

  // Clear the flag after popup resolves. If the ghost event fired, the
  // capture listener already cleared it. If the user selected a menu item
  // (no ghost event), clear it here so future right-clicks aren't blocked.
  _suppressNext = false;
}
