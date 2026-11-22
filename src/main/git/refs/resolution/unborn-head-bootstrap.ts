import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import type { LocalGitExecOptions } from './repo-default-base-ref'

// 空仓引导 (entry-stage-pipeline-plan §5.6): a zero-commit repo's HEAD names a branch no ref
// backs, so no worktree can be cut and multi-branch development has no base. The entry's
// placement calls bootstrapUnbornRepoMain before assigning work — the unborn HEAD is pointed at
// refs/heads/main and one clearly-authored empty commit is seeded. Opt-in: only the entry
// dispatch and its creation request pass it; UI/manual creates keep the strict refusal.

/** True when HEAD names a branch that no commit backs (git init without a first commit). */
export async function isUnbornRepoHead(
  repoPath: string,
  options: LocalGitExecOptions
): Promise<boolean> {
  try {
    await gitExecFileAsync(['rev-parse', '--verify', '--quiet', 'HEAD'], {
      cwd: repoPath,
      ...options
    })
    return false
  } catch {
    return true
  }
}

/** Point the unborn HEAD at refs/heads/main and seed the initial empty commit there, so the
 *  canonical base branch exists before any task assignment. The repo's own identity config
 *  wins when present; a machine without any git identity still bootstraps under Orca's. */
export async function bootstrapUnbornRepoMain(
  repoPath: string,
  options: LocalGitExecOptions
): Promise<void> {
  if (!(await isUnbornRepoHead(repoPath, options))) {
    return
  }
  let head = ''
  try {
    head = (
      await gitExecFileAsync(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        cwd: repoPath,
        ...options
      })
    ).stdout.trim()
  } catch {
    return
  }
  if (head.length > 0 && head !== 'main') {
    await gitExecFileAsync(['symbolic-ref', 'HEAD', 'refs/heads/main'], {
      cwd: repoPath,
      ...options
    })
  }
  const message = 'Initial commit (Orca 空仓引导)'
  try {
    await gitExecFileAsync(['commit', '--allow-empty', '--no-verify', '-m', message], {
      cwd: repoPath,
      ...options
    })
  } catch {
    await gitExecFileAsync(
      [
        '-c',
        'user.name=Orca',
        '-c',
        'user.email=orca@bootstrap.local',
        'commit',
        '--allow-empty',
        '--no-verify',
        '-m',
        message
      ],
      { cwd: repoPath, ...options }
    )
  }
}
