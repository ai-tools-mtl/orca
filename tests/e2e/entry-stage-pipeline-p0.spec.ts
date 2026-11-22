/** P0 validation for docs/reference/entry-stage-pipeline-plan.md §11, against the real runtime
 *  and the fake codex stand-in, through the desktop entry's stage chain:
 *  需求提交 → 决策二分类 → 规划模板（原型+任务设计） → 用户门 ×2 → orca-plan 展开 →
 *  同 worktree 依赖序实施 → 重启恢复不重复展开.
 *
 *  Opt-in: ENTRY_STAGE_PIPELINE_P0_RUN=1. Run via tests/tools/entry-stage-pipeline-p0. */

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test, type ElectronApplication } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime/client'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

const OPT_IN = process.env.ENTRY_STAGE_PIPELINE_P0_RUN === '1'

test.skip(
  !OPT_IN,
  '阶段化 P0 launches a headless app with fake structured workers; run tests/tools/entry-stage-pipeline-p0'
)

type SubActionFacts = {
  sub_action_id: string
  text: string
  task_id: string | null
  stage_kind: string | null
  gate: string | null
  gate_granted_at: string | null
  plan_json: string | null
}

type EntryShowResult = {
  run: { id: string } | null
  inputs: {
    input: { input_id: string }
    subActions: {
      subAction: SubActionFacts
      execution: {
        worktreeId: string | null
        status: string
        result: string | null
        completedAt: string | null
      } | null
    }[]
  }[]
}

/** The decision-model endpoint: the classification call must answer needsPlanning with a
 *  prototype so the entry registers the 规划模板 instead of free sub-actions. */
function startDecisionModelStub(): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString()
    })
    request.on('end', () => {
      let system = ''
      try {
        const parsed: unknown = JSON.parse(body)
        if (
          parsed &&
          typeof parsed === 'object' &&
          'messages' in parsed &&
          Array.isArray((parsed as { messages?: unknown }).messages)
        ) {
          const first = (parsed as { messages: { role?: string; content?: string }[] }).messages[0]
          if (first?.role === 'system' && typeof first.content === 'string') {
            system = first.content
          }
        }
      } catch {}
      let content: string
      if (system.includes('routing step of a work dispatcher')) {
        content = JSON.stringify({
          subActions: [],
          reason: '需求较大，走规划流程：先原型设计，再任务设计，经确认后实施。',
          needsPlanning: true,
          needsPrototype: true
        })
      } else if (system.includes('pick the reviewer')) {
        content = JSON.stringify({ agent: 'claude' })
      } else {
        content = JSON.stringify({ subActions: [], reason: 'stub: unknown prompt' })
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content } }] }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        close: () => server.close()
      })
    })
  })
}

