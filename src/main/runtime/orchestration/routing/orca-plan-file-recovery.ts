import { readFileSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'

import { candidateOrcaPlanReportFiles, parseOrcaPlan, type OrcaPlanParse } from './orca-plan-parse'

const MAX_PROBE_FILE_BYTES = 1024 * 1024

/** Recover an orca-plan the worker saved to a workspace file instead of embedding the fence in
 *  its report body: probe the report's markdown/text files (path-safe, size-capped) and return
 *  the first parse that yields stages — null when nothing recovers (keep the body's verdict). */
export function recoverOrcaPlanFromReportFiles(
  report: { body?: string; filesModified?: string[] },
  worktreePath: string | undefined
): OrcaPlanParse | null {
  if (!worktreePath) {
    return null
  }
  const root = resolve(worktreePath)
  for (const relative of candidateOrcaPlanReportFiles(report.body, report.filesModified)) {
    const full = resolve(root, relative)
    if (!full.startsWith(root + sep)) {
      continue
    }
    try {
      if (statSync(full).size > MAX_PROBE_FILE_BYTES) {
        continue
      }
      const parsed = parseOrcaPlan(readFileSync(full, 'utf8'))
      if (parsed.status === 'ok') {
        return parsed
      }
    } catch {
      // Missing/unreadable candidate — probe the next one.
    }
  }
  return null
}
