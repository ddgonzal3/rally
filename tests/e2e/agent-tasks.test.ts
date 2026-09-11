/**
 * Agent sidebar + automatic preparation — end to end against the real app.
 *
 * Builds a throwaway git repo with a bare "origin" that is one commit ahead,
 * a RALLY.json declaring a watcher + sync script, adds it as a workspace,
 * then drives the store through the test bridge:
 *
 *   1. startTask (work)      → sync ran (clone caught up), watcher started,
 *                              Claude launched with the prompt.
 *   2. session attribution   → ~/.claude/sessions/<pid>.json maps to the pod's PTY.
 *   3. sendToPod             → no re-prep, watcher untouched.
 *   4. startTask (question)  → new pod, deliver only, same watcher PTY.
 *   5. hide / reveal         → PTYs stay alive.
 *   6. dirty tree            → sync refuses, nothing reset, retry works after cleanup.
 *
 * Launches real (short) Claude Code sessions; they are stopped at the end.
 * The fixture workspace is removed from ~/.rally/workspaces.json afterwards.
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect } from "../framework/runner.js";
import { bridge } from "../framework/bridge.js";

// Stable path: Claude Code asks "trust this folder?" per directory and the
// dialog blocks session registration, so the fixture lives at one known
// path that `trustFixture()` pre-approves in ~/.claude.json.
const FIXTURE_ROOT = path.join(os.homedir(), ".rally", "test-fixtures", "agent-tasks");
const REMOTE = path.join(FIXTURE_ROOT, "origin.git");
const CLONE = path.join(FIXTURE_ROOT, "checkout");
const SEED = path.join(FIXTURE_ROOT, "seed");
const WATCHER = "watch-dev.sh";
const SYNC = "sync.sh";

let workspaceId = "";
let workPodId = "";
let questionPodId = "";
let dirtyPodId = "";
let watcherPtyId = "";

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function store<T>(body: string): Promise<T> {
  return bridge.eval<T>(`const s = window.__rallyStoreAccessor(); ${body}`);
}

async function pod(podId: string): Promise<any> {
  return store(`return s.flightLayouts[${JSON.stringify(workspaceId)}]?.pods.find(p => p.id === ${JSON.stringify(podId)}) ?? null`);
}

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 500): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await sleep(everyMs);
  }
}

async function waitForPrep(podId: string, timeoutMs = 120_000): Promise<any> {
  return waitFor(
    `prep of ${podId}`,
    async () => {
      const p = await pod(podId);
      const st = p?.task?.prep?.status;
      return st === "done" || st === "failed" || st === "interrupted" ? p.task : null;
    },
    timeoutMs,
  );
}

async function podMainPtyIds(podId: string): Promise<string[]> {
  return store(`
    const layout = s.layouts["flight:" + ${JSON.stringify(podId)}];
    const ids = [];
    if (layout) for (const g of Object.values(layout.groups)) for (const p of g.panes) if (p.type === "claude" && p.ptyId) ids.push(p.ptyId);
    return ids;`);
}

function buildFixture(): void {
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
  sh(`git init --bare -b main ${JSON.stringify(REMOTE)}`, FIXTURE_ROOT);

  fs.mkdirSync(path.join(SEED, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(SEED, "RALLY.json"),
    JSON.stringify({ statusBar: [WATCHER], statusBarRight: [SYNC], prepare: [SYNC, { script: WATCHER, background: true }] }, null, 2) + "\n",
  );
  fs.writeFileSync(
    path.join(SEED, "scripts", WATCHER),
    `#!/bin/bash
echo "[watcher] starting"
echo "compiled successfully"
while true; do sleep 60; done
`,
  );
  fs.writeFileSync(
    path.join(SEED, "scripts", SYNC),
    `#!/bin/bash
set -e
if [ -n "$(git status --porcelain -uno)" ]; then echo "dirty"; exit 1; fi
git fetch origin main
git reset --hard origin/main
echo "synced"
`,
  );
  fs.chmodSync(path.join(SEED, "scripts", WATCHER), 0o755);
  fs.chmodSync(path.join(SEED, "scripts", SYNC), 0o755);
  fs.writeFileSync(path.join(SEED, "README.md"), "fixture\n");
  sh("git init -b main", SEED);
  sh("git -c user.name=t -c user.email=t@t add -A && git -c user.name=t -c user.email=t@t commit -qm init", SEED);
  sh(`git remote add origin ${JSON.stringify(REMOTE)} && git push -q -u origin main`, SEED);

  // The checkout Rally will manage: cloned at the first commit, on a task
  // branch (so the repo's sync script path is exercised, not fast-forward) …
  sh(`git clone -q ${JSON.stringify(REMOTE)} ${JSON.stringify(CLONE)}`, FIXTURE_ROOT);
  sh("git checkout -q -b task/fixture", CLONE);
  // … then origin moves ahead so sync has real work to do.
  fs.writeFileSync(path.join(SEED, "NEW.md"), "ahead\n");
  sh("git -c user.name=t -c user.email=t@t add -A && git -c user.name=t -c user.email=t@t commit -qm ahead && git push -q", SEED);
}

/**
 * Pre-accept Claude Code's trust dialog for the fixture checkout. Claude
 * keys the flag by the resolved path in ~/.claude.json `projects`. Only adds
 * the one entry; nothing else in the file is touched.
 */