test('阶段化 P0: 原型 → 门 → 计划 → 门 → 展开 → 同树实施 → 重启恢复', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  test.setTimeout(15 * 60_000)

  // 新建工作目录: every run gets a fresh git project; the chain's worktrees live under it.
  const project = mkdtempSync(path.join(os.tmpdir(), 'stage-pipeline-project-'))
  const git = (args: string[]) => spawnSync('git', args, { cwd: project, encoding: 'utf8' })
  git(['init'])
  git(['config', 'user.email', 'stage-p0@example.com'])
  git(['config', 'user.name', 'stage-p0'])
  writeFileSync(path.join(project, 'README.md'), '# stage pipeline fixture\n')
  writeFileSync(path.join(project, 'requirement.txt'), '按需求说明书实现设置页（详见入口请求）。\n')
  git(['add', '.'])
  git(['commit', '-m', 'stage pipeline fixture'])
  const marker = `MARKER-${randomUUID().slice(0, 8)}`
  const requirement = `做一个设置页（需求标记 ${marker}）：先出原型设计，再拆任务，确认后实施。`

  const stub = await startDecisionModelStub()
  const shims = path.join(testInfo.outputDir, 'stage-shims')
  mkdirSync(shims, { recursive: true })
  const fakeSource = readFileSync(
    path.join(process.cwd(), 'tests/tools/entry-stage-pipeline-p0/fake-codex-appserver.mjs'),
    'utf8'
  )
  // The worker child's PATH may not carry node: pin this driver's absolute node as the shebang.
  const fakeEntry = path.join(
    process.cwd(),
    'tests/tools/entry-stage-pipeline-p0/.fake-codex-appserver-pinned.mjs'
  )
  writeFileSync(fakeEntry, fakeSource.replace(/^#!.*$/m, `#!${process.execPath}`))
  chmodSync(fakeEntry, 0o755)
  const cliEntry = path.join(process.cwd(), 'out/cli/index.js')
  writeFileSync(
    path.join(shims, 'codex'),
    `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeEntry)} "$@"\n`
  )
  writeFileSync(
    path.join(shims, 'orca'),
    `#!/bin/bash\nexec node ${JSON.stringify(cliEntry)} "$@"\n`
  )
  // The template's role hints point at claude/dsh first, and prototype review would pull zcode:
  // hide the real CLIs from agent detection so every stage/role still lands on the fake codex
  // channel (hints fall back to codex; no reviewer candidates → stages settle at completion).
  for (const hidden of ['claude', 'dsh', 'zcode']) {
    writeFileSync(path.join(shims, hidden), '#!/bin/bash\nexit 1\n')
    chmodSync(path.join(shims, hidden), 0o755)
  }
  chmodSync(path.join(shims, 'codex'), 0o755)
  chmodSync(path.join(shims, 'orca'), 0o755)

  const appLog: string[] = []
  const session = createRestartSession(testInfo, {
    PATH: `${shims}${path.delimiter}${process.env.PATH ?? ''}`,
    FAKE_CODEX_TRACE: path.join(testInfo.outputDir, 'fake-codex-trace.log')
  })
  let current: ElectronApplication | null = null
  try {
    const first = await session.launch({ onStderr: (chunk: string) => appLog.push(chunk) })
    current = first.app
    let clientInstance: RuntimeClient | null = null
    const client = (): RuntimeClient => {
      clientInstance ??= new RuntimeClient(session.userDataDir, 60_000, null, null)
      return clientInstance
    }
    const repoId = await first.page.evaluate(async (repoPath) => {
      const result = await window.api.repos.add({ path: repoPath })
      if ('error' in result) {
        throw new Error(result.error)
      }
      return result.repo.id
    }, project)
    await attachRepoAndOpenTerminal(first.page, project)
    await first.page.evaluate(
      async ({ surface, mode, envPath }) => {
        await window.__store?.getState().updateSettings({
          agentDefaultSurface: surface,
          nativeChatPermissionMode: mode,
          disabledTuiAgents: [],
          agentDefaultEnv: {
            codex: { PATH: envPath },
            zcode: { PATH: envPath },
            claude: { PATH: envPath }
          }
        })
      },
      {
        surface: 'chat' as const,
        mode: 'full-access' as const,
        envPath: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`
      }
    )
    await client().call('settings.mutateAgentLaunch', {
      type: 'command',
      agent: 'codex',
      value: fakeEntry
    })

    const show = async (): Promise<EntryShowResult> => {
      const response = await client().call<EntryShowResult>('orchestration.entryShow', {
        group: repoId
      })
      return response.result
    }
    const inputRows = () => show().then((result) => result.inputs[0]?.subActions ?? [])
    const stages = async () => {
      const rows = await inputRows()
      return rows.map((entry) => ({
        facts: entry.subAction,
        execution: entry.execution
      }))
    }

    const submitted = await client().call<{
      run: { id: string }
      input: { input_id: string }
    }>('orchestration.entrySubmit', { group: repoId, text: requirement })
    // dispatch:true 是人员操作（requireEntryOperator 拒绝 CLI）；阶段行的派发本来就归泵，
    // 由下面的 entryShow 轮询驱动。
    const autoRouted = await client().call<{ routed: boolean; reason?: string }>(
      'orchestration.entryAutoRoute',
      {
        group: repoId,
        input: submitted.result.input.input_id,
        decisionModel: {
          source: 'custom',
          baseUrl: `http://127.0.0.1:${stub.port}`,
          apiKey: 'stub-key',
          modelId: 'stub-model'
        }
      }
    )
    expect(
      autoRouted.result.routed,
      `决策二分类应登记规划模板: ${JSON.stringify(autoRouted.result)}`
    ).toBe(true)

    const pollStages = async (
      label: string,
      timeoutMs: number,
      predicate: (rows: Awaited<ReturnType<typeof stages>>) => boolean
    ): Promise<Awaited<ReturnType<typeof stages>>> => {
      let last: Awaited<ReturnType<typeof stages>> = []
      try {
        await expect
          .poll(
            async () => {
              last = await stages()
              return predicate(last) ? last : null
            },
            { timeout: timeoutMs, intervals: [1_500] }
          )
          .not.toBeNull()
      } catch (error) {
        // 超时时落盘现场：阶段账本事实 + app stderr 尾部，避免盲猜。
        writeFileSync(
          path.join(testInfo.outputDir, `stage-timeout-${label}.json`),
          JSON.stringify({ stages: last, appLogTail: appLog.join('').slice(-6000) }, null, 2)
        )
        throw error
      }
      return last
    }

    // 规划模板已登记（需求拆解先行）：需求澄清 → 原型 → 任务设计，各带用户门。
    const planned = await pollStages('规划模板登记', 60_000, (rows) => rows.length === 3)
    expect(planned[0]!.facts.stage_kind).toBe('plan')
    expect(planned[0]!.facts.gate).toBe('user_confirm')
    expect(planned[1]!.facts.stage_kind).toBe('prototype')
    expect(planned[1]!.facts.gate).toBe('user_confirm')
    expect(planned[2]!.facts.stage_kind).toBe('plan')
    const clarificationId = planned[0]!.facts.sub_action_id
    const prototypeId = planned[1]!.facts.sub_action_id
    const planId = planned[2]!.facts.sub_action_id

    // 需求澄清阶段由泵派发并结算；报告携带需求标记（需求原文 → 阶段 spec 的注入证明）。
    const settledClarification = await pollStages(
      '需求澄清结算',
      180_000,
      (rows) => rows[0]?.execution?.completedAt !== null && rows[0]?.execution !== null
    )
    expect(settledClarification[0]!.execution!.result).toContain(marker)

    // 确认前零推进：需求澄清已结算，原型在连续两次泵轮询后仍无 task。
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    const held = await stages()
    expect(held[1]!.facts.task_id, '用户门未放行前，原型不得派发').toBeNull()
    expect(held[1]!.facts.gate_granted_at).toBeNull()

    // Grant 需求澄清 → 原型派发（绑定同一 worktree，读需求说明作同树证明）。
    const clarificationGrant = await client().call<{
      subAction: { sub_action_id: string }
      expanded: unknown[]
    }>('orchestration.entryGateGrant', { group: repoId, subAction: clarificationId })
    expect(clarificationGrant.result.subAction.gate_granted_at).not.toBeNull()
    expect(clarificationGrant.result.expanded).toEqual([])
    const settledPrototype = await pollStages(
      '原型阶段结算',
      180_000,
      (rows) => rows[1]?.execution?.completedAt !== null && rows[1]?.execution !== null
    )
    expect(settledPrototype[1]!.execution!.result).toContain(marker)
    expect(settledPrototype[1]!.execution!.worktreeId).toBeTruthy()
    expect(settledPrototype[1]!.execution!.worktreeId).toBe(
      settledClarification[0]!.execution!.worktreeId
    )

    // Grant 原型 → 任务设计派发。
    const prototypeGrant = await client().call<{
      subAction: { sub_action_id: string }
      expanded: unknown[]
    }>('orchestration.entryGateGrant', { group: repoId, subAction: prototypeId })
    expect(prototypeGrant.result.subAction.gate_granted_at).not.toBeNull()
    const settledPlan = await pollStages(
      '任务设计结算',
      180_000,
      (rows) => rows[2]?.execution?.completedAt !== null && rows[2]?.execution !== null
    )
    // 同树证明：任务设计读到了原型写入的 note；并产出 orca-plan。
    expect(settledPlan[2]!.execution!.result).toContain(marker)
    expect(settledPlan[2]!.facts.plan_json).toContain('实现设置页')
    expect(settledPlan[2]!.execution!.worktreeId).toBe(settledPrototype[1]!.execution!.worktreeId)

    // Grant 计划 → orca-plan 展开一个实施阶段。
    const planGrant = await client().call<{
      subAction: { sub_action_id: string }
      expanded: { subActionId: string; title: string; agentHint: string | null }[]
    }>('orchestration.entryGateGrant', { group: repoId, subAction: planId })
    expect(planGrant.result.expanded).toHaveLength(1)
    expect(planGrant.result.expanded[0]!.agentHint).toBe('codex')

    // 实施阶段已派发（运行中）后重启：恢复后恰好一次结算，无重复展开。
    const dispatchedImplement = await pollStages(
      '实施阶段派发',
      180_000,
      (rows) => rows.length === 4 && rows[3]!.execution !== null
    )
    expect(dispatchedImplement[3]!.execution!.worktreeId).toBeTruthy()
    expect(dispatchedImplement[3]!.execution!.worktreeId).toBe(
      settledPlan[2]!.execution!.worktreeId
    )

    await session.close(current)
    current = null
    clientInstance = null
    const relaunched = await session.launch({ onStderr: (chunk: string) => appLog.push(chunk) })
    current = relaunched.app

    const settledImplement = await pollStages(
      '重启后实施结算',
      180_000,
      (rows) => rows.length === 4 && rows[3]?.execution?.completedAt !== null
    )
    expect(settledImplement).toHaveLength(4)
    const implementResult = settledImplement[3]!.execution!.result ?? ''
    // 同树数据流：实施读到了原型 note（marker）；spec 注入证明：上游交接标记随计划报告进入实施说明。
    expect(implementResult).toContain(marker)
    expect(implementResult).toContain('saw-plan-uniq: yes')
    // 全链同一 worktree；展开不重复。
    const worktreeIds = settledImplement.map((row) => row.execution?.worktreeId ?? null)
    expect(new Set(worktreeIds)).toEqual(new Set([worktreeIds[0]]))
    expect(worktreeIds[0]).toBeTruthy()
  } finally {
    stub.close()
    await session.dispose(current ?? undefined)
  }
})
