import { humanizeBranchSlug } from '../../../shared/source-control/ai/naming/branch-name-from-work'
import type { FirstWorkBranchRenameDeps } from './first-work-branch-rename'
import { generateFirstWorkBranchSlug } from './first-work-branch-name-generation'
import {
  failedGenerationVerdict,
  resolveFirstWorkContext,
  type FirstWorkContextSource,
  type FirstWorkVerdictBuilders
} from './first-work-rename-verdicts'
import type { FirstWorkAttempt, FirstWorkRenameVerdict } from './first-work-rename-attempts'
import { WORKSPACE_NAME_ENVIRONMENT_FAILED_HEADLINE } from '../../../shared/worktree/branch-auto-rename-failure-headlines'

export async function runFolderWorkspaceTitleAutoRename(
  worktreeId: string,
  source: FirstWorkContextSource,
  deps: FirstWorkBranchRenameDeps,
  attempt: FirstWorkAttempt,
  verdicts: FirstWorkVerdictBuilders
): Promise<FirstWorkRenameVerdict> {
  const { stop, defer, failed } = verdicts
  if (deps.isFolderWorkspaceWslMoveBlocked?.(worktreeId) === true) {
    return defer('project-moving', 'a WSL move is taking the workspace')
  }
  if (deps.isPendingFirstAgentMessageRename?.(worktreeId) !== true) {
    return stop('already-named', 'folder workspace is not pending title rename', true)
  }
  const folderPath = deps.getFolderWorkspacePath?.(worktreeId)
  if (!folderPath) {
    return stop('unavailable', 'folder workspace path unavailable')
  }

  const originalDisplayName = deps.getCurrentDisplayName(worktreeId)
  const settings = deps.getSettings()
  const resolved = await resolveFirstWorkContext(source, attempt)
  if (resolved.kind === 'outcome') {
    return { outcome: resolved.outcome, settles: false }
  }
  // Agent preference: an explicit settings pick, then the conversation's own agent, then an
  // installed-agent probe when the factory-default binary is missing.
  const generation = await generateFirstWorkBranchSlug({
    cwd: folderPath,
    context: resolved.context,
    settings,
    repo: null,
    hostKey: 'local',
    envResolvers: deps.getAgentEnvResolvers(),
    sessionAgentId: resolved.sessionAgentId
  })
  // Generation may outlive a manual rename or workspace removal.
  if (
    deps.isPendingFirstAgentMessageRename?.(worktreeId) !== true ||
    deps.getCurrentDisplayName(worktreeId) !== originalDisplayName
  ) {
    return stop('already-named', 'folder workspace changed during generation', true)
  }
  if (deps.isFolderWorkspaceWslMoveBlocked?.(worktreeId) === true) {
    return defer('project-moving', 'a WSL move started during generation')
  }
  if (generation.kind === 'no-agent') {
    deps.setRenameError(worktreeId, generation.error)
    return failed(`no generation agent: ${generation.error}`, true)
  }
  if (generation.kind === 'no-target') {
    deps.setRenameError(worktreeId, WORKSPACE_NAME_ENVIRONMENT_FAILED_HEADLINE)
    return failed('could not prepare generation environment', false)
  }
  if (generation.kind === 'no-agent-installed') {
    // Nothing installed can name the workspace; retrying cannot change that.
    return stop('unavailable', 'no installed naming agent for workspace rename', true)
  }
  if (generation.kind === 'generation-failed') {
    return failedGenerationVerdict(worktreeId, generation.generated, deps, verdicts)
  }
  if (!deps.getSettings().autoRenameBranchFromWork) {
    return {
      ...stop('setting-off', 'auto-rename was turned off during generation'),
      settles: false
    }
  }

  const newDisplayName = humanizeBranchSlug(generation.slug)
  deps.setDisplayName(worktreeId, newDisplayName)
  deps.setRenameError(worktreeId, null)
  deps.onRenamed(worktreeId)
  console.info(`[auto-branch-rename] renamed folder workspace title -> "${newDisplayName}"`)
  return { outcome: { kind: 'renamed' }, settles: true }
}
