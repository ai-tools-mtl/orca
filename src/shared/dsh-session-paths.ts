import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveAbsoluteDirOverride } from './file-access/absolute-dir-override'

export type DshSessionPathEnv =
  | NodeJS.ProcessEnv
  | Partial<Record<'DSH_HOME' | 'HOME' | 'USERPROFILE', string | undefined>>

/** Resolve DSH's configured home, falling back to the runtime user's home. */
export function resolveDshHomeDir(
  env: DshSessionPathEnv = process.env,
  homeDir: string = homedir()
): string {
  return resolveAbsoluteDirOverride(env.DSH_HOME, join(homeDir, '.dsh'))
}

export function resolveDshSessionsDir(
  env: DshSessionPathEnv = process.env,
  homeDir: string = homedir()
): string {
  return join(resolveDshHomeDir(env, homeDir), 'sessions')
}
