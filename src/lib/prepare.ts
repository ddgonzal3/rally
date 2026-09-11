/**
 * Pure decision logic for automatic workspace preparation and agent status.
 * No store access, no Tauri calls — everything here is unit-testable.
 *
 * Facts stay separate on purpose (a lesson from Float):
 *  - agent activity          → `describeAgentActivity`
 *  - watcher / build status  → `scriptRuns` in the workspace store
 *  - usable app exists       → `AppBundleStatus`
 *  - PR / review status      → `prStatuses` in the workspace store
 * Nothing here collapses two of those into one green dot.
 */

import type {
  CheckoutHealth,
  ClaudeSessionInfo,
  PrStatus,
  PrepareEntry,
  RallyConfig,
  ScriptEntry,
} from "./types";
import { isWatcherScript, getDisplayName } from "./scriptNames";
import type { TerminalTitle } from "./ptyActivity";

export { getDisplayName as getDisplayNameSafe };

// --- Preparation config -----------------------------------------------------

export interface PrepareStep {
  script: string;
  /** Ensure-running, never restart, never block. */
  background: boolean;
  /** Safety check that must pass before a blocking step runs. */
  guard: "clean-tree" | "none";
}

export interface ResolvedPrepare {
  steps: PrepareStep[];
  /** True when `prepare` was absent and steps were inferred from the status bar. */
  inferred: boolean;
  branchPrefix: string | null;
  stayOnDefault: boolean;
  appBundle: string | null;
  promptTrailer: string | null;
}

/**
 * Resolve the repo's preparation config. When `prepare` is declared it is
 * the contract, in order. When absent, the status bar is the fallback so
 * repos work before they add the block: `statusBarRight` scripts become
 * blocking steps (that's where sync lives by convention) and watcher-named
 * `statusBar` scripts become background steps. Nothing else is inferred.
 *
 * The first blocking step gets the `clean-tree` guard unless it says otherwise.
 */
export function resolvePrepareConfig(config: RallyConfig | undefined | null): ResolvedPrepare {
  const agent = config?.agent ?? {};
  let steps: PrepareStep[];
  let inferred = false;
  if (config?.prepare) {
    steps = config.prepare.map(normalizeEntry);
  } else {
    inferred = true;
    steps = [
      ...(config?.statusBarRight ?? []).map((script) => ({ script, background: false, guard: "none" as const })),
      ...(config?.statusBar ?? []).filter(isWatcherScript).map((script) => ({ script, background: true, guard: "none" as const })),
    ];
  }
  const firstBlocking = steps.find((s) => !s.background);
  if (firstBlocking && !hasExplicitGuard(config, firstBlocking.script)) {
    firstBlocking.guard = "clean-tree";
  }
  return {
    steps,
    inferred,
    branchPrefix: agent.branchPrefix ?? null,
    stayOnDefault: agent.stayOnDefault ?? false,
    appBundle: agent.appBundle ?? null,
    promptTrailer: agent.promptTrailer ?? null,
  };
}

function normalizeEntry(entry: PrepareEntry): PrepareStep {
  if (typeof entry === "string") return { script: entry, background: false, guard: "none" };
  return { script: entry.script, background: entry.background ?? false, guard: entry.guard ?? "none" };
}

function hasExplicitGuard(config: RallyConfig | undefined | null, script: string): boolean {
  return (config?.prepare ?? []).some((e) => typeof e === "object" && e.script === script && e.guard !== undefined);
}

/** Command string for a status-bar script name, falling back to the name. */
export function commandForScript(name: string, scripts: ScriptEntry[]): string {
  return scripts.find((e) => e.name === name)?.command ?? name;
}

// --- Sync safety -------------------------------------------------------------

export type SyncMode =
  /** Run the guarded script (may hard-reset the branch). */
  | "script"
  /** On the default branch: plain fast-forward pull instead of the script. */
  | "fast-forward"
  /** Nothing to do. */
  | "skip";

export interface SyncAssessment {
  safe: boolean;
  mode: SyncMode;
  reason: string;
}

/**
 * The `clean-tree` guard. Decides whether running the sync procedure could
 * destroy unfinished work. Repo sync scripts are allowed to be destructive
 * (Flow's resets the branch to origin/<default> and force-pushes), so the
 * script only runs when the tree is clean and every local commit is already
 * on the default branch or merged through a PR.
 */
