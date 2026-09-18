/**
 * Automatic preparation runner for a pod task.
 *
 * Steps come from the repo's `prepare` list (see `resolvePrepareConfig`),
 * then a branch step, then delivery. Every script this starts goes through
 * the normal `runScript` / `ensureScriptRunning` path, so it shows up in the
 * pod footer with the same stop/restart/hover-output controls as a manual
 * run — there is no second status surface.
 *
 * Guarantees:
 *  - Preparation runs at most once per task; retries resume from the first
 *    step that is not done/skipped.
 *  - Background steps are ensured running, never restarted, never blocking.
 *  - A `clean-tree` guarded step only runs when `assessSyncSafety` says no
 *    unmerged work can be lost.
 *  - Follow-up messages (`deliverPromptToPod`) never trigger preparation.
 */
import { useCheckoutStore, assertCheckoutAvailable } from "../stores/checkoutStore";
import { api } from "./tauri";
import type { ClaudeModel, FlightPod, PodTask, PrepStep, PrepStepStatus, PrStatus } from "./types";
import {
  assessSyncSafety,
  buildTaskPrompt,
  commandForScript,
  defaultBranchPrefix,
  folderName,
  getDisplayNameSafe,
  isPlaceholderBranch,
  pickFreeCheckout,
  placeholderBranchName,
  projectFromOrigin,
  resolvePrepareConfig,
  taskBranchName,
  type CheckoutCandidate,
  type ResolvedPrepare,
} from "./prepare";
import { useWorkspaceStore, getPodMainPtyIds, ptyLastOutputAt } from "../stores/workspaceStore";
import { useAgentStore } from "../stores/agentStore";
import { ptyTerminalTitles } from "./ptyActivity";

const SCRIPT_SETTLE_TIMEOUT_MS = 10 * 60 * 1000;

/** Model ids Claude Code accepts for `--model` and `/model`. */
export const CLAUDE_MODEL_IDS: Record<ClaudeModel, string> = {
  fable: "claude-fable-5-1",
  opus: "claude-opus-5",
};
const running = new Set<string>();

// --- Pod / task accessors ----------------------------------------------------

function getPod(workspaceId: string, podId: string): FlightPod | undefined {
  return useWorkspaceStore.getState().flightLayouts[workspaceId]?.pods.find((p) => p.id === podId);
}

function patchTask(workspaceId: string, podId: string, fn: (task: PodTask) => PodTask): PodTask | undefined {
  const pod = getPod(workspaceId, podId);
  if (!pod?.task) return undefined;
  const next = fn(pod.task);
  useWorkspaceStore.getState().setPodTask(workspaceId, podId, next);
  return next;
}

function setStep(workspaceId: string, podId: string, id: string, patch: StepOutcome): void {
  patchTask(workspaceId, podId, (task) => ({
    ...task,
    prep: { ...task.prep, steps: task.prep.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) },
  }));
}

type StepOutcome = Partial<Omit<PrepStep, "id" | "kind">> & { status: PrepStepStatus };

// --- Config ----------------------------------------------------------------------

async function loadResolved(cwd: string): Promise<ResolvedPrepare> {
  const store = useWorkspaceStore.getState();
  if (!store.rallyConfigs[cwd]) await store.loadRallyConfig(cwd);
  return resolvePrepareConfig(useWorkspaceStore.getState().rallyConfigs[cwd]);
}

/** Step list for a new task, from the repo's config. */
export async function buildTaskSteps(cwd: string, kind: PodTask["kind"]): Promise<PrepStep[]> {
  if (kind === "question") return [{ id: "deliver", kind: "deliver", label: "Deliver", status: "pending" }];
  const resolved = await loadResolved(cwd);
  // Deliver FIRST: the agent starts reading code while sync and watchers
  // run. A sync reset moves the tree under it, which is acceptable — waiting
  // a minute for a fetch before typing was not.
  const steps: PrepStep[] = [];
  if (kind === "work") steps.push({ id: "deliver", kind: "deliver", label: "Deliver", status: "pending" });
  for (const s of resolved.steps) {
    steps.push({
      id: s.script,
      kind: "script",
      label: getDisplayNameSafe(s.script),
      status: "pending",
      background: s.background,
      scriptName: s.script,
    });
  }
  if (!resolved.stayOnDefault) steps.push({ id: "branch", kind: "branch", label: "Branch", status: "pending" });
  return steps;
}

