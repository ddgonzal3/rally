import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";

export interface MenuAction {
  label: string;
  action: () => void;
}

export async function showContextMenu(actions: (MenuAction | "separator")[]) {
  const items = await Promise.all(
    actions.map((a) =>
      a === "separator"
        ? PredefinedMenuItem.new({ item: "Separator" })
        : MenuItem.new({ text: a.label, action: a.action })
    )
  );
  const menu = await Menu.new({ items });
  await menu.popup();
}
