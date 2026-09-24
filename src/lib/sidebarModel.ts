/**
 * Row model for the agent sidebar. Pure: no store access, no React.
 *
 * Per project you can work in: one project row with a count of free
 * checkouts and a chevron. Collapsed, the rows that matter now show: every
 * visible panel, agents needing you, failed preparation, open PRs. Expanded,
 * every checkout shows as a row (one per open Claude panel, or one bare
 * row when the checkout has no panel), so nothing is ever unreachable.
 */

import type { PodTask, PrStatus } from "./types";
import type { AgentActivity, CheckoutMismatch } from "./prepare";
import { folderName, projectFromOrigin } from "./prepare";

// --- Inputs ------------------------------------------------------------------

export interface SidebarPodInput {
  id: string;
  type: "claude" | "terminal";
  cwd: string;
  name: string;
  hidden: boolean;
  task: PodTask | undefined;
  activity: AgentActivity;
  /** Claude Code's live topic title, from the terminal title. */
  topic: string | null;
  /** `startedAt` (ms) of the live Claude session, when its file is known. */
  sessionStartedAt: number | null;
  mismatches: CheckoutMismatch[];
}

export interface SidebarCheckoutInput {
  cwd: string;
  origin: string;
  branch: string | null;
  dirty: boolean;
  manualBusy?: boolean;
  /** A Claude here (any terminal) has a conversation, even if idle. */
  inConversation?: boolean;
  label?: string;
  pr: PrStatus | null;
}

export interface SidebarModelInput {
  /** Workspace checkouts, in workspace order. */
  paths: string[];
  checkouts: Record<string, SidebarCheckoutInput | undefined>;
  /** Pods in layout order. */
  pods: SidebarPodInput[];
}

// --- Outputs -----------------------------------------------------------------

/** Precedence when several pods share a checkout: waiting > working > in-use > review > dirty > available. */
export type CheckoutState = "waiting" | "working" | "in-use" | "review" | "dirty" | "available";

export interface CheckoutEntry {
  cwd: string;
  name: string;
  state: CheckoutState;
  branch: string | null;
  pr: PrStatus | null;
}

export type AgentDot = "working" | "waiting" | null;

export interface AgentEntry {
  /** Null for a checkout with no panel (click starts a task there, or opens its PR). */
  podId: string | null;
  /** Free to take a task (no panel active, clean, no open PR). */
  available: boolean;
  cwd: string;
  name: string;
  hidden: boolean;
  manualBusy?: boolean;
  label?: string;
  dot: AgentDot;
  /** Live activity only; never a saved prompt or branch name. */
  secondary: string;
  /** Latest terminal topic, available on hover rather than in the row. */
  topic?: string;
  /** Shown once, as the pill. Only on the first row of a checkout. */
  pr: PrStatus | null;
  /** One quiet mark; the tooltip carries the details. */
  problem: { short: string; detail: string } | null;
  preparing: boolean;
}

export interface ProjectEntry {
  project: string;
  checkouts: CheckoutEntry[];
  available: number;
  /** Every row: one per open Claude panel, plus one bare row per checkout without a panel. */
  rows: AgentEntry[];
  /** Rows shown while collapsed: any visible panel, plus a dot, a problem, or an open PR. */
  active: AgentEntry[];
  /** Single checkout with exactly one row: draw that row alone, named after the project. */
  merged: boolean;
}

// --- Model -------------------------------------------------------------------

export function buildSidebarModel(input: SidebarModelInput): ProjectEntry[] {
  const byProject = new Map<string, string[]>();
  for (const cwd of input.paths) {
    const project = projectFromOrigin(input.checkouts[cwd]?.origin ?? "", cwd);
    if (!byProject.has(project)) byProject.set(project, []);
    byProject.get(project)!.push(cwd);
  }
  // Pods on a checkout the workspace no longer lists still need a home.
  for (const pod of input.pods) {
    if (input.paths.includes(pod.cwd)) continue;
    const project = projectFromOrigin(input.checkouts[pod.cwd]?.origin ?? "", pod.cwd);
    if (!byProject.has(project)) byProject.set(project, []);
    const cwds = byProject.get(project)!;
    if (!cwds.includes(pod.cwd)) cwds.push(pod.cwd);
  }

  return [...byProject.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([project, cwds]) => buildProject(project, cwds, input));
}