// --- Script helpers ----------------------------------------------------------

function scriptKey(rootPath: string, scriptName: string): string {
  return `${rootPath}:${scriptName}`;
}

/** Resolve once a one-shot script settles (success/error/stopped/gone). */
function waitForScriptSettled(key: string, timeoutMs: number): Promise<"success" | "error" | "stopped" | "gone" | "timeout"> {
  return new Promise((resolve) => {
    let unsub: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (v: "success" | "error" | "stopped" | "gone" | "timeout") => {
      unsub?.();
      if (timer) clearTimeout(timer);
      resolve(v);
    };
    const check = () => {
      const run = useWorkspaceStore.getState().scriptRuns[key];
      if (!run) return finish("gone");
      if (run.status === "success" || run.status === "error" || run.status === "stopped") return finish(run.status);
    };
    unsub = useWorkspaceStore.subscribe(check);
    timer = setTimeout(() => finish("timeout"), timeoutMs);
    check();
  });
}

// --- Live session detection --------------------------------------------------

export type PodClaudeState = "working" | "idle" | "none";

/**
 * What Claude is doing in a pod. `working` = a turn is running or it is
 * waiting on you; `idle` = the REPL is open at its prompt (reusable);
 * `none` = no Claude process. Session file first, terminal signals second.
 */
export async function podClaudeState(podId: string): Promise<{ state: PodClaudeState; ptyId: string | null }> {
  const sessions = useAgentStore.getState().sessionsByPty;
  for (const id of getPodMainPtyIds(podId)) {
    const session = sessions[id];
    if (session) {
      return { state: session.status === "busy" || session.status === "waiting" ? "working" : "idle", ptyId: id };
    }
    let fg: string | null = null;
    try {
      fg = await api.getPtyForegroundProcess(id);
    } catch {
      continue;
    }
    if ((fg ?? "").toLowerCase() !== "claude") continue;
    const title = ptyTerminalTitles.get(id);
    const lastOut = ptyLastOutputAt.get(id);
    const working = title?.claude === "busy" || (lastOut !== undefined && Date.now() - lastOut < 3000);
    return { state: working ? "working" : "idle", ptyId: id };
  }
  return { state: "none", ptyId: null };
}

/** PTY id of the pod's live Claude session (working or idle), if any. */
export async function findLiveClaudePty(podId: string): Promise<string | null> {
  return (await podClaudeState(podId)).ptyId;
}

// --- Projects & free checkouts ----------------------------------------------

export interface ProjectInfo {
  project: string;
  cwds: string[];
}

/** Group the workspace's checkouts by origin repo. Order follows workspace paths. */
export function listProjects(workspaceId: string): ProjectInfo[] {
  const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId);
  const health = useAgentStore.getState().health;
  const out: ProjectInfo[] = [];
  for (const cwd of ws?.paths ?? []) {
    const project = projectFromOrigin(health[cwd]?.origin_url ?? "", cwd);
    const existing = out.find((p) => p.project === project);
    if (existing) existing.cwds.push(cwd);
    else out.push({ project, cwds: [cwd] });
  }
  return out;
}

