import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/dpi";

export interface MenuAction {
  label: string;
  action: () => void;
  accelerator?: string;
}

export async function showContextMenu(
  actions: (MenuAction | "separator")[],
  at?: { x: number; y: number },
) {
  const items = await Promise.all(
    actions.map((a) =>
      a === "separator"
        ? PredefinedMenuItem.new({ item: "Separator" })
        : MenuItem.new({ text: a.label, action: a.action, accelerator: a.accelerator ?? undefined })
    )
  );
  const menu = await Menu.new({ items });
  if (at) {
    // Tauri's LogicalPosition on macOS expects coordinates scaled down by devicePixelRatio
    const dpr = window.devicePixelRatio || 1;
    await menu.popup(new LogicalPosition(at.x / dpr, at.y / dpr));
  } else {
    await menu.popup();
  }
}
