import type { FlightPod, LayoutNode } from "./types";

type LayoutLike = {
  root?: LayoutNode | null;
  groups?: Record<string, { panes: { ptyId?: string | null }[] }>;
};

export type OrphanState = {
  workspaces: { id: string }[];
  layouts: Record<string, LayoutLike>;
  flightLayouts: Record<string, { pods?: FlightPod[] } | undefined>;
  scriptRuns: Record<string, { ptyId?: string | null }>;
  shellPanels: Record<string, { ptyId?: string | null } | undefined>;
};

function collectFromLayout(
  layoutKey: string,
  state: OrphanState,
  ids: Set<string>,
) {
  const layout = state.layouts[layoutKey];
  if (!layout?.root) return;
  const walk = (node: LayoutNode) => {
    if (node.type === "group") {
      const group = layout.groups?.[(node as { groupId: string }).groupId];
      if (group) {
        for (const pane of group.panes) {
          if (pane.ptyId) ids.add(pane.ptyId);
        }
      }
    } else if (node.type === "split" && node.children) {
      for (const child of node.children) walk(child);
    }
  };
  walk(layout.root);
}

/** Collect every PTY ID currently referenced anywhere in app state. */
export function collectReferencedPtyIds(state: OrphanState): Set<string> {
  const ids = new Set<string>();

  // Dev-mode layouts (one per workspace)
  for (const ws of state.workspaces) {
    collectFromLayout(ws.id, state, ids);
  }

  // Flight pods + their layouts and shell tabs
  for (const flightLayout of Object.values(state.flightLayouts)) {
    if (!flightLayout?.pods) continue;
    for (const pod of flightLayout.pods) {
      collectFromLayout(`flight:${pod.id}`, state, ids);
      const anyPod = pod as FlightPod & {
        ptyId?: string;
        shellPtyId?: string;
      };
      if (anyPod.ptyId) ids.add(anyPod.ptyId);
      if (anyPod.shellPtyId) ids.add(anyPod.shellPtyId);
      if (pod.shellTabs) {
        for (const tab of pod.shellTabs) {
          if (tab.ptyId) ids.add(tab.ptyId);
        }
      }
    }
  }

  // Script runs
  for (const run of Object.values(state.scriptRuns)) {
    if (run.ptyId) ids.add(run.ptyId);
  }

  // Shell panels (floating shell per workspace)
  for (const panel of Object.values(state.shellPanels)) {
    if (panel?.ptyId) ids.add(panel.ptyId);
  }

  return ids;
}

/**
 * Skip PTYs younger than this when auto-releasing — protects against
 * killing a PTY that just spawned but hasn't been wired into a layout
 * yet (e.g. mid-mount of a new Claude tab or script run).
 */
export const AUTO_RELEASE_MIN_AGE_S = 60;