/** Candidates for a project with live busy/dirty/PR facts. */
export async function checkoutCandidates(workspaceId: string, cwds: string[]): Promise<CheckoutCandidate[]> {
  // Fresh session facts — the 2s poll can lag a Claude that just went idle.
  await useAgentStore.getState().refreshSessions();
  const store = useWorkspaceStore.getState();
  const agent = useAgentStore.getState();
  const pods = store.flightLayouts[workspaceId]?.pods ?? [];
  const out: CheckoutCandidate[] = [];
  for (const cwd of cwds) {
    const podsHere = pods.filter((p) => p.type === "claude" && p.cwd === cwd);
    let busy = !!useCheckoutStore.getState().notes[cwd]?.busy;
    for (const p of podsHere) {
      if ((await podClaudeState(p.id)).state === "working") {
        busy = true;
        break;
      }
    }
    const health = agent.health[cwd];
    const dirty = health?.dirty ?? store.gitStatuses[cwd]?.dirty ?? false;
    out.push({ cwd, busy, manualBusy: !!useCheckoutStore.getState().notes[cwd]?.busy, dirty, pr: store.prStatuses[cwd] ?? null, hasPod: podsHere.length > 0 });
  }
  return out;
}

/** Pick a free checkout for a project, or explain why none is. */
export async function findFreeCheckout(workspaceId: string, project: string): Promise<ReturnType<typeof pickFreeCheckout>> {
  const info = listProjects(workspaceId).find((p) => p.project === project);
  if (!info) return { cwd: null, reasons: [] };
  return pickFreeCheckout(await checkoutCandidates(workspaceId, info.cwds));
}

// --- Delivery ----------------------------------------------------------------

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Hand a prompt to the pod: type it into the live Claude session when there
 * is one (bracketed paste, then Enter, so multi-line text stays one message),
 * otherwise launch Claude with the prompt as its first message.
 */
export async function deliverPromptToPod(
  workspaceId: string,
  podId: string,
  prompt: string,
  options: { clearFirst?: boolean; model?: ClaudeModel } = {},
): Promise<"typed" | "launched"> {
  const store = useWorkspaceStore.getState();
  const pod = getPod(workspaceId, podId);
  if (!pod) throw new Error("Pod no longer exists");

  // Delivery must work even when the destination was minimized or its tab hidden.
  if (pod.stashed) store.unstashPod(workspaceId, podId);
  store.setWorkspaceMode(workspaceId, "flight");
  store.bringPodToFront(workspaceId, podId);
  setTimeout(() => window.dispatchEvent(new CustomEvent("flight-focus-pod", { detail: { workspaceId, podId } })), 60);
  await useAgentStore.getState().refreshSessions();
  const live = await podClaudeState(podId);
  if (options.clearFirst && live.state === "working") {
    throw new Error("Claude is busy. Wait for the current turn before starting a new task.");
  }
  // A new task already requests a fresh conversation. Launch with its prompt
  // and model as arguments instead of racing slash commands against the REPL.
  if (options.clearFirst && live.ptyId) await stopPodClaude(podId);
  const livePty = options.clearFirst ? null : live.ptyId;
  if (livePty) {
    const layoutId = `flight:${podId}`;
    for (const [groupId, group] of Object.entries(store.layouts[layoutId]?.groups ?? {})) {
      const pane = group.panes.find((p) => p.ptyId === livePty);
      if (pane) store.setActivePane(layoutId, groupId, pane.id);
    }
    await api.writePtyString(livePty, BRACKETED_PASTE_START + prompt + BRACKETED_PASTE_END);
    await new Promise((r) => setTimeout(r, 500));
    await api.writePtyString(livePty, "\r");
    return "typed";
  }

  const layoutId = `flight:${podId}`;
  const layout = store.getOrCreatePodLayout(layoutId, pod.cwd, "claude");
  const groupId = Object.keys(layout.groups)[0];
  const group = layout.groups[groupId];
  const modelFlag = options.model ? ` --model ${CLAUDE_MODEL_IDS[options.model]}` : "";
  const command = `claude --dangerously-skip-permissions${modelFlag} ${shellQuote(prompt)}`;

  // Start here, not as a side effect of mounting a visible Terminal component.
  // A failed spawn rejects delivery and leaves the preparation step retryable.
  const ptyId = await api.spawnPty(pod.cwd, command, 100, 30);
  if (!getPod(workspaceId, podId)) {
    await api.killPty(ptyId);
    throw new Error("Panel was removed before Claude could start");
  }
  const active = group.panes.find((p) => p.id === group.activePaneId) ?? group.panes[0];
  const replaceable = active && (active.type === "claude-launcher" || active.type === "claude");
  if (replaceable) {
    if (active.type === "claude" && active.ptyId) {
      // The old shell is at a prompt (Claude exited). Retire it rather than
      // typing into a shell we cannot see the state of.
      await api.killPty(active.ptyId).catch(() => {});
    }
    store.transformPane(layoutId, groupId, active.id, {
      type: "claude",
      title: "Claude Code",
      command,
      ptyId,
      initialInput: undefined,
    });
    store.setActivePane(layoutId, groupId, active.id);
  } else {
    store.addPaneToGroup(layoutId, groupId, {
      id: crypto.randomUUID(),
      type: "claude",
      title: "Claude Code",
      command,
      ptyId,
      cwd: pod.cwd,
    });
  }
  return "launched";
}

