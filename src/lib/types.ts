export interface Workspace {
  id: string;
  name: string;
  paths: string[];
  repo_url: string;
  branch: string;
  main_branch: string;
  processes: ProcessConfig[];
}

export interface ProcessConfig {
  name: string;
  command: string;
  cwd?: string;
  auto_start: boolean;
}

export interface GitStatus {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  modified_files: string[];
  untracked_files: string[];
}

export interface PushResult {
  output: string;
  method: "push" | "force-with-lease" | "set-upstream";
}

export interface PrStatus {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  is_draft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  review_decision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  checks_status: "pass" | "fail" | "pending" | null;
}

export interface ChangedFile {
  path: string;
  status: string; // "M" modified, "A" added, "D" deleted, "R" renamed
}

export interface ChangesSummary {
  staged: ChangedFile[];
  unstaged: ChangedFile[];
  untracked: string[];
}

// --- Ship Signal Types ---

export interface ShipSignalFlaggedItem {
  file: string;
  line: number;
  severity: string;
  description: string;
}

export interface ShipSignal {
  version: number;
  timestamp: string;
  repo_path: string;
  branch: string;
  verdict: "auto_merge" | "manual_review";
  pr_number: number;
  pr_url: string;
  summary: string;
  flagged_items: ShipSignalFlaggedItem[];
}

export type ShipPhase = "idle" | "shipping" | "awaiting_review" | "merging" | "syncing";

export interface ShipStatus {
  phase: ShipPhase;
  signal?: ShipSignal;
  pr_number?: number;
}

// --- Task Runner Types ---

export interface TaskEntry {
  name: string;
  command: string;
  label: string;
  cwd?: string;
  builtin?: boolean;
  file_path?: string;
}

export interface TaskRun {
  taskName: string;
  ptyId: string;
  status: "running" | "success" | "error" | "stopped";
  exitCode: number | null;
  output: Uint8Array[];
}

// --- Pane & Layout Types ---

export type PaneType = "claude" | "terminal" | "claude-launcher" | "editor" | "diff";

export interface Pane {
  id: string;
  type: PaneType;
  title: string;
  command?: string;
  filePath?: string;
  cwd?: string;
  initialInput?: string;
}

export type SplitDirection = "horizontal" | "vertical";

export type LayoutNode =
  | { type: "group"; groupId: string }
  | {
      type: "split";
      id: string;
      direction: SplitDirection;
      children: [LayoutNode, LayoutNode];
      ratio: number;
    };

export interface PaneGroup {
  id: string;
  panes: Pane[];
  activePaneId: string;
}

export interface WorkspaceLayout {
  root: LayoutNode;
  groups: Record<string, PaneGroup>;
}

// --- Layout Tree Utilities ---

/** Find a node (group or split) by its id/groupId in the tree. */
export function findNode(
  root: LayoutNode,
  id: string
): LayoutNode | null {
  if (root.type === "group") {
    return root.groupId === id ? root : null;
  }
  if (root.id === id) return root;
  return findNode(root.children[0], id) ?? findNode(root.children[1], id);
}

/** Replace a node identified by id/groupId with a replacement. Returns new tree. */
export function replaceNode(
  root: LayoutNode,
  id: string,
  replacement: LayoutNode
): LayoutNode {
  if (root.type === "group") {
    return root.groupId === id ? replacement : root;
  }
  if (root.id === id) return replacement;
  return {
    ...root,
    children: [
      replaceNode(root.children[0], id, replacement),
      replaceNode(root.children[1], id, replacement),
    ],
  };
}

/**
 * Find the parent split of a node identified by its id/groupId.
 * Returns the parent split node and which child index (0 or 1) the target is.
 */
export function findParent(
  root: LayoutNode,
  childId: string
): { parent: Extract<LayoutNode, { type: "split" }>; index: 0 | 1 } | null {
  if (root.type === "group") return null;
  for (const idx of [0, 1] as const) {
    const child = root.children[idx];
    if (child.type === "group" && child.groupId === childId) {
      return { parent: root, index: idx };
    }
    if (child.type === "split" && child.id === childId) {
      return { parent: root, index: idx };
    }
  }
  return (
    findParent(root.children[0], childId) ??
    findParent(root.children[1], childId)
  );
}

/** Walk a subtree and return the first group ID found (depth-first, prefers first child). */
export function findFirstGroupInSubtree(node: LayoutNode): string | null {
  if (node.type === "group") return node.groupId;
  return (
    findFirstGroupInSubtree(node.children[0]) ??
    findFirstGroupInSubtree(node.children[1])
  );
}

// --- Default Layout Factory ---

export function createDefaultLayout(): WorkspaceLayout {
  const claudePane: Pane = {
    id: crypto.randomUUID(),
    type: "claude-launcher",
    title: "Claude Code",
  };
  const terminalPane: Pane = {
    id: crypto.randomUUID(),
    type: "terminal",
    title: "Terminal",
  };
  const g1: PaneGroup = {
    id: crypto.randomUUID(),
    panes: [claudePane],
    activePaneId: claudePane.id,
  };
  const g2: PaneGroup = {
    id: crypto.randomUUID(),
    panes: [terminalPane],
    activePaneId: terminalPane.id,
  };
  return {
    root: {
      type: "split",
      id: crypto.randomUUID(),
      direction: "vertical",
      children: [
        { type: "group", groupId: g1.id },
        { type: "group", groupId: g2.id },
      ],
      ratio: 0.5,
    },
    groups: {
      [g1.id]: g1,
      [g2.id]: g2,
    },
  };
}