function buildProject(project: string, cwds: string[], input: SidebarModelInput): ProjectEntry {
  const checkouts: CheckoutEntry[] = [];
  const rows: AgentEntry[] = [];

  for (const cwd of cwds) {
    const checkout = input.checkouts[cwd];
    const branch = checkout?.branch ?? null;
    const claudePods = input.pods.filter((p) => p.cwd === cwd && p.type === "claude");
    const here = claudePods.map((p) => agentRow(p));
    if (here.length === 0) {
      here.push({
        podId: null,
        available: false,
        cwd,
        name: folderName(cwd),
        hidden: false,
        dot: null,
        secondary: "",
        pr: null,
        problem: null,
        preparing: false,
      });
    }

    const prOpen = checkout?.pr?.state === "OPEN" ? checkout.pr : null;
    if (prOpen) here[0].pr = prOpen;

    const state = checkoutState(here, checkout);
    for (const r of here) {
      r.available = state === "available";
      r.manualBusy = checkout?.manualBusy ?? false;
      r.label = checkout?.label || undefined;
      // A custom panel title must never obscure which checkout this is.
      r.name = folderName(cwd);
    }
    rows.push(...here);
    checkouts.push({ cwd, name: folderName(cwd), state, branch, pr: prOpen });
  }

  const available = checkouts.filter((c) => c.state === "available").length;
  // Every panel keeps its row, hidden ones too (shift-click hides a panel;
  // its row is the way back). Only bare checkouts wait in the expanded list.
  const active = rows.filter((r) => r.podId !== null || r.dot !== null || r.problem !== null || r.pr !== null || r.manualBusy || r.label);
  const merged = checkouts.length === 1 && rows.length === 1;
  if (merged && folderName(cwds[0]) === project) rows[0].name = project;
  return { project, checkouts, available, rows, active, merged };
}

/**
 * One row per open Claude panel. Dot amber while working or preparing,
 * waiting is retained as a model state for checkout availability, but the UI
 * uses plain status text rather than a blue dot.
 */
function agentRow(pod: SidebarPodInput): AgentEntry {
  const prep = pod.task?.prep;
  const preparing = prep?.status === "running";
  const working = pod.activity.state === "working" || preparing;
  const needsYou = pod.activity.state === "waiting" || (pod.activity.state === "idle" && pod.activity.attention);
  const dot: AgentDot = needsYou ? "waiting" : working ? "working" : null;

  const problem = firstProblem(pod);
  const secondary = problem?.short ?? (preparing
    ? (prep?.steps.find((s) => s.status === "running")?.label ?? "Preparing") + "…"
    : pod.activity.state === "waiting" ? "Needs your input"
    : working ? "Working"
    : needsYou ? "Ready for review"
    : pod.activity.state === "idle" ? "Idle" : "");

  return {
    podId: pod.id,
    available: false,
    cwd: pod.cwd,
    name: pod.name,
    hidden: pod.hidden,
    dot,
    secondary,
    topic: pod.activity.state !== "no-session" && pod.topic && pod.topic !== "Claude Code" ? pod.topic : undefined,
    pr: null,
    problem,
    preparing,
  };
}

function firstProblem(pod: SidebarPodInput): AgentEntry["problem"] {
  const prep = pod.task?.prep;
  if (prep && (prep.status === "failed" || prep.status === "interrupted")) {
    const step = prep.steps.find((s) => s.status === "failed");
    const short = step ? `${step.label} failed` : "Preparation failed";
    return { short, detail: step?.detail ? `${short}\n${step.detail}` : short };
  }
  const m = pod.mismatches[0];
  if (m) return { short: m.short, detail: pod.mismatches.map((x) => x.detail).join("\n") };
  return null;
}

function checkoutState(rows: AgentEntry[], checkout: SidebarCheckoutInput | undefined): CheckoutState {
  if (rows.some((r) => r.dot === "waiting")) return "waiting";
  if (checkout?.manualBusy) return "working";
  if (rows.some((r) => r.dot === "working")) return "working";
  if (checkout?.inConversation) return "in-use";
  if (checkout?.pr?.state === "OPEN") return "review";
  if (checkout?.dirty) return "dirty";
  return "available";
}
