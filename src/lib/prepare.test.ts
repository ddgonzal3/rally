import { describe, it, expect } from "vitest";
import {
  assessSyncSafety,
  buildTaskPrompt,
  checkoutMismatches,
  defaultBranchPrefix,
  describeAgentActivity,
  isPlaceholderBranch,
  pickFreeCheckout,
  placeholderBranchName,
  resolveCheckout,
  taskSetupStatus,
  projectFromOrigin,
  resolvePrepareConfig,
  shortDescription,
  slugify,
  taskBranchName,
  withAttachments,
} from "./prepare";
import type { CheckoutHealth, ClaudeSessionInfo, PodTask, PrepStep, PrStatus, RallyConfig } from "./types";

const flowConfig: RallyConfig = {
  excludeBuiltins: [],
  excludeScripts: [],
  mode: null,
  statusBar: ["watch-fe.sh", "build-cpp.sh", "run.sh"],
  statusBarRight: ["sync.sh"],
};

const pr = (state: PrStatus["state"], number = 42): PrStatus => ({
  number,
  title: "",
  url: "",
  state,
  is_draft: false,
  mergeable: "UNKNOWN",
  review_decision: null,
  checks_status: null,
});

function health(over: Partial<CheckoutHealth> = {}): CheckoutHealth {
  return {
    root: "/Users/me/flow3",
    branch: "danny/thing",
    head: "abc",
    default_branch: "staging",
    ahead_of_default: 0,
    behind_default: 3,
    dirty: false,
    dirty_paths: [],
    ignorable_paths: [],
    worktrees: [],
    origin_url: "git@github.com:splice/flow.git",
    user_name: "Danny Gonzalez",
    ...over,
  };
}

function session(over: Partial<ClaudeSessionInfo> = {}): ClaudeSessionInfo {
  return {
    pid: 1,
    session_id: "s",
    cwd: "/Users/me/flow3",
    status: "busy",
    waiting_for: null,
    name: null,
    kind: "interactive",
    updated_at: 0,
    started_at: 0,
    pty_id: "pty",
    ...over,
  };
}

describe("resolvePrepareConfig", () => {
  it("infers from the status bar when prepare is absent: right = blocking, watchers = background", () => {
    const r = resolvePrepareConfig(flowConfig);
    expect(r.inferred).toBe(true);
    expect(r.steps).toEqual([
      { script: "sync.sh", background: false, guard: "clean-tree" },
      { script: "watch-fe.sh", background: true, guard: "none" },
    ]);
  });

  it("uses the declared list verbatim, in order, guarding the first blocking step", () => {
    const r = resolvePrepareConfig({
      ...flowConfig,
      prepare: [{ script: "watch-fe.sh", background: true }, "sync.sh", "seed-db.sh"],
      agent: { branchPrefix: "dg/", appBundle: "out/App.app" },
    });
    expect(r.inferred).toBe(false);
    expect(r.steps.map((s) => s.script)).toEqual(["watch-fe.sh", "sync.sh", "seed-db.sh"]);
    expect(r.steps[0].background).toBe(true);
    expect(r.steps[1].guard).toBe("clean-tree");
    expect(r.steps[2].guard).toBe("none");
    expect(r.branchPrefix).toBe("dg/");
    expect(r.appBundle).toBe("out/App.app");
  });

  it("respects an explicit guard: none", () => {
    const r = resolvePrepareConfig({ ...flowConfig, prepare: [{ script: "sync.sh", guard: "none" }] });
    expect(r.steps[0].guard).toBe("none");
  });

  it("handles repos with nothing declared", () => {
    const r = resolvePrepareConfig(undefined);
    expect(r.steps).toEqual([]);
    expect(r.stayOnDefault).toBe(false);
  });
});

