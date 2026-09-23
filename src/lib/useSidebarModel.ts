import { useCheckoutStore } from "../stores/checkoutStore";
import { useMemo } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useAgentStore } from "../stores/agentStore";
import { checkoutInUse, folderName } from "./prepare";
import { readPodActivity, useActivityTick } from "./usePodActivity";
import { buildSidebarModel, type ProjectEntry, type SidebarCheckoutInput, type SidebarPodInput } from "./sidebarModel";

const NO_PROJECTS: ProjectEntry[] = [];

/**
 * The sidebar's row model for a workspace, rebuilt when anything it shows
 * could have changed: pods (identity, checkout, label, hidden, task), the
 * session poll, checkout health, PR status, branches, and a 1s tick for the
 * terminal-derived signals. Pod geometry never triggers a rebuild.
 */
export function useSidebarModel(workspaceId: string | null): ProjectEntry[] {
  const pathsKey = useWorkspaceStore((s) => (workspaceId ? (s.workspaces.find((w) => w.id === workspaceId)?.paths ?? []).join("\n") : ""));
  const podsKey = useWorkspaceStore((s) => {
    if (!workspaceId) return "";
    return (s.flightLayouts[workspaceId]?.pods ?? [])
      .map((p) => [p.id, p.type, p.cwd, p.label ?? "", p.stashed ? 1 : 0, p.task?.id ?? "", p.task?.prep.status ?? "", p.task?.prep.steps.map((st) => st.status).join(",") ?? ""].join("\t"))
      .join("\n");
  });
  const branchesKey = useWorkspaceStore((s) =>
    pathsKey
      .split("\n")
      .filter(Boolean)
      .map((cwd) => `${cwd}\t${s.gitStatuses[cwd]?.branch ?? ""}\t${s.gitStatuses[cwd]?.dirty ? 1 : 0}`)
      .join("\n"),
  );
  const notes = useCheckoutStore((s) => s.notes);
  const prStatuses = useWorkspaceStore((s) => s.prStatuses);
  const sessionsByPty = useAgentStore((s) => s.sessionsByPty);
  const sessions = useAgentStore((s) => s.sessions);
  const health = useAgentStore((s) => s.health);
  const tick = useActivityTick();

  return useMemo(() => {
    if (!workspaceId) return NO_PROJECTS;
    const store = useWorkspaceStore.getState();
    const paths = pathsKey ? pathsKey.split("\n") : [];
    const pods = store.flightLayouts[workspaceId]?.pods ?? [];

    const checkouts: Record<string, SidebarCheckoutInput> = {};
    const cwds = new Set<string>([...paths, ...pods.map((p) => p.cwd)]);
    for (const cwd of cwds) {
      const h = health[cwd];
      checkouts[cwd] = {
        cwd,
        manualBusy: notes[cwd]?.busy,
        inConversation: checkoutInUse(cwd, sessions),
        label: notes[cwd]?.label,
        origin: h?.origin_url ?? "",
        branch: store.gitStatuses[cwd]?.branch ?? h?.branch ?? null,
        dirty: h?.dirty ?? store.gitStatuses[cwd]?.dirty ?? false,
        pr: prStatuses[cwd] ?? null,
      };
    }

    const now = Date.now();
    const podInputs: SidebarPodInput[] = pods.map((p) => {
      const { activity, title, mismatches, session } = readPodActivity(p.id, p.cwd, sessionsByPty, health[p.cwd] ?? null, now);
      return {
        id: p.id,
        type: p.type,
        cwd: p.cwd,
        name: p.label ?? folderName(p.cwd),
        hidden: !!p.stashed,
        task: p.task,
        activity,
        topic: title && title.claude !== "none" ? title.title : null,
        sessionStartedAt: session?.started_at ?? null,
        mismatches,
      };
    });

    return buildSidebarModel({ paths, checkouts, pods: podInputs });
    // podsKey/branchesKey/tick are change signals; their content is re-read from the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, pathsKey, podsKey, branchesKey, prStatuses, sessionsByPty, sessions, health, tick, notes]);
}