/** Kill the pod's Claude session(s); the pod, task and shell tabs stay. */
export async function stopPodClaude(podId: string): Promise<void> {
  const store = useWorkspaceStore.getState();
  const layoutId = `flight:${podId}`;
  const layout = store.layouts[layoutId];
  if (!layout) return;
  for (const [groupId, group] of Object.entries(layout.groups)) {
    for (const pane of group.panes) {
      if (pane.type !== "claude") continue;
      if (pane.ptyId) await api.killPty(pane.ptyId).catch(() => {});
      store.transformPane(layoutId, groupId, pane.id, {
        type: "claude-launcher",
        title: "Claude Code",
        command: undefined,
        ptyId: undefined,
        initialInput: undefined,
      });
    }
  }
}

// --- Preparation -------------------------------------------------------------

/** Mark a step skipped and continue preparation from there. */
export async function resumePrepStep(workspaceId: string, podId: string, id: string): Promise<void> {
  setStep(workspaceId, podId, id, { status: "skipped", detail: "Skipped by you" });
  await runTaskPreparation(workspaceId, podId);
}

export async function runTaskPreparation(workspaceId: string, podId: string): Promise<void> {
  if (running.has(podId)) return;
  const pod = getPod(workspaceId, podId);
  const task = pod?.task;
  if (!pod || !task) return;
  if (task.prep.status === "done") return;
  running.add(podId);

  patchTask(workspaceId, podId, (t) => ({
    ...t,
    prep: {
      ...t.prep,
      status: "running",
      startedAt: t.prep.startedAt ?? Date.now(),
      finishedAt: undefined,
      steps: t.prep.steps.map((s) => (s.status === "failed" ? { ...s, status: "pending", detail: undefined } : s)),
    },
  }));

  try {
    for (const step of task.prep.steps) {
      const current = getPod(workspaceId, podId)?.task?.prep.steps.find((s) => s.id === step.id);
      if (!current || current.status === "done" || current.status === "skipped") continue;
      setStep(workspaceId, podId, step.id, { status: "running", detail: undefined });
      const outcome = await runStep(workspaceId, podId, current);
      setStep(workspaceId, podId, step.id, outcome);
      if (outcome.status === "failed" && !current.background) {
        patchTask(workspaceId, podId, (t) => ({ ...t, prep: { ...t.prep, status: "failed", finishedAt: Date.now() } }));
        return;
      }
    }
    patchTask(workspaceId, podId, (t) => ({ ...t, prep: { ...t.prep, status: "done", finishedAt: Date.now() } }));
    // A reset has no conversation to keep; drop the record once it succeeded.
    if (task.kind === "reset") useWorkspaceStore.getState().setPodTask(workspaceId, podId, undefined);
  } catch (e) {
    const runningStep = getPod(workspaceId, podId)?.task?.prep.steps.find((s) => s.status === "running");
    if (runningStep) setStep(workspaceId, podId, runningStep.id, { status: "failed", detail: String(e) });
    patchTask(workspaceId, podId, (t) => ({ ...t, prep: { ...t.prep, status: "failed", finishedAt: Date.now() } }));
  } finally {
    running.delete(podId);
  }
}

