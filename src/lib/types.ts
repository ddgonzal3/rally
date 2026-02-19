export interface Workspace {
  id: string;
  name: string;
  path: string;
  repo_url: string;
  branch: string;
  main_branch: string;
  processes: ProcessConfig[];
}

export interface ProcessConfig {
  name: string;
  command: string;
  cwd?: string;
  auto_start: boolean;
}

export interface GitStatus {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  modified_files: string[];
  untracked_files: string[];
}

export type PaneType = "claude" | "terminal" | "watcher" | "file-explorer";

export interface Pane {
  id: string;
  type: PaneType;
  title: string;
  command?: string; // specific command to run (undefined = default shell)
}

export function createDefaultPanes(workspaceName: string): Pane[] {
  return [
    {
      id: crypto.randomUUID(),
      type: "claude",
      title: `Claude Code — ${workspaceName}`,
      command: "claude --dangerously-skip-permissions",
    },
    {
      id: crypto.randomUUID(),
      type: "terminal",
      title: `Terminal — ${workspaceName}`,
    },
    {
      id: crypto.randomUUID(),
      type: "terminal",
      title: `Shell 1 — ${workspaceName}`,
    },
    {
      id: crypto.randomUUID(),
      type: "terminal",
      title: `Shell 2 — ${workspaceName}`,
    },
  ];
}
