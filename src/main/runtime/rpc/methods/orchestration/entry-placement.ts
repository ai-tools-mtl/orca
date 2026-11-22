import type { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'

export type EntryPlacement = {
  agents: TuiAgent[]
  supportsReadOnly: boolean
  repo: string
  folderId?: string
  /** Explicit base for new-top-level starts when the repo has no configured base ref and the
   *  default resolution can fail (no remote, unusual branch): the primary worktree's branch. */
  baseFallback?: string
  /** The base branch is unborn (zero commits) — creation must seed the initial commit. */
  unborn?: boolean
}

/** Resolve one project entry's placement: the installed agent pool, read-only support, and the
 *  workspace the dispatch targets (the folder's own directory, or an explicit base for a new
 *  tree — with 空仓引导 opted in when the repo's branch is unborn). */
export async function entryPlacement(
  runtime: OrcaRuntimeService,
  group: string
): Promise<EntryPlacement> {
  const repo = `id:${group}`
  const launch = await runtime.detectProjectLaunchContext(repo)
  const placement = {
    repo,
    agents: launch.agents,
    supportsReadOnly:
      launch.executionContext.kind === 'host' &&
      launch.executionContext.projectRuntime.status === 'resolved' &&
      launch.executionContext.projectRuntime.runtime.kind === 'local-host'
  }
  if (launch.workspaceKind !== 'folder') {
    // A repo with a configured base ref needs no help; otherwise hand the worktree creation an
    // explicit base (the primary worktree's own branch) so entry dispatches do not die on
    // "could not resolve a default base ref" for remote-less or oddly-branched repos.
    const repoRow = runtime
      .requireStore()
      .getRepos()
      .find((candidate) => candidate.id === group)
    if (repoRow?.worktreeBaseRef) {
      return placement
    }
    const { worktrees } = await runtime.listManagedWorktrees(repo)
    const primary = worktrees.find((worktree) => worktree.isMainWorktree) ?? worktrees[0]
    if (!primary?.branch) {
      return placement
    }
    try {
      const localBranches = await runtime.listRuntimeGitLocalBranches(repo)
      const unborn = localBranches.branches.length === 0
      return { ...placement, baseFallback: unborn ? 'main' : primary.branch, unborn }
    } catch {
      // No branch probe (tests, non-local hosts): keep the plain branch hint.
      return { ...placement, baseFallback: primary.branch }
    }
  }
  const { worktrees } = await runtime.listManagedWorktrees(repo)
  const workspace = worktrees[0]
  if (!workspace) {
    throw new OrchestrationError('invalid_argument', 'The project folder workspace is unavailable.')
  }
  return { ...placement, folderId: workspace.id }
}