async function runStep(workspaceId: string, podId: string, step: PrepStep): Promise<StepOutcome> {
  const pod = getPod(workspaceId, podId);
  if (!pod?.task) return { status: "failed", detail: "Task disappeared" };
  const cwd = pod.cwd;
  const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId);
  const mainBranch = ws?.main_branch ?? "main";
  const resolved = await loadResolved(cwd);

  assertCheckoutAvailable(cwd);
  switch (step.kind) {
    case "script": {
      const cfg = resolved.steps.find((s) => s.script === step.scriptName);
      return runScriptStep(cwd, mainBranch, step.scriptName ?? step.id, cfg?.background ?? !!step.background, cfg?.guard ?? "none");
    }
    case "branch":
      return runBranchStep(cwd, mainBranch, resolved, pod);
    case "deliver": {
      const branch = useWorkspaceStore.getState().gitStatuses[cwd]?.branch ?? pod.task.branch ?? null;
      const prompt =
        pod.task.prompt ||
        buildTaskPrompt({
          description: pod.task.description,
          kind: pod.task.kind === "question" ? "question" : "work",
          cwd,
          branch,
          trailer: resolved.promptTrailer,
          attachments: pod.task.attachments,
        });
      patchTask(workspaceId, podId, (t) => ({ ...t, prompt, branch: branch ?? t.branch }));
      const mode = await deliverPromptToPod(workspaceId, podId, prompt, { clearFirst: true, model: pod.task.model });
      patchTask(workspaceId, podId, (t) => ({ ...t, delivered: true, deliveredAt: Date.now() }));
      return { status: "done", detail: mode === "typed" ? "Sent to the running session" : "Started Claude with the task" };
    }
  }
}

async function refreshFacts(cwd: string, mainBranch: string): Promise<{ health: ReturnType<typeof useAgentStore.getState>["health"][string] | null; pr: PrStatus | null }> {
  await api.gitFetch(cwd).catch(() => {});
  await useAgentStore.getState().refreshHealth(cwd, mainBranch);
  await useWorkspaceStore.getState().refreshPrStatusForPath(cwd).catch(() => {});
  return {
    health: useAgentStore.getState().health[cwd] ?? null,
    pr: useWorkspaceStore.getState().prStatuses[cwd] ?? null,
  };
}

