#!/usr/bin/env node
/** Opt-in runner for the 阶段化生命周期 P0 (docs/reference/entry-stage-pipeline-plan.md §11).
 *  Drives the real runtime + the fake codex stand-in through the desktop entry's stage chain:
 *  需求提交 → 原型设计 → 用户门 → 任务设计(orca-plan) → 用户门 → 展开 → 同 worktree 实施 → 重启恢复.
 *
 *  Usage: ENTRY_STAGE_PIPELINE_P0_RUN=1 node tests/tools/entry-stage-pipeline-p0/run.mjs
 *  - requires the Playwright build (electron-headless project global setup builds out/).
 *  - spawns a fresh git project under the OS temp dir each run (新建工作目录). */

import { spawnSync } from 'node:child_process'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..', '..', '..')

if (process.env.ENTRY_STAGE_PIPELINE_P0_RUN !== '1') {
  console.log(
    '阶段化 P0 is opt-in: it launches a headless Orca app and fake structured workers.\n' +
      'Run: ENTRY_STAGE_PIPELINE_P0_RUN=1 node tests/tools/entry-stage-pipeline-p0/run.mjs'
  )
  process.exit(0)
}

const result = spawnSync(
  path.join(REPO, 'node_modules', '.bin', 'playwright'),
  [
    'test',
    'tests/e2e/entry-stage-pipeline-p0.spec.ts',
    '--config',
    'tests/playwright.config.ts',
    '--project=electron-headless'
  ],
  {
    stdio: 'inherit',
    cwd: REPO,
    env: {
      ...process.env,
      ENTRY_STAGE_PIPELINE_P0_RUN: '1',
      ORCA_BACKGROUND_LAUNCH: '1'
    }
  }
)
process.exit(result.status ?? 1)
