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
import { folderName, projectFromOrigin, shortDescription } from "./prepare";

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

/** Precedence when several pods share a checkout: waiting > working > review > dirty > available. */
export type CheckoutState = "waiting" | "working" | "review" | "dirty" | "available";

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
  dot: AgentDot;
  /** Second line: the task while its session is the live one, else Claude's live topic, else the branch. */
  secondary: string;
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
    const here = claudePods.map((p) => agentRow(p, branch));
    if (here.length === 0) {
      here.push({
        podId: null,
        available: false,
        cwd,
        name: folderName(cwd),
        hidden: false,
        dot: null,
        secondary: branch ?? "",
        pr: null,
        problem: null,
        preparing: false,
      });
    }

    const prOpen = checkout?.pr?.state === "OPEN" ? checkout.pr : null;
    if (prOpen) here[0].pr = prOpen;

    const state = checkoutState(here, checkout);
    for (const r of here) r.available = state === "available";
    rows.push(...here);
    checkouts.push({ cwd, name: folderName(cwd), state, branch, pr: prOpen });
  }

  const available = checkouts.filter((c) => c.state === "available").length;
  // A panel you can see on the canvas is never missing from the sidebar;
  // hidden idle panels and bare checkouts wait in the expanded list.
  const active = rows.filter((r) => (r.podId !== null && !r.hidden) || r.dot !== null || r.problem !== null || r.pr !== null);
  const merged = checkouts.length === 1 && rows.length === 1;
  if (merged) rows[0].name = project;
  return { project, checkouts, available, rows, active, merged };
}

/**
 * One row per open Claude panel. Dot amber while working or preparing,
 * blue when it needs you (waiting for input, or a finished turn you have
 * not looked at yet), none when idle.
 */
function agentRow(pod: SidebarPodInput, branch: string | null): AgentEntry {
  const prep = pod.task?.prep;
  const preparing = prep?.status === "running";
  const working = pod.activity.state === "working" || preparing;
  const needsYou = pod.activity.state === "waiting" || (pod.activity.state === "idle" && pod.activity.attention);
  const dot: AgentDot = needsYou ? "waiting" : working ? "working" : null;

  const description = pod.task && pod.task.kind !== "reset" && taskIsCurrent(pod) ? shortDescription(pod.task.description) : "";
  const liveTopic = pod.topic && pod.topic !== "Claude Code" ? pod.topic : "";

  return {
    podId: pod.id,
    available: false,
    cwd: pod.cwd,
    name: pod.name,
    hidden: pod.hidden,
    dot,
    secondary: description || liveTopic || branch || "",
    pr: null,
    problem: firstProblem(pod),
    preparing,
  };
}

/** Grace between hand-over and the launched session registering itself. */
const SESSION_START_SLACK_MS = 60_000;

/**
 * The task record describes the conversation Rally delivered. It stops
 * being true once that session is gone (Claude exited) or a newer session
 * runs in the panel (you started `claude` again by hand). A session that
 * predates the hand-over is the reused REPL that received it.
 */
function taskIsCurrent(pod: SidebarPodInput): boolean {
  const task = pod.task!;
  if (task.prep.status === "running" || task.prep.status === "failed" || task.prep.status === "interrupted") return true;
  switch (pod.activity.source) {
    case "none":
      return false;
    case "terminal":
      return true;
    case "session":
      if (pod.sessionStartedAt === null) return true;
      return pod.sessionStartedAt <= (task.deliveredAt ?? task.createdAt) + SESSION_START_SLACK_MS;
  }
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
  if (rows.some((r) => r.dot === "working")) return "working";
  if (checkout?.pr?.state === "OPEN") return "review";
  if (checkout?.dirty) return "dirty";
  return "available";
}
