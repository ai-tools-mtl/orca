import { humanizeBranchSlug } from '../../../shared/source-control/ai/naming/branch-name-from-work'
import type { FirstWorkBranchRenameDeps } from './first-work-branch-rename'
import { generateFirstWorkBranchSlug } from './first-work-branch-name-generation'
import { retryFailedGeneration } from './first-work-generation-backoff'

export async function runFolderWorkspaceTitleAutoRename(
  worktreeId: string,
  prompt: string,
  assistantMessage: string | undefined,
  deps: FirstWorkBranchRenameDeps,
  stop: (reason: string, clearError?: boolean) => true,
  retry: (reason: string) => false,
  sessionAgentId?: string
): Promise<boolean> {
  if (deps.isFolderWorkspaceWslMoveBlocked?.(worktreeId) === true) {
    return retry('a WSL move is taking the workspace')
  }
  if (deps.isPendingFirstAgentMessageRename?.(worktreeId) !== true) {
    return stop('folder workspace is not pending title rename', true)
  }
  const folderPath = deps.getFolderWorkspacePath?.(worktreeId)
  if (!folderPath) {
    return stop('folder workspace path unavailable')
  }

  const originalDisplayName = deps.getCurrentDisplayName(worktreeId)
  const settings = deps.getSettings()
  const generation = await generateFirstWorkBranchSlug({
    cwd: folderPath,
    context: { firstPrompt: prompt, assistantMessage },
    settings,
    repo: null,
    hostKey: 'local',
    envResolvers: deps.getAgentEnvResolvers(),
    sessionAgentId
  })
  if (generation.kind === 'no-agent') {
    deps.setRenameError(worktreeId, generation.error)
    return stop(`no generation agent: ${generation.error}`)
  }
  if (generation.kind === 'no-target') {
    deps.setRenameError(worktreeId, 'Could not prepare the workspace-name generation environment.')
    return retry('could not prepare generation environment')
  }
  // Generation may outlive a manual rename or workspace removal.
  if (
    deps.isPendingFirstAgentMessageRename?.(worktreeId) !== true ||
    deps.getCurrentDisplayName(worktreeId) !== originalDisplayName
  ) {
    return stop('folder workspace changed during generation', true)
  }
  if (deps.isFolderWorkspaceWslMoveBlocked?.(worktreeId) === true) {
    return retry('a WSL move started during generation')
  }
  if (generation.kind === 'no-agent-installed') {
    return stop('no installed naming agent for workspace title', true)
  }
  if (generation.kind === 'generation-failed') {
    return retryFailedGeneration(worktreeId, generation.generated, deps, retry)
  }

  const newDisplayName = humanizeBranchSlug(generation.slug)
  deps.setDisplayName(worktreeId, newDisplayName)
  deps.setRenameError(worktreeId, null)
  deps.onRenamed(worktreeId)
  console.info(`[auto-branch-rename] renamed folder workspace title -> "${newDisplayName}"`)
  return true
}