export function assessSyncSafety(input: { health: CheckoutHealth | null; pr: PrStatus | null }): SyncAssessment {
  const { health, pr } = input;
  if (!health) {
    return { safe: false, mode: "skip", reason: "Checkout state unknown — refresh git status and retry." };
  }
  const target = `origin/${health.default_branch}`;
  if (health.dirty) {
    return {
      safe: false,
      mode: "skip",
      reason: `Uncommitted changes to tracked files in ${folderName(health.root)}. Commit, stash, or discard them first.`,
    };
  }
  if (health.branch === health.default_branch) {
    if (health.behind_default > 0) {
      return { safe: true, mode: "fast-forward", reason: `${health.behind_default} behind ${target}` };
    }
    return { safe: true, mode: "skip", reason: `Already at ${target}` };
  }
  if (health.ahead_of_default > 0 && pr?.state !== "MERGED") {
    const prNote = pr && pr.state === "OPEN" ? ` (PR #${pr.number} still open)` : "";
    return {
      safe: false,
      mode: "skip",
      reason: `${health.ahead_of_default} local commit${health.ahead_of_default === 1 ? "" : "s"} on ${health.branch} not on ${target}${prNote}. Sync would discard them.`,
    };
  }
  if (health.behind_default === 0 && health.ahead_of_default === 0) {
    return { safe: true, mode: "skip", reason: `Already up to date with ${target}` };
  }
  return { safe: true, mode: "script", reason: `${health.behind_default} behind ${target}` };
}

// --- Projects & free checkouts -----------------------------------------------

/** Project identity from an origin URL: `github.com/splice/flow.git` → `flow`. */
export function projectFromOrigin(originUrl: string, fallbackPath: string): string {
  const trimmed = originUrl.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const last = trimmed.split(/[/:]/).pop();
  return last && last.length > 0 ? last : folderName(fallbackPath);
}

export interface CheckoutCandidate {
  cwd: string;
  /** A Claude session is running in a pod for this checkout. */
  busy: boolean;
  dirty: boolean;
  pr: PrStatus | null;
  /** An idle pod already exists for this checkout (preferred: no new panel). */
  hasPod: boolean;
}

export interface CheckoutPick {
  cwd: string | null;
  /** Why each candidate was rejected, in order. Empty when one was picked. */
  reasons: { cwd: string; reason: string }[];
}

/**
 * Free = no live Claude session, clean tree, no open PR. Prefer a checkout
 * that already has an idle pod so no extra panel appears; otherwise the
 * first free one in workspace order.
 */
export function pickFreeCheckout(candidates: CheckoutCandidate[]): CheckoutPick {
  const reasons: { cwd: string; reason: string }[] = [];
  const free: CheckoutCandidate[] = [];
  for (const c of candidates) {
    if (c.busy) reasons.push({ cwd: c.cwd, reason: "agent running" });
    else if (c.pr?.state === "OPEN") reasons.push({ cwd: c.cwd, reason: `PR #${c.pr.number} open` });
    else if (c.dirty) reasons.push({ cwd: c.cwd, reason: "uncommitted changes" });
    else free.push(c);
  }
  const pick = free.find((c) => c.hasPod) ?? free[0] ?? null;
  return { cwd: pick?.cwd ?? null, reasons: pick ? [] : reasons };
}

// --- Branch names --------------------------------------------------------------

/** `Fix the export bug!` → `fix-the-export-bug`, capped, no leading/trailing dashes. */
export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "task";
}

/** Default task-branch prefix: the git user's first name, lowercased. */
export function defaultBranchPrefix(userName: string): string {
  const first = userName.trim().split(/\s+/)[0] ?? "";
  const slug = slugify(first, 24);
  return `${slug === "task" ? "agent" : slug}/`;
}

export function taskBranchName(prefix: string, description: string, taken: string[]): string {
  const base = `${prefix}${slugify(shortDescription(description, 60))}`;
  return uniqueBranch(base, taken);
}

/** Placeholder for a reset with no task yet: `danny/flow3-0910`. */
export function placeholderBranchName(prefix: string, agentName: string, date: Date, taken: string[]): string {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return uniqueBranch(`${prefix}${slugify(agentName, 20)}-${mm}${dd}`, taken);
}

