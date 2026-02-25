import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/dpi";

export interface MenuAction {
  label: string;
  action: () => void;
  accelerator?: string;
  disabled?: boolean;
}

export interface SubMenuAction {
  label: string;
  children: (MenuAction | "separator")[];
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

function isSubMenu(a: MenuAction | SubMenuAction | "separator"): a is SubMenuAction {
  return typeof a === "object" && "children" in a;
}

async function buildMenuItem(a: MenuAction | SubMenuAction | "separator"): Promise<MenuItem | PredefinedMenuItem | Submenu> {
  if (a === "separator") return PredefinedMenuItem.new({ item: "Separator" });
  if (isSubMenu(a)) {
    const children = await Promise.all(
      a.children.map((c) => buildMenuItem(c))
    );
    return Submenu.new({ text: a.label, items: children });
  }
  return MenuItem.new({ text: a.label, action: a.action, accelerator: a.accelerator ?? undefined, enabled: !a.disabled });
}

export async function showContextMenu(
  actions: (MenuAction | SubMenuAction | "separator")[],
  at?: { x: number; y: number },
) {
  // Clear any stale suppression — this call is a legitimate context menu
  _suppressNext = false;

  const items = await Promise.all(actions.map(buildMenuItem));
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
