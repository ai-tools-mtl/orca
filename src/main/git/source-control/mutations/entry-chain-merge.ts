import { gitOptionsForWorktree } from '../../command-runner/git-runtime-options'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { commitChanges } from './commit-changes'
import { stageWorktreeChanges } from './staging'

export type EntryChainMergeReceipt = {
  /** Chain-worktree commit carrying the checkpoint output; null when nothing needed merging. */
  commitSha: string | null
  baseBranch: string
  ffApplied: boolean
}

export type EntryChainMergeOutcome =
  | { ok: true; receipt: EntryChainMergeReceipt }
  | { ok: false; error: string }

async function gitString(worktreePath: string, args: string[]): Promise<string> {
  const { stdout } = await gitExecFileAsync(args, gitOptionsForWorktree(worktreePath))
  return stdout.trim()
}

async function currentBranch(worktreePath: string): Promise<string | null> {
  const ref = await gitString(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return ref === 'HEAD' ? null : ref
}

async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  const { stdout } = await gitExecFileAsync(
    ['status', '--porcelain'],
    gitOptionsForWorktree(worktreePath)
  )
  return stdout.trim().length > 0
}

/** The repo's main checkout — `worktree list` always reports it first. */
async function mainWorktreePath(fromWorktreePath: string): Promise<string> {
  const { stdout } = await gitExecFileAsync(
    ['worktree', 'list', '--porcelain'],
    gitOptionsForWorktree(fromWorktreePath)
  )
  const line = stdout.split('\n').find((entry) => entry.startsWith('worktree '))
  return (line?.slice('worktree '.length) ?? '').trim()
}

/** Merge an entry stage chain's shared worktree into the repo's main checkout (pipeline §8):
 *  commit the accumulated output on the chain branch, then fast-forward the base branch —
 *  local only, never pushes. Dirty base worktree or diverged tips stop with a clear error
 *  instead of forcing anything; idempotent (already-merged tips are a no-op receipt). */
export async function mergeEntryChainWorktree(args: {
  chainWorktreePath: string
  commitMessage: string
}): Promise<EntryChainMergeOutcome> {
  const { chainWorktreePath, commitMessage } = args
  try {
    const chainBranch = await currentBranch(chainWorktreePath)
    if (!chainBranch) {
      return { ok: false, error: '链工作树处于游离 HEAD 状态，无法确定要合并的分支。' }
    }

    let commitSha: string | null = null
    if (await hasUncommittedChanges(chainWorktreePath)) {
      await stageWorktreeChanges(chainWorktreePath, 'all')
      const committed = await commitChanges(chainWorktreePath, commitMessage)
      if (!committed.success) {
        return { ok: false, error: `链工作树提交失败：${committed.error ?? '未知错误'}` }
      }
    }
    commitSha = await gitString(chainWorktreePath, ['rev-parse', 'HEAD'])

    const mainPath = await mainWorktreePath(chainWorktreePath)
    if (!mainPath) {
      return { ok: false, error: '无法定位仓库主工作树。' }
    }
    const baseBranch = await currentBranch(mainPath)
    if (!baseBranch) {
      return { ok: false, error: '主工作树处于游离 HEAD 状态，无法确定合并目标分支。' }
    }
    if (await hasUncommittedChanges(mainPath)) {
      return {
        ok: false,
        error: '主分支工作区有未提交改动，无法安全合并——请先处理后再重试。'
      }
    }

    // Already carried: chain tip is an ancestor of the base tip — nothing to fast-forward.
    const baseOfChain = await gitString(mainPath, ['merge-base', baseBranch, chainBranch])
    if (baseOfChain === (await gitString(mainPath, ['rev-parse', chainBranch]))) {
      return { ok: true, receipt: { commitSha: null, baseBranch, ffApplied: false } }
    }

    try {
      await gitExecFileAsync(['merge', '--ff-only', chainBranch], gitOptionsForWorktree(mainPath))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const notFastForward = /not possible to fast-forward|divergent/i.test(message)
      return {
        ok: false,
        error: notFastForward
          ? '链分支与主分支已分叉，无法快进合并——请人工处理。'
          : `主分支合并失败：${message}`
      }
    }
    return { ok: true, receipt: { commitSha, baseBranch, ffApplied: true } }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