function uniqueBranch(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** True for a branch Rally created as a placeholder (`<prefix><name>-MMDD[-n]`). */
export function isPlaceholderBranch(branch: string, prefix: string): boolean {
  if (!branch.startsWith(prefix)) return false;
  return /-\d{4}(-\d+)?$/.test(branch.slice(prefix.length));
}

// --- Prompt ------------------------------------------------------------------

export function folderName(path: string): string {
  return path.replace(/\/$/, "").split("/").pop() || path;
}

/** First line of the description, trimmed, for row labels. */
export function shortDescription(description: string, max = 80): string {
  const line = description.trim().split("\n")[0]?.trim() ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

/**
 * The delivered prompt: the task, then checkout facts. The trailer is
 * deliberately generic — repo-specific instructions belong in the repo's
 * own CLAUDE.md or `agent.promptTrailer`.
 */
export function buildTaskPrompt(input: {
  description: string;
  kind: "work" | "question";
  cwd: string;
  branch: string | null;
  trailer: string | null;
}): string {
  const body = input.description.trim();
  const where = `${input.cwd}${input.branch ? ` (branch ${input.branch})` : ""}`;
  if (input.kind === "question") {
    return `${body}\n\nAnswer from the checkout at ${where}. Read only — do not modify files, run builds, or open a PR.`;
  }
  const trailer =
    input.trailer !== null
      ? input.trailer.trim()
      : `Work in the checkout at ${where}. Make changes there directly — never create or switch into a nested worktree.`;
  return trailer ? `${body}\n\n${trailer}` : body;
}

// --- Agent activity ----------------------------------------------------------

export type AgentActivityState = "working" | "waiting" | "idle" | "quiet" | "no-session";

export interface AgentActivity {
  state: AgentActivityState;
  label: string;
  detail?: string;
  /** The user should look at this panel. */
  attention: boolean;
  /** Source of truth used. `session` = Claude's own status file. */
  source: "session" | "terminal" | "none";
}

const RECENT_OUTPUT_MS = 3000;

/**
 * Derive activity from the best available signal. Silence never becomes
 * "done"; without a session file it is at most "quiet".
 */
export function describeAgentActivity(input: {
  session: ClaudeSessionInfo | null;
  claudeForeground: boolean;
  title: TerminalTitle | null;
  lastOutputAt: number | null;
  bellPending: boolean;
  now: number;
}): AgentActivity {
  const { session, claudeForeground, title, lastOutputAt, bellPending, now } = input;
  if (session) {
    switch (session.status) {
      case "busy":
        return { state: "working", label: "Working", attention: false, source: "session" };
      case "waiting":
        return {
          state: "waiting",
          label: "Needs input",
          detail: session.waiting_for ?? undefined,
          attention: true,
          source: "session",
        };
      case "idle":
        return {
          state: "idle",
          label: "Idle",
          detail: "Turn finished — check the terminal",
          attention: bellPending,
          source: "session",
        };
      default:
        break;
    }
  }
  if (claudeForeground || (title && title.claude !== "none")) {
    const recent = lastOutputAt !== null && now - lastOutputAt < RECENT_OUTPUT_MS;
    if (title?.claude === "busy" || recent) {
      return { state: "working", label: "Working", attention: false, source: "terminal" };
    }
    if (title?.claude === "idle") {
      return { state: "idle", label: "Idle", detail: "Turn finished — check the terminal", attention: bellPending, source: "terminal" };
    }
    return { state: "quiet", label: "Quiet", detail: "No output; session state unknown", attention: bellPending, source: "terminal" };
  }
  return { state: "no-session", label: "No session", attention: false, source: "none" };
}

// --- Checkout mismatches -----------------------------------------------------

function normPath(p: string): string {
  return p.replace(/\/+$/, "");
}

export interface CheckoutMismatch {
  kind: "session-cwd" | "nested-worktrees";
  /** One short line for the sidebar row. */
  short: string;
  /** Full explanation for the footer toast / tooltip. */
  detail: string;
}

/**
 * Reasons the terminal, watcher, native build and launched app might not be
 * looking at the same tree. Empty when everything lines up. Nested
 * worktrees are folded into one item so a checkout with five stale agent
 * worktrees reads as one warning, not five.
 */
export function checkoutMismatches(input: {
  podCwd: string;
  session: ClaudeSessionInfo | null;
  health: CheckoutHealth | null;
}): CheckoutMismatch[] {
  const out: CheckoutMismatch[] = [];
  const pod = normPath(input.podCwd);
  const sessionCwd = input.session?.cwd ? normPath(input.session.cwd) : null;
  if (sessionCwd && sessionCwd !== pod) {
    const inside = sessionCwd.startsWith(pod + "/");
    const inNestedWorktree = inside && sessionCwd.includes("/.claude/worktrees/");
    if (!inside || inNestedWorktree) {
      out.push({
        kind: "session-cwd",
        short: `Claude runs in ${folderName(sessionCwd)}`,
        detail: `Claude runs in ${shortPath(sessionCwd)}; watcher and Run build ${folderName(pod)}.`,
      });
    }
  }
  const active = (input.health?.worktrees ?? []).filter((wt) => wt.nested && (wt.locked !== null || wt.dirty));
  if (active.length > 0) {
    const names = active.map(
      (wt) =>
        `${folderName(wt.path)} on ${wt.branch ?? wt.head.slice(0, 7)}${wt.locked ? ` (${wt.locked.split(" (")[0]})` : wt.dirty ? " (uncommitted changes)" : ""}`,
    );
    out.push({
      kind: "nested-worktrees",
      short: active.length === 1 ? `Nested worktree active: ${folderName(active[0].path)}` : `${active.length} nested worktrees active`,
      detail: `Nested worktree${active.length === 1 ? "" : "s"} inside ${folderName(pod)}: ${names.join("; ")}. Edits there are not what the watcher builds.`,
    });
  }
  return out;
}

export function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~");
}

/** Relative age like "3m ago" / "2h ago". */
export function formatAge(unixSecs: number | null | undefined, nowMs: number = Date.now()): string {
  if (!unixSecs) return "unknown";
  const diff = Math.max(0, Math.floor(nowMs / 1000) - unixSecs);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
