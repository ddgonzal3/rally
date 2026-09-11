import { describe, it, expect } from "vitest";
import { buildSidebarModel, type SidebarPodInput, type SidebarCheckoutInput } from "./sidebarModel";
import type { AgentActivity } from "./prepare";
import type { PodTask, PrStatus } from "./types";

const FLOW = "git@github.com:splice/flow.git";
const ATLANTIS = "https://github.com/splice/atlantis";

function checkout(cwd: string, origin: string, extra: Partial<SidebarCheckoutInput> = {}): SidebarCheckoutInput {
  return { cwd, origin, branch: "staging", dirty: false, pr: null, ...extra };
}

function activity(state: AgentActivity["state"], extra: Partial<AgentActivity> = {}): AgentActivity {
  return { state, label: state, attention: false, source: state === "no-session" ? "none" : "session", ...extra };
}

function pod(cwd: string, extra: Partial<SidebarPodInput> = {}): SidebarPodInput {
  return {
    id: `pod-${cwd.split("/").pop()}-${extra.id ?? "1"}`,
    type: "claude",
    cwd,
    name: cwd.split("/").pop()!,
    hidden: false,
    task: undefined,
    activity: activity("no-session"),
    topic: null,
    // A session that predates the task: the reused REPL that received it.
    sessionStartedAt: 0,
    mismatches: [],
    ...extra,
  };
}

function task(description: string, prepStatus: PodTask["prep"]["status"] = "done", kind: PodTask["kind"] = "work"): PodTask {
  return {
    id: "t",
    description,
    prompt: "",
    kind,
    createdAt: 0,
    delivered: true,
    prep: {
      status: prepStatus,
      steps: [
        { id: "deliver", kind: "deliver", label: "Deliver", status: "done" },
        { id: "sync.sh", kind: "script", label: "Sync", status: prepStatus === "failed" ? "failed" : prepStatus === "running" ? "running" : "done", detail: prepStatus === "failed" ? "Uncommitted changes" : undefined },
      ],
    },
  };
}

const pr: PrStatus = {
  number: 3621,
  title: "Fix export",
  url: "https://github.com/splice/flow/pull/3621",
  state: "OPEN",
  is_draft: false,
  mergeable: "MERGEABLE",
  review_decision: null,
  checks_status: "pass",
};

const paths = ["/w/flow1", "/w/flow2", "/w/flow3", "/w/atlantis"];
const checkouts = {
  "/w/flow1": checkout("/w/flow1", FLOW),
  "/w/flow2": checkout("/w/flow2", FLOW),
  "/w/flow3": checkout("/w/flow3", FLOW),
  "/w/atlantis": checkout("/w/atlantis", ATLANTIS, { branch: "main" }),
};

