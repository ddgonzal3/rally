export const REQUEST_NEW_TERMINAL_CWD_EVENT = "rally:request-new-terminal-cwd";

export interface RequestNewTerminalCwdDetail {
  workspaceId: string;
  groupId: string;
}