describe("assessSyncSafety", () => {
  it("refuses a dirty tree", () => {
    const v = assessSyncSafety({ health: health({ dirty: true }), pr: null });
    expect(v.safe).toBe(false);
    expect(v.reason).toMatch(/Uncommitted changes to tracked files in flow3/);
  });

  it("refuses when local commits are not on the default branch", () => {
    const v = assessSyncSafety({ health: health({ ahead_of_default: 2 }), pr: pr("OPEN") });
    expect(v.safe).toBe(false);
    expect(v.reason).toMatch(/2 local commits/);
    expect(v.reason).toMatch(/PR #42 still open/);
  });

  it("allows the script once the PR is merged", () => {
    expect(assessSyncSafety({ health: health({ ahead_of_default: 2 }), pr: pr("MERGED") })).toMatchObject({ safe: true, mode: "script" });
  });

  it("fast-forwards on the default branch", () => {
    expect(assessSyncSafety({ health: health({ branch: "staging" }), pr: null })).toMatchObject({ safe: true, mode: "fast-forward" });
  });

  it("skips when already up to date", () => {
    expect(assessSyncSafety({ health: health({ behind_default: 0 }), pr: null })).toMatchObject({ safe: true, mode: "skip" });
  });

  it("is unsafe without health", () => {
    expect(assessSyncSafety({ health: null, pr: null }).safe).toBe(false);
  });
});

describe("projects", () => {
  it("derives the project from the origin URL", () => {
    expect(projectFromOrigin("git@github.com:splice/flow.git", "/x/flow3")).toBe("flow");
    expect(projectFromOrigin("https://github.com/splice/audio-science-genai", "/x")).toBe("audio-science-genai");
    expect(projectFromOrigin("", "/Users/me/sift")).toBe("sift");
  });

  it("picks a free checkout, preferring one with an idle pod", () => {
    const pick = pickFreeCheckout([
      { cwd: "/flow", busy: true, dirty: false, pr: null, hasPod: true },
      { cwd: "/flow2", busy: false, dirty: false, pr: pr("OPEN", 7), hasPod: true },
      { cwd: "/flow3", busy: false, dirty: false, pr: null, hasPod: false },
      { cwd: "/flow4", busy: false, dirty: false, pr: pr("MERGED"), hasPod: true },
    ]);
    expect(pick.cwd).toBe("/flow4");
  });

  it("explains every rejection when nothing is free", () => {
    const pick = pickFreeCheckout([
      { cwd: "/flow", busy: true, dirty: false, pr: null, hasPod: true },
      { cwd: "/flow2", busy: false, dirty: true, pr: null, hasPod: false },
      { cwd: "/flow3", busy: false, dirty: false, pr: pr("OPEN", 9), hasPod: false },
    ]);
    expect(pick.cwd).toBeNull();
    expect(pick.checkouts.map((r) => r.reason)).toEqual(["agent running", "uncommitted changes", "PR #9 open"]);
  });

  it("honors a chosen checkout only while it is free", () => {
    const pick = pickFreeCheckout([
      { cwd: "/flow", busy: false, dirty: false, pr: null, hasPod: true },
      { cwd: "/flow2", busy: false, dirty: false, pr: null, hasPod: false },
      { cwd: "/flow3", busy: true, dirty: false, pr: null, hasPod: true },
    ]);
    expect(resolveCheckout(pick, null)).toEqual({ cwd: "/flow", blocked: null });
    expect(resolveCheckout(pick, "/flow2")).toEqual({ cwd: "/flow2", blocked: null });
    expect(resolveCheckout(pick, "/flow3")).toEqual({ cwd: null, blocked: { cwd: "/flow3", reason: "agent running" } });
    expect(resolveCheckout(pick, "/elsewhere").cwd).toBeNull();
  });
});

describe("branch names", () => {
  it("slugifies", () => {
    expect(slugify("Fix the export bug!")).toBe("fix-the-export-bug");
    expect(slugify("   ")).toBe("task");
    expect(slugify("x".repeat(60), 10)).toBe("xxxxxxxxxx");
  });

  it("derives the prefix from the git user", () => {
    expect(defaultBranchPrefix("Danny Gonzalez")).toBe("danny/");
    expect(defaultBranchPrefix("")).toBe("agent/");
  });

  it("builds unique task and placeholder names", () => {
    const d = new Date(2026, 8, 10);
    expect(taskBranchName("danny/", [], d)).toBe("danny/task-0910");
    expect(taskBranchName("danny/", ["danny/task-0910"], d)).toBe("danny/task-0910-2");
    expect(placeholderBranchName("danny/", "flow3", d, [])).toBe("danny/flow3-0910");
    expect(placeholderBranchName("danny/", "flow3", d, ["danny/flow3-0910"])).toBe("danny/flow3-0910-2");
  });

  it("recognises placeholders", () => {
    expect(isPlaceholderBranch("danny/flow3-0910", "danny/")).toBe(true);
    expect(isPlaceholderBranch("danny/flow3-0910-2", "danny/")).toBe(true);
    expect(isPlaceholderBranch("danny/fix-the-export-bug", "danny/")).toBe(false);
    expect(isPlaceholderBranch("other/flow3-0910", "danny/")).toBe(false);
  });
});

describe("buildTaskPrompt", () => {
  it("adds a generic checkout trailer for work", () => {
    const p = buildTaskPrompt({ description: "Fix the export bug", kind: "work", cwd: "/Users/me/flow3", branch: "danny/fix", trailer: null });
    expect(p.startsWith("Fix the export bug\n\n")).toBe(true);
    expect(p).toMatch(/\/Users\/me\/flow3 \(branch danny\/fix\)/);
    expect(p).toMatch(/nested worktree/);
    expect(p).not.toMatch(/watcher|Run button/);
  });

  it("uses the repo trailer verbatim when declared", () => {
    expect(buildTaskPrompt({ description: "x", kind: "work", cwd: "/r", branch: null, trailer: "Custom rules." })).toBe("x\n\nCustom rules.");
  });

  it("marks questions read-only", () => {
    expect(buildTaskPrompt({ description: "How?", kind: "question", cwd: "/r", branch: "main", trailer: null })).toMatch(/Read only/);
  });

  it("lists pasted images before the trailer", () => {
    const p = buildTaskPrompt({
      description: "Match this design",
      kind: "work",
      cwd: "/r",
      branch: null,
      trailer: "T.",
      attachments: ["/tmp/a.png", "/tmp/b.png"],
    });
    expect(p).toBe("Match this design\n\nAttached images (open them with the Read tool):\n- /tmp/a.png\n- /tmp/b.png\n\nT.");
    expect(withAttachments("x", ["/tmp/a.png"])).toMatch(/^x\n\nAttached image \(open it with the Read tool\):\n- \/tmp\/a.png$/);
    expect(withAttachments("x", [])).toBe("x");
    expect(withAttachments("", ["/tmp/a.png"])).toBe("Attached image (open it with the Read tool):\n- /tmp/a.png");
  });
});

describe("describeAgentActivity", () => {
  const now = 10_000;
  it("trusts the session file first", () => {
    expect(describeAgentActivity({ session: session({ status: "busy" }), claudeForeground: false, title: null, lastOutputAt: null, bellPending: false, now }).state).toBe("working");
    const w = describeAgentActivity({ session: session({ status: "waiting", waiting_for: "approve Bash" }), claudeForeground: true, title: null, lastOutputAt: now, bellPending: false, now });
    expect(w).toMatchObject({ state: "waiting", attention: true, detail: "approve Bash" });
  });

  it("never turns silence into completion", () => {
    const a = describeAgentActivity({ session: null, claudeForeground: true, title: null, lastOutputAt: now - 60_000, bellPending: false, now });
    expect(a.state).toBe("quiet");
    expect(a.label).not.toMatch(/done|complete/i);
  });

  it("reads the title spinner as working and reports no session otherwise", () => {
    expect(describeAgentActivity({ session: null, claudeForeground: true, title: { title: "Fix bug", claude: "busy", at: now }, lastOutputAt: null, bellPending: false, now }).state).toBe("working");
    expect(describeAgentActivity({ session: null, claudeForeground: false, title: null, lastOutputAt: null, bellPending: false, now }).state).toBe("no-session");
  });
});

describe("checkoutMismatches", () => {
  it("is empty when everything lines up", () => {
    expect(checkoutMismatches({ podCwd: "/Users/me/flow3", session: session(), health: health() })).toEqual([]);
  });

  it("flags Claude running in a nested worktree but tolerates subdirectories", () => {
    expect(checkoutMismatches({ podCwd: "/Users/me/flow3", session: session({ cwd: "/Users/me/flow3/.claude/worktrees/agent-1" }), health: health() })[0].kind).toBe("session-cwd");
    expect(checkoutMismatches({ podCwd: "/Users/me/flow3", session: session({ cwd: "/Users/me/flow3/surfaces" }), health: health() })).toEqual([]);
  });

  it("folds nested worktrees into one warning", () => {
    const wt = (n: string) => ({ path: `/r/.claude/worktrees/${n}`, branch: "b", head: "abc", nested: true, dirty: true, locked: null });
    const out = checkoutMismatches({ podCwd: "/r", session: null, health: health({ root: "/r", worktrees: [wt("a"), wt("b"), wt("c")] }) });
    expect(out).toHaveLength(1);
    expect(out[0].short).toBe("3 nested worktrees active");
  });
});

describe("shortDescription", () => {
  it("keeps the first line and truncates", () => {
    expect(shortDescription("  first line\nsecond ")).toBe("first line");
    expect(shortDescription("x".repeat(100), 10)).toBe("xxxxxxxxx…");
  });
});

 it("never assigns a manually busy checkout, even without a Rally agent", () => {
   const reserved = { cwd: "/repo1", busy: false, manualBusy: true, dirty: false, pr: null, hasPod: true };
   expect(pickFreeCheckout([reserved])).toEqual({ cwd: null, checkouts: [{ cwd: "/repo1", reason: "marked busy outside Rally" }] });
   expect(pickFreeCheckout([reserved, { ...reserved, cwd: "/repo2", manualBusy: false }]).cwd).toBe("/repo2");
 });

describe("task setup status", () => {
  const step = (kind: PrepStep["kind"], status: PrepStep["status"], extra: Partial<PrepStep> = {}): PrepStep => ({
    id: kind,
    kind,
    label: kind === "branch" ? "Branch" : kind === "deliver" ? "Deliver" : "watch-fe",
    status,
    ...extra,
  });
  const task = (prep: PodTask["prep"], over: Partial<PodTask> = {}): PodTask => ({
    id: "t",
    description: "d",
    prompt: "",
    kind: "work",
    createdAt: 0,
    delivered: false,
    prep,
    ...over,
  });

  it("names the step in progress until the prompt is delivered", () => {
    expect(taskSetupStatus(task({ status: "idle", steps: [step("branch", "pending"), step("deliver", "pending")] }))?.text).toMatch(/fresh branch/);
    expect(taskSetupStatus(task({ status: "running", steps: [step("branch", "done"), step("deliver", "running")] }))).toEqual({ text: "Starting Claude…", busy: true });
    expect(taskSetupStatus(task({ status: "running", steps: [step("branch", "done")] }, { delivered: true }))).toBeNull();
  });

  it("explains a stopped setup and ignores resets", () => {
    const failed = task({ status: "failed", steps: [step("branch", "failed", { detail: "Couldn't fetch origin" })] });
    expect(taskSetupStatus(failed)).toEqual({ text: "Setup stopped: Couldn't fetch origin", busy: false });
    expect(taskSetupStatus({ ...failed, kind: "reset" })).toBeNull();
    expect(taskSetupStatus(undefined)).toBeNull();
  });
});
