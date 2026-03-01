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
  /** Commits ahead of origin/<current_branch> */
  tracking_ahead: number;
  /** Commits behind origin/<current_branch> */
  tracking_behind: number;
  modified_files: string[];
  untracked_files: string[];
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

export interface PushResult {
  output: string;
  method: string;
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

// --- PR Details Types ---

export interface PrCommit {
  sha: string;
  message_headline: string;
  author: string;
  committed_date: string;
}

export interface PrDetails {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  is_draft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  review_decision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  checks_status: "pass" | "fail" | "pending" | null;
  body: string;
  author: string;
  base_branch: string;
  head_branch: string;
  additions: number;
  deletions: number;
  changed_files: number;
  created_at: string;
  updated_at: string;
  commits: PrCommit[];
  labels: string[];
  comments: PrComment[];
  reviews: PrReview[];
}

export interface PrComment {
  author: string;
  body: string;
  created_at: string;
}

export interface PrReview {
  author: string;
  body: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  created_at: string;
}

// --- Branch Types ---

export interface BranchInfo {
  name: string;
  is_current: boolean;
}

// --- Commit Log Types ---

export interface CommitEntry {
  sha: string;
  message: string;
  author: string;
  date: string;
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
  verdict: "auto_merge" | "manual_review" | "shipping";
  phase?: ShipDetailPhase;
  pr_number: number;
  pr_url: string;
  summary: string;
  flagged_items: ShipSignalFlaggedItem[];
}

export type ShipPhase = "idle" | "shipping" | "awaiting_review" | "merging" | "syncing";

export type ShipDetailPhase =
  | "detecting" | "syncing" | "pushing" | "creating_pr"
  | "checking" | "reviewing" | "writing_verdict"
  | "merging" | "finishing" | "complete";

export interface ShipSession {
  ptyId?: string;
  repoPath: string;
  phase: ShipDetailPhase;
  exited: boolean;
  exitCode: number | null;
  docked: boolean;
  /** Set when the signal file is detected — carries the verdict */
  signal?: ShipSignal;
}

export interface ShipStatus {
  phase: ShipPhase;
  signal?: ShipSignal;
  pr_number?: number;
}

// --- Rally Config Types ---

export interface SetupConfig {
  check?: string;
  run?: string;
}

export interface RallyConfig {
  excludeBuiltins: string[];
  excludeScripts: string[];
  mode: string | null;
  setup?: SetupConfig;
}

export interface WorkspaceReadiness {
  ready: boolean;
  issues: string[];
}

// --- Workspace Mode Types ---

export type WorkspaceMode = "product" | "dev";

export interface ProductSession {
  state: "idle" | "active";
  ptyId: string | undefined;
  prompt: string;
}

export interface ShellPanel {
  ptyId: string;
  visible: boolean;
}

// --- Rally Script Editor Types ---

export interface RallyScriptInfo {
  name: string;
  path: string;
  category: "script" | "command";
  is_modified: boolean;
  description: string;
}

// --- PTY Info Types ---

export interface PtyInfo {
  id: string;
  cwd: string;
  command: string | null;
  alive: boolean;
}

// --- Script Runner Types ---

export interface ScriptEntry {
  name: string;
  command: string;
  label: string;
  builtin?: boolean;
  file_path?: string;
}

export interface ScriptRun {
  scriptName: string;
  ptyId: string;
  status: "running" | "success" | "error" | "stopped";
  exitCode: number | null;
}

// --- Pane & Layout Types ---

export type EditorViewMode = "raw" | "split" | "preview";

export type PaneType = "claude" | "terminal" | "claude-launcher" | "editor" | "diff";

export interface Pane {
  id: string;
  type: PaneType;
  title: string;
  command?: string;
  filePath?: string;
  cwd?: string;
  initialInput?: string;
  ptyId?: string;  // Connect to existing PTY instead of spawning
  scriptBufferKey?: string;  // Key into scriptOutputBuffers for replay on attach
  initialLine?: number;  // Jump to this line on editor mount (from Cmd+click)
  initialCol?: number;   // Jump to this column on editor mount (from Cmd+click)
  editorViewMode?: EditorViewMode;
  customTitle?: string;  // User-set tab name — takes priority over auto-generated label
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
  /** MRU stack of pane IDs — most recent at end. Used to switch to the
   *  previously active tab when closing. Optional for backwards compat. */
  paneHistory?: string[];
}

export interface SearchMatch {
  file_path: string;
  line_number: number;
  line_content: string;
  match_start: number;
  match_end: number;
}

export interface ReplaceOp {
  file_path: string;
  search: string;
  replace: string;
  case_sensitive: boolean;
  whole_word: boolean;
  use_regex: boolean;
}

export interface ReplaceResult {
  files_changed: number;
  replacements: number;
}

export interface WorkspaceLayout {
  root: LayoutNode;
  groups: Record<string, PaneGroup>;
}

export interface LayoutPreset {
  id: string;
  name: string;
  layout: WorkspaceLayout;
  explorerState?: {
    activePathIndex: number;
    expandedPaths: string[];
    /** Repo paths present in the workspace when the preset was saved */
    paths?: string[];
  };
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

export type NavigationDirection = "left" | "right" | "up" | "down";

interface GroupBounds {
  x: number; y: number; w: number; h: number;
}

/** Compute normalized [0,1] bounding rects for every group in the layout tree. */
function computeGroupBounds(
  node: LayoutNode,
  bounds: GroupBounds = { x: 0, y: 0, w: 1, h: 1 },
): Map<string, GroupBounds> {
  if (node.type === "group") {
    return new Map([[node.groupId, bounds]]);
  }
  const { direction, ratio, children } = node;
  let b0: GroupBounds, b1: GroupBounds;
  if (direction === "horizontal") {
    b0 = { x: bounds.x, y: bounds.y, w: bounds.w * ratio, h: bounds.h };
    b1 = { x: bounds.x + bounds.w * ratio, y: bounds.y, w: bounds.w * (1 - ratio), h: bounds.h };
  } else {
    b0 = { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h * ratio };
    b1 = { x: bounds.x, y: bounds.y + bounds.h * ratio, w: bounds.w, h: bounds.h * (1 - ratio) };
  }
  const map = computeGroupBounds(children[0], b0);
  for (const [k, v] of computeGroupBounds(children[1], b1)) map.set(k, v);
  return map;
}

/**
 * Find the neighboring group in a given direction from the active group.
 * Uses spatial bounds to pick the most aligned neighbor — e.g. going down
 * from top-right lands on bottom-right, not bottom-left.
 */
export function findNeighborGroup(
  root: LayoutNode,
  activeGroupId: string,
  direction: NavigationDirection,
): string | null {
  const allBounds = computeGroupBounds(root);
  const active = allBounds.get(activeGroupId);
  if (!active) return null;

  const aCx = active.x + active.w / 2;
  const aCy = active.y + active.h / 2;

  let best: string | null = null;
  let bestPrimary = Infinity;
  let bestOrthogonal = Infinity;

  for (const [groupId, b] of allBounds) {
    if (groupId === activeGroupId) continue;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;

    // Candidate must overlap on the orthogonal axis.
    // For left/right: must share vertical space. For up/down: must share horizontal space.
    const EPS = 1e-9;
    if (direction === "left" || direction === "right") {
      if (b.y + b.h <= active.y + EPS || b.y >= active.y + active.h - EPS) continue;
    } else {
      if (b.x + b.w <= active.x + EPS || b.x >= active.x + active.w - EPS) continue;
    }

    let primary: number;
    let orthogonal: number;
    switch (direction) {
      case "right":  primary = cx - aCx; orthogonal = Math.abs(cy - aCy); break;
      case "left":   primary = aCx - cx; orthogonal = Math.abs(cy - aCy); break;
      case "down":   primary = cy - aCy; orthogonal = Math.abs(cx - aCx); break;
      case "up":     primary = aCy - cy; orthogonal = Math.abs(cx - aCx); break;
    }

    if (primary <= 0) continue; // Not in the requested direction

    // Pick closest in primary direction, then closest orthogonally as tiebreaker
    if (primary < bestPrimary || (primary === bestPrimary && orthogonal < bestOrthogonal)) {
      best = groupId;
      bestPrimary = primary;
      bestOrthogonal = orthogonal;
    }
  }

  return best;
}

// --- Default Layout Factory ---

export function createProductLayout(): WorkspaceLayout {
  const claudePane: Pane = {
    id: crypto.randomUUID(),
    type: "claude-launcher",
    title: "Claude Code",
  };
  const g1: PaneGroup = {
    id: crypto.randomUUID(),
    panes: [claudePane],
    activePaneId: claudePane.id,
  };
  return {
    root: { type: "group", groupId: g1.id },
    groups: { [g1.id]: g1 },
  };
}

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
