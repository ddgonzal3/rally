/**
 * Live agent facts that are NOT layout state: Claude session status (from
 * Claude Code's own session files), checkout health (default branch,
 * divergence, nested worktrees) and app-bundle freshness.
 *
 * Kept out of `workspaceStore` so the 2s session poll never touches the
 * persisted flight layout and never re-renders pods that don't care.
 */
import { create } from "zustand";
import { api } from "../lib/tauri";
import { singleFlight } from "../lib/singleFlight";
import type { AppBundleStatus, CheckoutHealth, ClaudeSessionInfo } from "../lib/types";

interface AgentState {
  /** Sessions keyed by owning Rally PTY id. */
  sessionsByPty: Record<string, ClaudeSessionInfo>;
  /** Every live session on the machine, including ones in other terminals
   *  or another Rally: a checkout is in use whoever opened Claude there. */
  sessions: ClaudeSessionInfo[];
  sessionsLoadedAt: number | null;
  /** Checkout health keyed by repo root. */
  health: Record<string, CheckoutHealth>;
  healthErrors: Record<string, string>;
  /** App bundle freshness keyed by `${rootPath}:${bundle}`. */
  bundles: Record<string, AppBundleStatus>;

  refreshSessions: () => Promise<void>;
  refreshHealth: (rootPath: string, mainBranch: string) => Promise<void>;
  refreshBundle: (rootPath: string, bundle: string) => Promise<void>;
}

export const useAgentStore = create<AgentState>((set) => ({
  sessionsByPty: {},
  sessions: [],
  sessionsLoadedAt: null,
  health: {},
  healthErrors: {},
  bundles: {},

  refreshSessions: singleFlight("agent-sessions", 8000, async () => {
    const list = await api.listClaudeSessions();
    const next: Record<string, ClaudeSessionInfo> = {};
    for (const s of list) {
      if (s.pty_id) next[s.pty_id] = s;
    }
    set((prev) => {
      // Skip the set() when nothing observable changed — the poll runs
      // every 2s and most ticks are identical.
      if (sameSessions(byPid(prev.sessions), byPid(list))) {
        return { sessionsLoadedAt: Date.now() };
      }
      return { sessionsByPty: next, sessions: list, sessionsLoadedAt: Date.now() };
    });
  }),

  refreshHealth: async (rootPath, mainBranch) => {
    try {
      const h = await api.checkoutHealth(rootPath, mainBranch);
      set((prev) => {
        const { [rootPath]: _dropped, ...errors } = prev.healthErrors;
        return { health: { ...prev.health, [rootPath]: h }, healthErrors: errors };
      });
    } catch (e) {
      set((prev) => ({ healthErrors: { ...prev.healthErrors, [rootPath]: String(e) } }));
    }
  },

  refreshBundle: async (rootPath, bundle) => {
    try {
      const b = await api.appBundleStatus(rootPath, bundle);
      set((prev) => ({ bundles: { ...prev.bundles, [`${rootPath}:${bundle}`]: b } }));
    } catch (e) {
      console.warn("[rally] app bundle status failed:", e);
    }
  },
}));

function byPid(list: ClaudeSessionInfo[]): Record<string, ClaudeSessionInfo> {
  return Object.fromEntries(list.map((s) => [String(s.pid), s]));
}

function sameSessions(
  a: Record<string, ClaudeSessionInfo>,
  b: Record<string, ClaudeSessionInfo>,
): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const x = a[k];
    const y = b[k];
    if (!y) return false;
    if (
      x.pid !== y.pid ||
      x.status !== y.status ||
      x.waiting_for !== y.waiting_for ||
      x.cwd !== y.cwd ||
      x.name !== y.name ||
      x.session_id !== y.session_id ||
      x.pty_id !== y.pty_id ||
      x.has_conversation !== y.has_conversation
    ) {
      return false;
    }
  }
  return true;
}

export function bundleKey(rootPath: string, bundle: string): string {
  return `${rootPath}:${bundle}`;
}

// Expose for the test bridge (only used when RALLY_TEST_MODE=1)
(window as any).__rallyAgentStoreAccessor = () => useAgentStore.getState();
