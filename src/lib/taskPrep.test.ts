import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const pane = { id: "pane", type: "claude-launcher", ptyId: undefined };
  const layout = { groups: { group: { activePaneId: "pane", panes: [pane] } } };
  return {
    pane, layout,
    sessions: {} as Record<string, { status: string }>,
    ids: [] as string[],
    store: {
      flightLayouts: { ws: { pods: [{ id: "pod", cwd: "/repo", stashed: true }] } },
      layouts: { "flight:pod": layout },
      unstashPod: vi.fn(), setWorkspaceMode: vi.fn(), bringPodToFront: vi.fn(),
      getOrCreatePodLayout: vi.fn(() => layout), transformPane: vi.fn(),
      setActivePane: vi.fn(), addPaneToGroup: vi.fn(),
    },
    api: { spawnPty: vi.fn(), killPty: vi.fn(), writePtyString: vi.fn(), getPtyForegroundProcess: vi.fn() },
  };
});
vi.mock("./tauri", () => ({ api: fixture.api }));
vi.mock("../stores/workspaceStore", () => ({
  useWorkspaceStore: { getState: () => fixture.store },
  getPodMainPtyIds: () => fixture.ids,
  ptyLastOutputAt: new Map(),
}));
vi.mock("../stores/agentStore", () => ({ useAgentStore: { getState: () => ({ sessionsByPty: fixture.sessions, refreshSessions: vi.fn() }) } }));
vi.mock("./ptyActivity", () => ({ ptyTerminalTitles: new Map() }));
import { deliverPromptToPod } from "./taskPrep";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  fixture.ids = [];
  fixture.sessions = {};
  fixture.api.spawnPty.mockResolvedValue("new-pty");
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("prompt delivery", () => {
  it("starts a real PTY for a minimized launcher before reporting delivery", async () => {
    expect(await deliverPromptToPod("ws", "pod", "Fix the export", { clearFirst: true })).toBe("launched");
    expect(fixture.store.unstashPod).toHaveBeenCalledWith("ws", "pod");
    expect(fixture.api.spawnPty).toHaveBeenCalledWith("/repo", expect.stringContaining("'Fix the export'"), 100, 30);
    expect(fixture.store.transformPane).toHaveBeenCalledWith("flight:pod", "group", "pane", expect.objectContaining({ ptyId: "new-pty" }));
    expect(fixture.store.setActivePane).toHaveBeenCalledWith("flight:pod", "group", "pane");
  });
  it("reports a launch failure instead of marking an unmounted panel delivered", async () => {
    fixture.api.spawnPty.mockRejectedValueOnce(new Error("spawn failed"));
    await expect(deliverPromptToPod("ws", "pod", "Fix")).rejects.toThrow("spawn failed");
    expect(fixture.store.transformPane).not.toHaveBeenCalled();
  });
  it("sends a multiline follow-up to the minimized live session without restarting it", async () => {
    fixture.ids = ["live"];
    fixture.sessions = { live: { status: "idle" } };
    const delivery = deliverPromptToPod("ws", "pod", "First\nSecond");
    await vi.advanceTimersByTimeAsync(500);
    expect(await delivery).toBe("typed");
    expect(fixture.api.writePtyString.mock.calls).toEqual([["live", "\x1b[200~First\nSecond\x1b[201~"], ["live", "\r"]]);
    expect(fixture.api.spawnPty).not.toHaveBeenCalled();
  });
  it("refuses to reset a session that became busy during preparation", async () => {
    fixture.ids = ["live"];
    fixture.sessions = { live: { status: "busy" } };
    await expect(deliverPromptToPod("ws", "pod", "New task", { clearFirst: true })).rejects.toThrow("Claude is busy");
    expect(fixture.api.killPty).not.toHaveBeenCalled();
    expect(fixture.api.writePtyString).not.toHaveBeenCalled();
  });
});
