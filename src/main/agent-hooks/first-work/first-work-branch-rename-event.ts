export type FirstWorkBranchRenameEvent = {
  paneKey: string
  /** Untrusted agent echo; use only as a fallback. */
  worktreeId: string | undefined
  tabId: string | undefined
  state: string
  prompt: string | undefined
  assistantMessage: string | undefined
  isReplay: boolean | undefined
  /** The conversation's own agent (hook source / session provider); it ran, so it is installed. */
  sessionAgentId: string | undefined
}