async function runScriptStep(
  cwd: string,
  mainBranch: string,
  script: string,
  background: boolean,
  guard: "clean-tree" | "none",
): Promise<StepOutcome> {
  const store = useWorkspaceStore.getState();
  const scripts = await api.listScripts(cwd).catch(() => []);
  const label = getDisplayNameSafe(script);
  const command = commandForScript(script, scripts);
  const key = scriptKey(cwd, script);

  if (background) {
    try {
      const result = await store.ensureScriptRunning(cwd, script, command);
      if (result === "already-running") {
        const run = useWorkspaceStore.getState().scriptRuns[key];
        return { status: "done", detail: run?.watcherBuildStatus === "error" ? `${label} running (last build failed)` : `${label} already running`, scriptName: script };
      }
      return { status: "done", detail: `started ${label}`, scriptName: script };
    } catch (e) {
      return { status: "failed", detail: `${label} failed to start: ${String(e)}`, scriptName: script };
    }
  }

  if (guard === "clean-tree") {
    let { health, pr } = await refreshFacts(cwd, mainBranch);
    // Committed Finder metadata rewritten by Finder would make the repo's own
    // sync script refuse. It carries no work; put it back before the gate.
    if (health && health.ignorable_paths.length > 0) {
      await api.gitRestorePaths(cwd, health.ignorable_paths).catch(() => {});
      ({ health, pr } = await refreshFacts(cwd, mainBranch));
    }
    const verdict = assessSyncSafety({ health, pr });
    if (!verdict.safe) return { status: "failed", detail: verdict.reason, scriptName: script };
    if (verdict.mode === "skip") return { status: "done", detail: verdict.reason, scriptName: script };
    if (verdict.mode === "fast-forward") {
      try {
        const out = await api.gitPull(cwd);
        await useWorkspaceStore.getState().refreshGitStatusForPath(cwd, mainBranch).catch(() => {});
        return { status: "done", detail: out.split("\n").pop() || "Fast-forwarded", scriptName: script };
      } catch (e) {
        return { status: "failed", detail: String(e).replace(/^DIVERGED:/, "Diverged from remote: "), scriptName: script };
      }
    }
  }

  const existing = store.scriptRuns[key];
  if (!(existing && (existing.status === "running" || existing.status === "spawning"))) {
    await store.runScript(cwd, script, command);
  }
  const settled = await waitForScriptSettled(key, SCRIPT_SETTLE_TIMEOUT_MS);
  await useWorkspaceStore.getState().refreshGitStatusForPath(cwd, mainBranch).catch(() => {});
  if (settled === "success") return { status: "done", detail: `${label} finished`, scriptName: script };
  if (settled === "timeout") return { status: "failed", detail: `${label} did not finish in 10 minutes — check its output in the footer`, scriptName: script };
  return { status: "failed", detail: `${label} failed — open its output from the footer`, scriptName: script };
}

/**
 * Put the checkout on a task branch. Never touches a branch that carries
 * work: with local commits or an open PR the current branch is kept.
 */
async function runBranchStep(cwd: string, mainBranch: string, resolved: ResolvedPrepare, pod: FlightPod): Promise<StepOutcome> {
  const { health, pr } = await refreshFacts(cwd, mainBranch);
  if (!health) return { status: "failed", detail: "Checkout state unknown" };
  const prefix = resolved.branchPrefix ?? defaultBranchPrefix(health.user_name);
  const taken = (await api.gitListBranches(cwd).catch(() => [])).map((b) => b.name);
  const task = pod.task!;
  const agentName = pod.label ?? folderName(cwd);
  const wanted =
    task.kind === "reset" ? placeholderBranchName(prefix, agentName, new Date(), taken) : taskBranchName(prefix, taken);

  const finish = async (detail: string) => {
    await useWorkspaceStore.getState().refreshGitStatusForPath(cwd, mainBranch).catch(() => {});
    return { status: "done" as const, detail };
  };

  if (health.dirty) return { status: "failed", detail: `Uncommitted changes in ${folderName(cwd)}; not switching branches.` };
  if (health.ignorable_paths.length > 0) await api.gitRestorePaths(cwd, health.ignorable_paths).catch(() => {});
  if (health.branch === health.default_branch) {
    await api.gitCreateBranch(cwd, wanted);
    return finish(`created ${wanted}`);
  }
  const carriesWork = health.ahead_of_default > 0 || pr?.state === "OPEN";
  if (carriesWork) return finish(`kept ${health.branch}`);
  if (task.kind !== "reset" && isPlaceholderBranch(health.branch, prefix)) {
    await api.gitRenameBranch(cwd, wanted);
    return finish(`renamed ${health.branch} → ${wanted}`);
  }
  if (task.kind === "reset" && isPlaceholderBranch(health.branch, prefix)) {
    return finish(`kept ${health.branch}`);
  }
  await api.gitCreateBranch(cwd, wanted);
  return finish(`created ${wanted} (left ${health.branch} behind)`);
}
