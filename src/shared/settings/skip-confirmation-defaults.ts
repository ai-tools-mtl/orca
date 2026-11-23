import type { GlobalSettings } from './global-settings-types'

export function buildDefaultSkipConfirmations(): Pick<
  GlobalSettings,
  | 'skipDeleteWorktreeConfirm'
  | 'alwaysForceDeleteWorktrees'
  | 'alwaysForceDeletePreservedBranches'
  | 'skipCloseTerminalWithRunningProcessConfirm'
  | 'skipDeleteAutomationConfirm'
  | 'skipDeleteArtifactConfirm'
  | 'skipCodexRateLimitResetConfirm'
  | 'skipDeleteChatConfirm'
> {
  return {
    skipDeleteWorktreeConfirm: false,
    alwaysForceDeleteWorktrees: false,
    alwaysForceDeletePreservedBranches: false,
    skipCloseTerminalWithRunningProcessConfirm: false,
    skipDeleteAutomationConfirm: false,
    skipDeleteArtifactConfirm: false,
    skipCodexRateLimitResetConfirm: false,
    skipDeleteChatConfirm: false
  }
}