function trustFixture(): void {
  const cfgPath = path.join(os.homedir(), ".claude.json");
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};
  cfg.projects = cfg.projects ?? {};
  const resolved = fs.realpathSync(CLONE);
  for (const key of new Set([CLONE, resolved])) {
    const entry = cfg.projects[key] ?? {};
    if (entry.hasTrustDialogAccepted === true) continue;
    cfg.projects[key] = { ...entry, hasTrustDialogAccepted: true };
  }
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

test("fixture: repo with origin one commit ahead", async () => {
  buildFixture();
  trustFixture();
  const behind = sh("git fetch -q origin && git rev-list --count HEAD..origin/main", CLONE);
  expect.toBe(behind, "1", "clone should start one commit behind origin/main");
});

test("workspace added and shown in flight mode", async () => {
  const ws = await bridge.invoke<{ id: string }>("create_workspace", { name: "agent-fixture", paths: [CLONE] });
  workspaceId = ws.id;
  await store(`await s.loadWorkspaces({ keepNullActive: true }); s.setActive(${JSON.stringify(workspaceId)}); s.setWorkspaceMode(${JSON.stringify(workspaceId)}, "flight"); return true;`);
  await sleep(800);
  const active = await store<string>("return s.activeWorkspaceId");
  expect.toBe(active, workspaceId);
});

test("startTask (work): sync runs, watcher starts, Claude launched", async () => {
  workPodId = await store<string>(
    `return await s.startTask({ workspaceId: ${JSON.stringify(workspaceId)}, cwd: ${JSON.stringify(CLONE)}, description: "Reply with exactly the word OK. Do not modify any files.", kind: "work" })`,
  );
  expect.toBeTruthy(workPodId, "startTask should return a pod id");
  const task = await waitForPrep(workPodId);
  const byId = Object.fromEntries(task.prep.steps.map((st: any) => [st.id, st]));
  expect.toBe(task.prep.status, "done", `prep should finish: ${JSON.stringify(task.prep)}`);
  expect.toBe(task.prep.steps.map((st: any) => st.id).join(","), `deliver,${SYNC},${WATCHER},branch`, "deliver first, then the prepare list, then branch");
  expect.toBe(byId[SYNC].status, "done");
  expect.toContain(byId[SYNC].detail, "finished", "sync should have run the repo script");
  expect.toBe(byId[WATCHER].status, "done");
  expect.toContain(byId[WATCHER].detail, "started", "watcher should have been started");
  expect.toBe(byId.branch.status, "done");
  expect.toContain(byId.branch.detail, "created", "a task branch should have been created");
  expect.toBe(byId.deliver.status, "done");
  expect.toBe(task.delivered, true);
  expect.toContain(task.prompt, "never create or switch into a nested worktree");

  const behind = sh("git rev-list --count HEAD..origin/main", CLONE);
  expect.toBe(behind, "0", "clone should have been synced to origin/main");
  const branch = sh("git symbolic-ref --short HEAD", CLONE);
  expect.toContain(branch, "/reply-with-exactly-the-word-ok", `task branch should be named from the task, got ${branch}`);
  expect.toBe(sh("git rev-list --count origin/main..HEAD", CLONE), "0", "task branch starts at origin/main");

  const run = await store<any>(`return s.scriptRuns[${JSON.stringify(`${CLONE}:${WATCHER}`)}] ?? null`);
  expect.toBeNotNull(run, "watcher run should exist");
  expect.toBe(run.status, "running");
  watcherPtyId = run.ptyId;
});

test("Claude session file is attributed to the pod's PTY", async () => {
  const ptyIds = await waitFor("pod claude pty", () => podMainPtyIds(workPodId).then((ids) => (ids.length ? ids : null)), 20_000);
  const session = await waitFor(
    "claude session for pod",
    async () => {
      const list = await bridge.invoke<any[]>("list_claude_sessions");
      return list.find((sess) => sess.pty_id && ptyIds.includes(sess.pty_id)) ?? null;
    },
    90_000,
    1000,
  );
  expect.toBe(session.cwd, CLONE, "session cwd should be the checkout");
  expect.toBeTruthy(["busy", "waiting", "idle"].includes(session.status), `status should be a known kind, got ${session.status}`);

  // The agent store polls the same data.
  const mapped = await waitFor(
    "agent store session",
    () => bridge.eval<any>(`return window.__rallyAgentStoreAccessor().sessionsByPty[${JSON.stringify(session.pty_id)}] ?? null`),
    10_000,
  );
  expect.toBe(mapped.pid, session.pid);
});

