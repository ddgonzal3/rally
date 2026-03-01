import { useState, useCallback, useEffect, useRef } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { api } from "../lib/tauri";
import { addToast } from "../components/ToastContainer";
import {
  parseUnifiedDiff,
  createUntrackedDiffFile,
  type DiffFile,
} from "../lib/diffParser";
import type { ChangesSummary, CommitEntry } from "../lib/types";

interface UseGitDiffActionsOptions {
  rootPath: string | null;
  mainBranch: string;
  /** Whether to listen for changes and auto-fetch (default: true) */
  enabled?: boolean;
}

export function useGitDiffActions({
  rootPath,
  mainBranch,
  enabled = true,
}: UseGitDiffActionsOptions) {
  const setActiveTab = useWorkspaceStore((s) => s.setGitDiffActiveTab);
  const prStatus = useWorkspaceStore((s) =>
    rootPath ? s.prStatuses[rootPath] : null,
  );
  const refreshPrStatusForPath = useWorkspaceStore(
    (s) => s.refreshPrStatusForPath,
  );

  const [unstagedFiles, setUnstagedFiles] = useState<DiffFile[]>([]);
  const [stagedFiles, setStagedFiles] = useState<DiffFile[]>([]);
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [changes, setChanges] = useState<ChangesSummary | null>(null);
  const [diffStatAdd, setDiffStatAdd] = useState(0);
  const [diffStatDel, setDiffStatDel] = useState(0);
  const [loading, setLoading] = useState(true);
  const [revertConfirming, setRevertConfirming] = useState(false);
  const [creatingPr, setCreatingPr] = useState(false);

  const lastFetchedPath = useRef<string | null>(null);

  const fetchDiffs = useCallback(async () => {
    if (!rootPath) return;
    try {
      const [unstagedRaw, stagedRaw, changesData, stat, commitLog] =
        await Promise.all([
          api.gitDiff(rootPath, false),
          api.gitDiff(rootPath, true),
          api.gitChanges(rootPath),
          api.gitDiffStat(rootPath),
          api
            .gitCommitLog(rootPath, mainBranch)
            .catch(() => [] as CommitEntry[]),
        ]);
      const parsedUnstaged = parseUnifiedDiff(unstagedRaw);
      if (changesData.untracked.length > 0) {
        const untrackedDiffs = await Promise.all(
          changesData.untracked.map(async (filePath) => {
            try {
              const content = await api.readFileContent(
                `${rootPath}/${filePath}`,
              );
              return createUntrackedDiffFile(filePath, content);
            } catch {
              return createUntrackedDiffFile(filePath, "");
            }
          }),
        );
        parsedUnstaged.push(...untrackedDiffs);
      }
      setUnstagedFiles(parsedUnstaged);
      setStagedFiles(parseUnifiedDiff(stagedRaw));
      setChanges(changesData);
      setDiffStatAdd(stat[0]);
      setDiffStatDel(stat[1]);
      setCommits(commitLog);
    } catch (e) {
      console.error("Failed to fetch diffs:", e);
    } finally {
      setLoading(false);
      lastFetchedPath.current = rootPath ?? null;
    }
  }, [rootPath, mainBranch]);

  // Re-fetch when git status changes
  const gitStatusFingerprint = useWorkspaceStore((s) => {
    if (!rootPath) return "";
    const gs = s.gitStatuses[rootPath];
    if (!gs) return "";
    return `${gs.dirty}-${gs.modified_files.length}-${gs.untracked_files.length}`;
  });

  useEffect(() => {
    if (!enabled || !rootPath) return;
    if (lastFetchedPath.current !== rootPath) {
      setLoading(true);
    }
    fetchDiffs();
  }, [enabled, rootPath, fetchDiffs, gitStatusFingerprint]);

  // Auto-refresh on local git changes
  useEffect(() => {
    if (!enabled) return;
    const handler = () => fetchDiffs();
    document.addEventListener("rally:git-changes-refresh", handler);
    return () =>
      document.removeEventListener("rally:git-changes-refresh", handler);
  }, [enabled, fetchDiffs]);

  // --- Action handlers ---

  const handleStage = useCallback(
    async (filePath: string) => {
      if (!rootPath) return;
      try {
        await api.gitStageFile(rootPath, filePath);
      } catch (e) {
        addToast({ type: "warning", title: "Stage failed", message: String(e) });
      }
      fetchDiffs();
    },
    [rootPath, fetchDiffs],
  );

  const handleUnstage = useCallback(
    async (filePath: string) => {
      if (!rootPath) return;
      try {
        await api.gitUnstageFile(rootPath, filePath);
      } catch (e) {
        addToast({ type: "warning", title: "Unstage failed", message: String(e) });
      }
      fetchDiffs();
    },
    [rootPath, fetchDiffs],
  );

  const handleDiscard = useCallback(
    async (filePath: string) => {
      if (!rootPath || !changes) return;
      try {
        const isUntracked = changes.untracked.includes(filePath);
        await api.gitDiscardFile(rootPath, filePath, isUntracked);
      } catch (e) {
        addToast({ type: "warning", title: "Discard failed", message: String(e) });
      }
      fetchDiffs();
    },
    [rootPath, changes, fetchDiffs],
  );

  const handleRevertAll = useCallback(async () => {
    if (!rootPath || !changes) return;
    if (!revertConfirming) {
      setRevertConfirming(true);
      setTimeout(() => setRevertConfirming(false), 3000);
      return;
    }
    setRevertConfirming(false);
    const allFiles = [
      ...changes.unstaged.map((f) => f.path),
      ...changes.untracked,
    ];
    for (const f of allFiles) {
      const isUntracked = changes.untracked.includes(f);
      await api.gitDiscardFile(rootPath, f, isUntracked);
    }
    fetchDiffs();
  }, [rootPath, changes, revertConfirming, fetchDiffs]);

  const handleStageAll = useCallback(async () => {
    if (!rootPath || !changes) return;
    const allFiles = [
      ...changes.unstaged.map((f) => f.path),
      ...changes.untracked,
    ];
    for (const f of allFiles) await api.gitStageFile(rootPath, f);
    await fetchDiffs();
    setActiveTab("staged");
  }, [rootPath, changes, fetchDiffs, setActiveTab]);

  const handleUnstageAll = useCallback(async () => {
    if (!rootPath || !changes) return;
    for (const f of changes.staged) await api.gitUnstageFile(rootPath, f.path);
    await fetchDiffs();
    setActiveTab("unstaged");
  }, [rootPath, changes, fetchDiffs, setActiveTab]);

  const handleCreatePr = useCallback(async () => {
    if (!rootPath) return;
    setCreatingPr(true);
    try {
      const url = await api.gitCreatePr(rootPath);
      addToast({ type: "success", title: "PR created", message: url });
      refreshPrStatusForPath(rootPath).catch(() => {});
    } catch (e) {
      addToast({ type: "warning", title: "Create PR failed", message: String(e) });
    } finally {
      setCreatingPr(false);
    }
  }, [rootPath, refreshPrStatusForPath]);

  // Derived values
  const unstagedCount =
    (changes?.unstaged.length ?? 0) + (changes?.untracked.length ?? 0);
  const stagedCount = changes?.staged.length ?? 0;
  const hasStaged = stagedCount > 0;
  const hasPr = !!(prStatus && prStatus.state === "OPEN");
  const createPrVisible = !hasPr && commits.length > 0;

  return {
    unstagedFiles,
    stagedFiles,
    commits,
    changes,
    diffStatAdd,
    diffStatDel,
    loading,
    fetchDiffs,
    handleStage,
    handleUnstage,
    handleDiscard,
    handleRevertAll,
    revertConfirming,
    handleStageAll,
    handleUnstageAll,
    handleCreatePr,
    creatingPr,
    unstagedCount,
    stagedCount,
    hasStaged,
    hasPr,
    createPrVisible,
  };
}
