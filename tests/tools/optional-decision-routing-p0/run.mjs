#!/usr/bin/env node
/** Opt-in runner for the P0 targeted-delivery validation (docs/reference/optional-decision-routing-plan.md §9).
 *  Drives the real runtime + a real authenticated codex structured worker through the strict routing entry.
 *
 *  Usage: P0_ROUTING_RUN=1 node tests/tools/optional-decision-routing-p0/run.mjs [--keep]
 *  - requires `pnpm build:cli` + `npx electron-vite build --mode e2e` (the Playwright global
 *    setup rebuilds unless SKIP_BUILD=1)
 *  - `--keep` preserves the app fixture artifacts (worktrees, evidence json) under test-results/
 *  Without P0_ROUTING_RUN=1 this only prints instructions, so plain CI never spawns real agents. */

import { spawnSync } from 'node:child_process'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..', '..', '..')
const args = process.argv.slice(2)

if (process.env.P0_ROUTING_RUN !== '1') {
  console.log(
    'P0 is opt-in: it spawns the REAL codex app-server and a real headless Orca runtime.\n' +
      'Prereqs: `pnpm build:cli` and an authenticated `codex` binary.\n' +
      'Run: P0_ROUTING_RUN=1 node tests/tools/optional-decision-routing-p0/run.mjs [--keep]'
  )
  process.exit(0)
}
if (spawnSync('codex', ['--version'], { encoding: 'utf8' }).status !== 0) {
  console.error('p0: codex binary not available on PATH')
  process.exit(1)
}

const result = spawnSync(
  path.join(REPO, 'node_modules', '.bin', 'playwright'),
  [
    'test',
    'tests/e2e/optional-decision-routing-p0.spec.ts',
    '--config',
    'tests/playwright.config.ts',
    '--project=electron-headless'
  ],
  {
    stdio: 'inherit',
    cwd: REPO,
    env: {
      ...process.env,
      P0_ROUTING_RUN: '1',
      ORCA_BACKGROUND_LAUNCH: '1',
      ...(args.includes('--keep') ? { P0_KEEP_FIXTURE: '1' } : {})
    }
  }
)
process.exit(result.status ?? 1)