describe("buildSidebarModel", () => {
  it("groups checkouts by origin repo, alphabetical; podless checkouts are bare rows, hidden while collapsed", () => {
    const model = buildSidebarModel({ paths, checkouts, pods: [] });
    expect(model.map((p) => p.project)).toEqual(["atlantis", "flow"]);
    const flow = model[1];
    expect(flow.rows.map((r) => [r.name, r.podId, r.secondary, r.available])).toEqual([
      ["flow1", null, "staging", true],
      ["flow2", null, "staging", true],
      ["flow3", null, "staging", true],
    ]);
    expect(flow.active).toEqual([]);
    expect(flow.available).toBe(3);
  });

  it("every open Claude panel gets a row; visible idle ones stay listed, hidden idle ones wait in the expanded list", () => {
    const pods = [
      pod("/w/flow1", { activity: activity("idle"), task: task("Old finished task"), topic: "lets make the spli" }),
      pod("/w/flow2", { activity: activity("no-session"), hidden: true }),
    ];
    const flow = buildSidebarModel({ paths, checkouts, pods })[1];
    expect(flow.rows.map((a) => [a.name, a.dot, a.secondary])).toEqual([
      ["flow1", null, "Old finished task"],
      ["flow2", null, "staging"],
      ["flow3", null, "staging"],
    ]);
    expect(flow.active.map((a) => a.name)).toEqual(["flow1"]);
    expect(flow.available).toBe(3);
  });

  it("working and waiting agents are active rows with the right dot and the task as second line", () => {
    const pods = [
      pod("/w/flow1", { activity: activity("working"), task: task("Fix the export bug") }),
      pod("/w/flow2", { activity: activity("waiting", { detail: "permission" }), task: task("Add tests") }),
    ];
    const flow = buildSidebarModel({ paths, checkouts, pods })[1];
    expect(flow.active.map((a) => [a.name, a.dot, a.secondary])).toEqual([
      ["flow1", "working", "Fix the export bug"],
      ["flow2", "waiting", "Add tests"],
    ]);
    expect(flow.rows).toHaveLength(3);
    expect(flow.available).toBe(1);
    expect(flow.checkouts.map((c) => c.state)).toEqual(["working", "waiting", "available"]);
  });

  it("the task description is dropped once its session is gone or a newer session runs in the panel", () => {
    const t = { ...task("Make the splice icon yellow"), createdAt: 1_000_000, deliveredAt: 1_000_500 };
    const gone = pod("/w/flow1", { activity: activity("no-session"), task: t, sessionStartedAt: null });
    const later = pod("/w/flow2", { activity: activity("idle"), task: t, sessionStartedAt: 1_000_500 + 10 * 60_000, topic: "Greeting" });
    const launched = pod("/w/flow3", { activity: activity("working"), task: t, sessionStartedAt: 1_000_500 + 3_000 });
    const flow = buildSidebarModel({ paths, checkouts, pods: [gone, later, launched] })[1];
    expect(flow.rows.map((r) => r.secondary)).toEqual(["staging", "Greeting", "Make the splice icon yellow"]);
  });

  it("a failed or running preparation keeps its description even without a session", () => {
    const pods = [pod("/w/flow1", { activity: activity("no-session"), task: task("Add tests", "failed"), sessionStartedAt: null })];
    const flow = buildSidebarModel({ paths, checkouts, pods })[1];
    expect(flow.rows[0].secondary).toBe("Add tests");
  });

  it("a finished turn with an unanswered bell counts as needing you", () => {
    const pods = [pod("/w/flow1", { activity: activity("idle", { attention: true }), task: task("Refactor") })];
    const flow = buildSidebarModel({ paths, checkouts, pods })[1];
    expect(flow.active[0].dot).toBe("waiting");
  });

  it("shows Claude's live topic when there is no task; a panel without a topic falls back to its branch", () => {
    const working = pod("/w/flow1", { activity: activity("working"), topic: "lets make the splice" });
    const idle = pod("/w/flow2", { activity: activity("idle"), topic: null, hidden: true });
    const flow = buildSidebarModel({ paths, checkouts, pods: [working, idle] })[1];
    expect(flow.rows.slice(0, 2).map((a) => a.secondary)).toEqual(["lets make the splice", "staging"]);
  });

  it("shows an open PR once, as the pill on the first row of that checkout", () => {
    const withPr = { ...checkouts, "/w/flow1": checkout("/w/flow1", FLOW, { pr }) };
    const pods = [
      pod("/w/flow1", { id: "a", activity: activity("working"), task: task("Fix export") }),
      pod("/w/flow1", { id: "b", activity: activity("idle"), hidden: true }),
    ];
    const flow = buildSidebarModel({ paths, checkouts: withPr, pods })[1];
    expect(flow.rows.slice(0, 2).map((a) => a.pr?.number ?? null)).toEqual([3621, null]);
    expect(flow.active).toHaveLength(1);
    expect(flow.checkouts[0].state).toBe("working");
  });

  it("an idle checkout with an open PR stays active (pill visible) and is in review", () => {
    const withPr = { ...checkouts, "/w/flow2": checkout("/w/flow2", FLOW, { pr }) };
    const pods = [pod("/w/flow2", { activity: activity("idle"), task: task("Fix export") })];
    const flow = buildSidebarModel({ paths, checkouts: withPr, pods })[1];
    expect(flow.active).toHaveLength(1);
    expect(flow.active[0]).toMatchObject({ podId: "pod-flow2-1", dot: null, pr, secondary: "Fix export", available: false });
    expect(flow.checkouts[1].state).toBe("review");
    expect(flow.available).toBe(2);
  });

  it("a PR on a checkout with no panel is an active bare row showing the branch", () => {
    const withPr = { ...checkouts, "/w/flow3": checkout("/w/flow3", FLOW, { pr, branch: "danny/fix-export" }) };
    const flow = buildSidebarModel({ paths, checkouts: withPr, pods: [] })[1];
    expect(flow.active).toHaveLength(1);
    expect(flow.active[0]).toMatchObject({ podId: null, name: "flow3", secondary: "danny/fix-export", pr, available: false });
  });

  it("dirty idle checkouts are not available and not active", () => {
    const dirty = { ...checkouts, "/w/flow1": checkout("/w/flow1", FLOW, { dirty: true }) };
    const flow = buildSidebarModel({ paths, checkouts: dirty, pods: [pod("/w/flow1", { activity: activity("idle"), hidden: true })] })[1];
    expect(flow.active).toEqual([]);
    expect(flow.available).toBe(2);
    expect(flow.checkouts[0].state).toBe("dirty");
    expect(flow.rows[0].available).toBe(false);
  });

  it("merges a single-checkout project with one row into one row named after the project", () => {
    const pods = [pod("/w/atlantis", { activity: activity("working"), task: task("Ship it") })];
    const atlantis = buildSidebarModel({ paths, checkouts, pods })[0];
    expect(atlantis.merged).toBe(true);
    expect(atlantis.rows[0].name).toBe("atlantis");
    expect(atlantis.available).toBe(0);
  });

  it("a single-checkout project with no panel is still one merged row", () => {
    const atlantis = buildSidebarModel({ paths, checkouts, pods: [] })[0];
    expect(atlantis.merged).toBe(true);
    expect(atlantis.rows[0]).toMatchObject({ name: "atlantis", podId: null, secondary: "main", available: true });
  });

  it("does not merge when the single checkout has two panels", () => {
    const pods = [
      pod("/w/atlantis", { id: "a", activity: activity("working"), task: task("One") }),
      pod("/w/atlantis", { id: "b", activity: activity("waiting"), task: task("Two") }),
    ];
    const atlantis = buildSidebarModel({ paths, checkouts, pods })[0];
    expect(atlantis.merged).toBe(false);
    expect(atlantis.rows.map((a) => a.name)).toEqual(["atlantis", "atlantis"]);
    expect(atlantis.checkouts[0].state).toBe("waiting");
  });

  it("running preparation is a working row; failed preparation is active via its problem mark, no dot", () => {
    const pods = [
      pod("/w/flow1", { task: task("Fix export", "running") }),
      pod("/w/flow2", { task: task("Add tests", "failed") }),
    ];
    const flow = buildSidebarModel({ paths, checkouts, pods })[1];
    expect(flow.active).toHaveLength(2);
    expect(flow.active[0]).toMatchObject({ dot: "working", preparing: true, problem: null });
    expect(flow.active[1]).toMatchObject({ dot: null, preparing: false });
    expect(flow.active[1].problem).toEqual({ short: "Sync failed", detail: "Sync failed\nUncommitted changes" });
    expect(flow.checkouts.map((c) => c.state)).toEqual(["working", "available", "available"]);
  });

  it("a reset task never shows its description", () => {
    const pods = [pod("/w/flow1", { task: task("Reset checkout", "running", "reset") })];
    const flow = buildSidebarModel({ paths, checkouts, pods })[1];
    expect(flow.rows[0].secondary).toBe("staging");
  });

  it("hidden panels keep their row, flagged hidden; terminal pods never get one", () => {
    const pods = [
      pod("/w/flow1", { id: "h", hidden: true, activity: activity("idle") }),
      { ...pod("/w/flow1", { id: "t" }), type: "terminal" as const, hidden: true, name: "shell" },
    ];
    const flow = buildSidebarModel({ paths, checkouts, pods })[1];
    expect(flow.rows.filter((r) => r.cwd === "/w/flow1").map((a) => [a.podId, a.hidden])).toEqual([["h", true]]);
  });

  it("checkout mismatches surface as the problem mark and keep the row active", () => {
    const pods = [
      pod("/w/flow1", {
        activity: activity("idle"),
        task: task("Fix"),
        mismatches: [{ kind: "session-cwd", short: "Claude runs in agent-x", detail: "Claude runs in ~/w/flow1/.claude/worktrees/agent-x; watcher builds flow1." }],
      }),
    ];
    const flow = buildSidebarModel({ paths, checkouts, pods })[1];
    expect(flow.active[0].problem?.short).toBe("Claude runs in agent-x");
  });

  it("never joins text with middle dots", () => {
    const withPr = { ...checkouts, "/w/flow1": checkout("/w/flow1", FLOW, { pr }) };
    const pods = [
      pod("/w/flow1", { activity: activity("waiting", { detail: "permission" }), task: task("Fix export") }),
      pod("/w/flow2", { task: task("Add tests", "failed") }),
    ];
    const model = buildSidebarModel({ paths, checkouts: withPr, pods });
    expect(JSON.stringify(model)).not.toContain(" · ");
  });

  it("gives pods on checkouts missing from the workspace a project so they are never lost", () => {
    const pods = [pod("/w/elsewhere", { activity: activity("working"), task: task("Stray") })];
    const model = buildSidebarModel({ paths, checkouts, pods });
    const stray = model.find((p) => p.project === "elsewhere");
    expect(stray?.rows[0].name).toBe("elsewhere");
    expect(stray?.merged).toBe(true);
  });
});