test("sendToPod: no re-preparation, watcher untouched", async () => {
  const before = await pod(workPodId);
  await store(`await s.sendToPod(${JSON.stringify(workspaceId)}, ${JSON.stringify(workPodId)}, "Reply OK again."); return true;`);
  await sleep(1500);
  const after = await pod(workPodId);
  expect.toBe(after.task.prep.finishedAt, before.task.prep.finishedAt, "prep must not re-run for a follow-up");
  const run = await store<any>(`return s.scriptRuns[${JSON.stringify(`${CLONE}:${WATCHER}`)}]`);
  expect.toBe(run.ptyId, watcherPtyId, "watcher must not be restarted by a follow-up");
});

test("startTask (question): idle REPL is reused with /clear, deliver only, watcher untouched", async () => {
  // Wait for the first agent to go idle so the pod is reusable.
  await waitFor("work pod idle", async () => {
    const list = await bridge.invoke<any[]>("list_claude_sessions");
    const ptys = await podMainPtyIds(workPodId);
    const sess = list.find((x) => x.pty_id && ptys.includes(x.pty_id));
    return sess && sess.status === "idle" ? true : null;
  }, 120_000, 1000);
  await sleep(2500); // let the app's session poll observe the idle state
  questionPodId = await store<string>(
    `return await s.startTask({ workspaceId: ${JSON.stringify(workspaceId)}, cwd: ${JSON.stringify(CLONE)}, description: "What does README.md say? Reply in one line.", kind: "question" })`,
  );
  expect.toBe(questionPodId, workPodId, "an idle REPL should be reused, not a new pod");
  const task = await waitForPrep(questionPodId);
  expect.toBe(task.prep.status, "done", JSON.stringify(task.prep));
  expect.toBe(task.prep.steps.length, 1, "questions only deliver");
  expect.toBe(task.prep.steps[0].id, "deliver");
  expect.toContain(task.prep.steps[0].detail, "running session", "prompt should be typed into the idle REPL");
  const run = await store<any>(`return s.scriptRuns[${JSON.stringify(`${CLONE}:${WATCHER}`)}]`);
  expect.toBe(run.ptyId, watcherPtyId, "question must not restart the watcher");
  expect.toBe(run.status, "running");
});

test("hide + reveal keeps the session PTYs alive", async () => {
  const ptyIds = await podMainPtyIds(workPodId);
  expect.toBeGreaterThan(ptyIds.length, 0);
  await store(`s.stashPod(${JSON.stringify(workspaceId)}, ${JSON.stringify(workPodId)}); return true;`);
  await sleep(700);
  let alive = await bridge.invoke<any[]>("list_ptys");
  for (const id of ptyIds) expect.toBeTruthy(alive.some((p) => p.id === id), `pty ${id} should survive hiding`);
  const stashed = await pod(workPodId);
  expect.toBe(stashed.stashed, true);
  await store(`s.unstashPod(${JSON.stringify(workspaceId)}, ${JSON.stringify(workPodId)}); return true;`);
  await sleep(700);
  alive = await bridge.invoke<any[]>("list_ptys");
  for (const id of ptyIds) expect.toBeTruthy(alive.some((p) => p.id === id), `pty ${id} should survive revealing`);
  const same = await podMainPtyIds(workPodId);
  expect.toBe(same.join(","), ptyIds.join(","), "revealing must reattach the same PTYs");
});

