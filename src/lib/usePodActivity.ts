import { useEffect, useState } from "react";
import { useWorkspaceStore, getPodMainPtyIds, ptyLastOutputAt } from "../stores/workspaceStore";
import { useAgentStore } from "../stores/agentStore";
import { hasUnansweredBell, ptyTerminalTitles, type TerminalTitle } from "./ptyActivity";
import { checkoutMismatches, describeAgentActivity, type AgentActivity, type CheckoutMismatch } from "./prepare";
import type { CheckoutHealth, ClaudeSessionInfo } from "./types";

export interface PodActivity {
  activity: AgentActivity;
  session: ClaudeSessionInfo | null;
  /** Claude Code's own topic title for the conversation, if it set one. */
  title: TerminalTitle | null;
  mismatches: CheckoutMismatch[];
}

const TICK_MS = 1000;

/**
 * Checkout mismatches only (Claude session cwd vs pod, active nested
 * worktrees). Store-driven, no interval — safe for the pod footer.
 */
export function usePodMismatches(workspaceId: string, podId: string): CheckoutMismatch[] {
  const podCwd = useWorkspaceStore((s) => s.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId)?.cwd ?? "");
  const ptyIdsKey = useWorkspaceStore(() => getPodMainPtyIds(podId).join("\n"));
  const sessionsByPty = useAgentStore((s) => s.sessionsByPty);
  const health = useAgentStore((s) => s.health[podCwd] ?? null);
  const ptyIds = ptyIdsKey ? ptyIdsKey.split("\n") : [];
  const session = ptyIds.map((id) => sessionsByPty[id]).find((s): s is ClaudeSessionInfo => !!s) ?? null;
  return checkoutMismatches({ podCwd, session, health });
}

/**
 * Activity for one pod from the current signals: the session file
 * (authoritative), terminal titles/bells and checkout health. Not a hook,
 * so the sidebar can evaluate every pod in one pass.
 */
export function readPodActivity(
  podId: string,
  podCwd: string,
  sessionsByPty: Record<string, ClaudeSessionInfo>,
  health: CheckoutHealth | null,
  now: number = Date.now(),
): PodActivity {
  let session: ClaudeSessionInfo | null = null;
  let title: TerminalTitle | null = null;
  let lastOutputAt: number | null = null;
  let bellPending = false;
  for (const id of getPodMainPtyIds(podId)) {
    const s = sessionsByPty[id];
    if (s && !session) session = s;
    const t = ptyTerminalTitles.get(id);
    if (t && (!title || t.at > title.at)) title = t;
    const o = ptyLastOutputAt.get(id);
    if (o !== undefined && (lastOutputAt === null || o > lastOutputAt)) lastOutputAt = o;
    if (hasUnansweredBell(id)) bellPending = true;
  }
  const claudeForeground = title?.claude !== undefined && title.claude !== "none";
  const activity = describeAgentActivity({ session, claudeForeground, title, lastOutputAt, bellPending, now });
  const mismatches = checkoutMismatches({ podCwd, session, health });
  return { activity, session, title, mismatches };
}

/** Re-render once a second so terminal-derived signals stay fresh. */
export function useActivityTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(t);
  }, []);
  return tick;
}

/**
 * Live activity for a pod. Re-evaluates once a second for the
 * terminal-derived parts and on store changes for the rest.
 */
export function usePodActivity(workspaceId: string, podId: string): PodActivity {
  const podCwd = useWorkspaceStore((s) => s.flightLayouts[workspaceId]?.pods.find((p) => p.id === podId)?.cwd ?? "");
  const sessionsByPty = useAgentStore((s) => s.sessionsByPty);
  const health = useAgentStore((s) => s.health[podCwd] ?? null);
  useActivityTick();
  return readPodActivity(podId, podCwd, sessionsByPty, health);
}