test("dirty tree: sync refuses, nothing is reset, retry works after cleanup", async () => {
  // Move origin ahead again so sync has work, then dirty the checkout.
  fs.writeFileSync(path.join(SEED, "MORE.md"), "more\n");
  sh("git -c user.name=t -c user.email=t@t add -A && git -c user.name=t -c user.email=t@t commit -qm more && git push -q", SEED);
  // Untracked files never count; a modified tracked file does.
  const dirtyFile = path.join(CLONE, "README.md");
  fs.writeFileSync(dirtyFile, "unfinished work\n");
  fs.writeFileSync(path.join(CLONE, "scratch.txt"), "untracked, must be ignored\n");

  dirtyPodId = await store<string>(
    `return await s.startTask({ workspaceId: ${JSON.stringify(workspaceId)}, cwd: ${JSON.stringify(CLONE)}, description: "Reply with exactly the word OK.", kind: "work" })`,
  );
  const task = await waitForPrep(dirtyPodId);
  expect.toBe(task.prep.status, "failed", JSON.stringify(task.prep));
  const sync = task.prep.steps.find((st: any) => st.id === SYNC);
  expect.toBe(sync.status, "failed");
  expect.toContain(sync.detail, "Uncommitted changes");
  expect.toBe(task.delivered, true, "delivery happens first and must not wait on sync");
  expect.toBe(fs.readFileSync(dirtyFile, "utf8"), "unfinished work\n", "the modified file must survive");
  expect.toBe(sh("git rev-list --count HEAD..origin/main", CLONE), "1", "no reset happened");

  // Clean up and retry: watcher already running → reused, sync now runs.
  sh("git checkout -- README.md", CLONE);
  await store(`void s.retryTaskPrep(${JSON.stringify(workspaceId)}, ${JSON.stringify(dirtyPodId)}); return true;`);
  await sleep(300);
  const retried = await waitForPrep(dirtyPodId);
  expect.toBe(retried.prep.status, "done", JSON.stringify(retried.prep));
  const watcher = retried.prep.steps.find((st: any) => st.id === WATCHER);
  expect.toContain(watcher.detail, "already running");
  const run = await store<any>(`return s.scriptRuns[${JSON.stringify(`${CLONE}:${WATCHER}`)}]`);
  expect.toBe(run.ptyId, watcherPtyId, "retry must reuse the healthy watcher");
  expect.toBe(sh("git rev-list --count HEAD..origin/main", CLONE), "0", "retry synced the checkout");
});

test("reset checkout: refused while Claude runs, then parks on a placeholder branch", async () => {
  // Still running → refused.
  let refused = "";
  try {
    await store(`await s.resetCheckout(${JSON.stringify(workspaceId)}, ${JSON.stringify(workPodId)}); return true;`);
  } catch (e) {
    refused = String(e);
  }
  expect.toContain(refused, "Claude session is running", "reset must refuse a live session");

  const stoppedPtys = await podMainPtyIds(workPodId);
  await store(`await s.stopPodSession(${JSON.stringify(workspaceId)}, ${JSON.stringify(workPodId)}); return true;`);
  // The question pod keeps its own session in the same checkout; only the
  // stopped pod's PTYs must be gone.
  await waitFor(
    "stopped pod's session gone",
    async () => ((await bridge.invoke<any[]>("list_claude_sessions")).some((x) => x.pty_id && stoppedPtys.includes(x.pty_id)) ? null : true),
    20_000,
    1000,
  );
  // Origin ahead again so the reset has something to sync.
  fs.writeFileSync(path.join(SEED, "AGAIN.md"), "again\n");
  sh("git -c user.name=t -c user.email=t@t add -A && git -c user.name=t -c user.email=t@t commit -qm again && git push -q", SEED);

  await store(`void s.resetCheckout(${JSON.stringify(workspaceId)}, ${JSON.stringify(workPodId)}); return true;`);
  await waitFor("reset finished", async () => {
    const p = await pod(workPodId);
    return !p?.task || p.task.prep.status === "failed" ? p ?? true : null;
  }, 120_000);
  const after = await pod(workPodId);
  expect.toBeFalsy(after.task, `reset should clear its task record on success: ${JSON.stringify(after.task?.prep)}`);
  expect.toBe(sh("git rev-list --count HEAD..origin/main", CLONE), "0", "reset synced the checkout");
  const branch = sh("git symbolic-ref --short HEAD", CLONE);
  expect.toBeTruthy(/\/checkout-\d{4}(-\d+)?$/.test(branch), `placeholder branch expected, got ${branch}`);
});

test("cleanup: stop sessions, watcher, remove workspace and fixture", async () => {
  for (const id of [workPodId, questionPodId, dirtyPodId]) {
    if (!id) continue;
    await store(`await s.stopPodSession(${JSON.stringify(workspaceId)}, ${JSON.stringify(id)}); s.removeFlightPod(${JSON.stringify(workspaceId)}, ${JSON.stringify(id)}); return true;`);
  }
  await store(`await s.stopScript(${JSON.stringify(CLONE)}, ${JSON.stringify(WATCHER)}); s.clearScript(${JSON.stringify(CLONE)}, ${JSON.stringify(WATCHER)}); return true;`);
  await store(`await s.removeWorkspace(${JSON.stringify(workspaceId)}); return true;`);
  await sleep(500);
  const gone = await store<boolean>(`return !s.workspaces.some(w => w.id === ${JSON.stringify(workspaceId)})`);
  expect.toBe(gone, true, "fixture workspace should be removed");
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});
