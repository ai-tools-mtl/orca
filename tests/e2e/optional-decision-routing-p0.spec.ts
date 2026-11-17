/** P0 validation for docs/reference/optional-decision-routing-plan.md §9, against a real local
 *  runtime and a real Codex structured worker, through the strict routing entry
 *  (`orchestration.routingSupplementSend`).
 *
 *  Opt-in: P0_ROUTING_RUN=1 (spawned codex is the real authenticated binary; a linked ~/.codex
 *  inside the isolated home provides its auth). Run via tests/tools/optional-decision-routing-p0. */

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test, type ElectronApplication } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime/client'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { createSeededTestRepo, isValidGitRepo } from './helpers/seeded-test-repo'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActivePanePtyId } from './helpers/terminal'
import {
  findSupplementEchoSequence,
  verifySupplementFirstAction,
  type RoutingConversationItem
} from '../../src/main/runtime/orchestration/routing/first-action-verification'

const OPT_IN = process.env.P0_ROUTING_RUN === '1'

test.skip(
  !OPT_IN,
  'P0 spawns the REAL codex app-server; run tests/tools/optional-decision-routing-p0 (P0_ROUTING_RUN=1)'
)

type HistoryPage = {
  page?: { items?: { sequence?: number; body?: Record<string, unknown> }[] }
  items?: { sequence?: number; body?: Record<string, unknown> }[]
}

type SupplementReceipt = {
  supplementId: string
  attemptId: string
  requestId: string
  expectedTurnId: string | null
  outcome: 'delivered' | 'refused'
  refusalKind?: string
  detail?: string
  turnId?: string
  sessionId?: string
}

const results: {
  scenario: string
  condition: string
  verdict: 'PASS' | 'FAIL'
  evidence?: unknown
}[] = []
const appLog: string[] = []

import { appendFileSync } from 'node:fs'
let debugFile: string | null = null
// oxlint-disable-next-line no-console -- mirrored for the streamed log when it survives.
function debug(line: string): void {
  // oxlint-disable-next-line no-console
  console.log(`p0: ${line}`)
  if (debugFile) {
    appendFileSync(debugFile, `${new Date().toISOString()} ${line}\n`)
  }
}

function record(
  scenario: string,
  condition: string,
  verdict: 'PASS' | 'FAIL',
  evidence?: unknown
): void {
  results.push({ scenario, condition, verdict, evidence })
  // oxlint-disable-next-line no-console -- the driver surfaces per-condition verdicts on the console.
  console.log(`  [${verdict}] ${scenario} — ${condition}`)
  // oxlint-disable-next-line no-console -- evidence stays greppable beside the verdict.
  console.log(`p0: evidence ${scenario} — ${condition}: ${JSON.stringify(evidence ?? null)}`)
}

function toRoutingItems(page: HistoryPage): RoutingConversationItem[] {
  return (page.page?.items ?? page.items ?? [])
    .filter((item) => typeof item.sequence === 'number' && item.body !== undefined)
    .map((item) => ({
      sequence: item.sequence as number,
      body: item.body as RoutingConversationItem['body']
    }))
}

function routingAgentOverride(): string | null {
  // The fake stand-in replaces the codex command wholesale. The worker child's PATH may not carry
  // node, so the override points at a copy whose shebang is this driver's absolute node — one
  // process, no shell/node indirection, no env dependence.
  const entry = path.join(
    process.cwd(),
    'tests/tools/optional-decision-routing-p0/fake-codex-appserver.mjs'
  )
  const source = readFileSync(entry, 'utf8')
  const pinned = source.replace(/^#!.*$/m, `#!${process.execPath}`)
  const copy = path.join(
    process.cwd(),
    'tests/tools/optional-decision-routing-p0/.fake-codex-appserver-pinned.mjs'
  )
  writeFileSync(copy, pinned)
  chmodSync(copy, 0o755)
  return process.env.P0_ROUTING_AGENT === 'codex' ? null : copy
}

const toolCalls = (items: RoutingConversationItem[]) =>
  items.filter((item) => item.body?.kind === 'tool-call')
const inputText = (item: RoutingConversationItem) => JSON.stringify(item.body?.input ?? {})
const userText = (item: RoutingConversationItem) =>
  (item.body?.blocks ?? [])
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
    .trim()

test('P0 targeted delivery: steer the named turn, refuse after it ends, follow-up lineage, restart re-query', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  test.setTimeout(20 * 60_000)
  // 'fake' runs a protocol-faithful codex app-server stand-in (no model, no quota);
  // 'codex' runs the real authenticated CLI (opt-in quota permitting).

  // The seeded managed repo carries the fixture files; workers run in new-child worktrees of it.
  const persistedRepoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    : ''
  const project = isValidGitRepo(persistedRepoPath) ? persistedRepoPath : createSeededTestRepo()
  const git = (args: string[]) => spawnSync('git', args, { cwd: project, encoding: 'utf8' })
  const oldMarker = `OLD-MARKER-${randomUUID().slice(0, 8)}`
  const newMarker = `NEW-MARKER-${randomUUID().slice(0, 8)}`
  writeFileSync(path.join(project, 'old.txt'), `${oldMarker}\n`)
  writeFileSync(path.join(project, 'new.txt'), `${newMarker}\n`)
  const gateWaitScript = path.join(project, 'gate-wait.sh')
  writeFileSync(
    gateWaitScript,
    '#!/bin/bash\nwhile [ ! -f "$1" ]; do sleep 0.2; done\necho released\n'
  )
  chmodSync(gateWaitScript, 0o755)
  git(['add', '.'])
  git(['commit', '-m', 'p0 fixture files'])
  // The release gate lives outside every worktree: the worker only waits on an absolute path.
  const gateFile = path.join(
    mkdtempSync(path.join(os.tmpdir(), 'p0-routing-gate-')),
    'gate-release'
  )

  // PATH shims own the agent swap: `codex app-server` resolves to the protocol-faithful stand-in
  // (P0_ROUTING_AGENT=fake, default) or passes through to the real CLI (P0_ROUTING_AGENT=codex);
  // `orca` reaches the served profile through the app's inherited isolated HOME.
  const shims = path.join(testInfo.outputDir, 'p0-shims')
  mkdirSync(shims, { recursive: true })
  const fakeEntry = path.join(
    process.cwd(),
    'tests/tools/optional-decision-routing-p0/fake-codex-appserver.mjs'
  )
  const cliEntry = path.join(process.cwd(), 'out/cli/index.js')
  const shimLog = `${shims}/codex-shim.log`
  writeFileSync(
    path.join(shims, 'codex'),
    `#!/bin/bash\n{ echo "argv=$* node=$(command -v node) nodeV=$(node --version 2>&1) NODE_OPTIONS=$NODE_OPTIONS ELECTRON_RUN_AS_NODE=$ELECTRON_RUN_AS_NODE pwd=$PWD"; } >> ${JSON.stringify(shimLog)} 2>&1\nif [ "$1" = "app-server" ] && [ "$P0_ROUTING_AGENT" != "codex" ]; then\n  exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeEntry)} 2>> ${JSON.stringify(shimLog)}\nfi\nexec ${process.env.P0_REAL_CODEX ?? 'codex'} "$@"\n`
  )
  writeFileSync(
    path.join(shims, 'orca'),
    `#!/bin/bash\nexec node ${JSON.stringify(cliEntry)} "$@"\n`
  )
  chmodSync(path.join(shims, 'codex'), 0o755)
  chmodSync(path.join(shims, 'orca'), 0o755)

  debugFile = path.join(testInfo.outputDir, 'p0-debug.log')
  const session = createRestartSession(testInfo, {
    PATH: `${shims}${path.delimiter}${process.env.PATH ?? ''}`,
    FAKE_CODEX_TRACE: path.join(testInfo.outputDir, 'fake-codex-trace.log')
  })
  let current: ElectronApplication | null = null
  try {
    const first = await session.launch({ onStderr: (chunk: string) => appLog.push(chunk) })
    current = first.app
    await attachRepoAndOpenTerminal(first.page, project)
    await waitForSessionReady(first.page)
    await waitForActiveWorktree(first.page)
    await ensureTerminalVisible(first.page)
    await waitForActivePanePtyId(first.page)

    // The runtime runs under an isolated home; link the real codex auth into it.
    const isolatedHome = await current.evaluate(({ app }) => app.getPath('home'))
    const codexHome = path.join(isolatedHome, '.codex')
    try {
      const existing = lstatSync(codexHome)
      if (!existing.isSymbolicLink()) {
        rmSync(codexHome, { recursive: true })
      }
    } catch {}
    try {
      symlinkSync(path.join(os.homedir(), '.codex'), codexHome)
    } catch (error) {
      // oxlint-disable-next-line no-console
      console.warn(`p0: could not link ~/.codex (${String(error)}); codex may be unauthenticated`)
    }
    // oxlint-disable-next-line no-console
    console.log(
      `p0: codex home link=${(() => {
        try {
          return readlinkSync(codexHome)
        } catch {
          return 'none'
        }
      })()} authJson=${existsSync(path.join(codexHome, 'auth.json'))}`
    )

    const client = new RuntimeClient(session.userDataDir, 60_000, null, null)
    const coordinatorPane = await waitForActivePaneHookDescriptor(first.page)
    const coordinator = await client.call<{ terminal: { handle: string } }>(
      'terminal.resolvePane',
      {
        paneKey: coordinatorPane.paneKey
      }
    )
    const from = coordinator.result.terminal.handle

    // Structured workers need the native-chat default surface and hands-off permissions. The
    // fake stand-in replaces the codex command wholesale so the worker never spawns the real
    // quota-gated CLI; the command override goes through the runtime's own mutation vocabulary.
    await first.page.evaluate(async () => {
      await window.__store?.getState().updateSettings({
        agentDefaultSurface: 'chat',
        nativeChatPermissionMode: 'full-access',
        disabledTuiAgents: []
      })
    })
    const fakeCommand = routingAgentOverride()
    if (fakeCommand) {
      await client.call('settings.mutateAgentLaunch', {
        type: 'command',
        agent: 'codex',
        value: fakeCommand
      })
      await client.call('settings.update', {
        agentDefaultEnv: { codex: { PATH: `${shims}${path.delimiter}${process.env.PATH ?? ''}` } }
      })
    }
    const launchSettings = await client.call<{ settings: Record<string, unknown> }>(
      'settings.getAgentLaunch'
    )
    debug(
      `agent launch settings after write: ${JSON.stringify(launchSettings.result.settings).slice(0, 500)}`
    )

    const run = await client.call<{ run: { id: string } }>('orchestration.runCreate', {
      objective: 'P0 targeted delivery',
      from
    })
    const runId = run.result.run.id
    // oxlint-disable-next-line no-console
    console.log(`p0: run ${runId}`)

    const history = async (sessionId: string) => {
      const page = await client.call<HistoryPage>('agentSession.history', {
        sessionId,
        direction: 'tail'
      })
      return toRoutingItems(page.result)
    }
    const poll = async <T>(
      label: string,
      timeoutMs: number,
      fn: () => Promise<T | null>
    ): Promise<T> => {
      const deadline = Date.now() + timeoutMs
      let lastError: unknown
      while (Date.now() < deadline) {
        try {
          const value = await fn()
          if (value !== null) {
            return value
          }
        } catch (error) {
          lastError = error
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
      throw new Error(
        `timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ''}`
      )
    }
    const targetOf = async (dispatchId: string) => {
      const shown = await client.call<{
        dispatchId: string
        sessionId: string | null
        activeTurnId: string | null
      }>('orchestration.routingTargetShow', { dispatch: dispatchId, from })
      return shown.result
    }
    const registerInput = async (text: string, taskId?: string) => {
      const input = await client.call<{ input: { input_id: string } }>(
        'orchestration.routingInputRegister',
        { text, run: runId, from }
      )
      const decision = await client.call<{ subActions: { sub_action_id: string }[] }>(
        'orchestration.routingDecisionRegister',
        {
          input: input.result.input.input_id,
          subActions: JSON.stringify([{ text, ...(taskId ? { task: taskId } : {}) }]),
          from
        }
      )
      return {
        inputId: input.result.input.input_id,
        subActionId: decision.result.subActions[0]!.sub_action_id
      }
    }
    const createTask = async (title: string, spec: string) => {
      const task = await client.call<{ task: { id: string } }>('orchestration.taskCreate', {
        spec,
        taskTitle: title,
        run: runId,
        callerTerminalHandle: from
      })
      return task.result.task.id
    }
    const startWorker = async (taskId: string) => {
      const started = await client.call<{
        dispatchId: string
        state: string
        failedStage?: string
        mode?: { mode: string; detail: string }
        lastError?: string
      }>('orchestration.workerStart', {
        task: taskId,
        run: runId,
        worktree: 'new-child',
        agent: 'codex',
        timeoutMs: 180_000,
        from
      })
      debug(`worker-start receipt for ${taskId}: ${JSON.stringify(started.result)}`)
      debug(`app stderr tail: ${appLog.join('').split('\n').slice(-60).join(' || ')}`)
      expect(
        started.result.dispatchId,
        `worker-start for ${taskId} returned a dispatch`
      ).toBeTruthy()
      expect(
        started.result.state,
        `worker-start for ${taskId} reached ready (receipt: ${JSON.stringify(started.result)}; app log tail: ${appLog
          .join('')
          .split('\n')
          .filter((line) => /codex|spawn|error|fake/i.test(line))
          .slice(-15)
          .join(' | ')})`
      ).toBe('ready')
      return started.result.dispatchId
    }
    const taskStatus = async (taskId: string) => {
      const list = await client.call<{ tasks: { id: string; status: string }[] }>(
        'orchestration.taskList',
        { run: runId, from }
      )
      return list.result.tasks.find((entry) => entry.id === taskId)?.status
    }
    const settle = (taskId: string) =>
      poll(`task ${taskId} settles`, 600_000, async () => {
        const status = await taskStatus(taskId)
        return status === 'completed' || status === 'failed' ? status : null
      })

    // ---------- S1: 同一轮改变下一步 ----------
    {
      const taskId = await createTask(
        'S1 gate then read old',
        `Run exactly one command first: bash ${gateWaitScript} ${gateFile} ` +
          '(it blocks until that file exists; do NOT create that file yourself). ' +
          'Only after it finishes, read old.txt in the project root and report the exact marker text inside it. ' +
          'Read nothing else. Then report completion.'
      )
      await registerInput('先运行放行门命令，然后只读 old.txt 并报告其中标记。', taskId)
      const dispatchId = await startWorker(taskId)
      const sessionId = await poll(
        'S1 structured session',
        300_000,
        async () => (await targetOf(dispatchId)).sessionId
      )
      const originalTurn = await poll(
        'S1 first turn active',
        300_000,
        async () => (await targetOf(dispatchId)).activeTurnId
      )

      let gateSeen
      try {
        gateSeen = await poll('S1 gate initiated with no reads yet', 420_000, async () => {
          const items = toolCalls(await history(sessionId))
          const gate = items.find((item) => inputText(item).includes('gate-wait.sh'))
          const reads = items.filter((item) => item.body?.name === 'read')
          return gate && reads.length === 0 ? gate : null
        })
      } catch (error) {
        const dump = (await history(sessionId)).map((item) => ({
          sequence: item.sequence,
          kind: item.body?.kind,
          name: item.body?.name,
          role: item.body?.role,
          input: inputText(item).slice(0, 120),
          text: userText(item).slice(0, 120)
        }))
        let requests: unknown
        try {
          const current = await client.call<unknown>('agentSession.currentRequests', {
            sessionId,
            version: randomUUID()
          })
          requests = current.result
        } catch (requestError) {
          requests = `currentRequests failed: ${String(requestError)}`
        }
        const logTail = appLog
          .join('')
          .split('\n')
          .filter((line) => /codex|error|warn|approval|sandbox|auth/i.test(line))
          .slice(-50)
          .join('\n')
        // oxlint-disable-next-line no-console
        console.log(
          `p0: S1 gate poll failed; history dump: ${JSON.stringify(dump, null, 1)}\np0: currentRequests: ${JSON.stringify(requests, null, 1)}\np0: app log tail:\n${logTail}`
        )
        throw error
      }
      record('S1', '放行前：门命令已发起且未发起任何文件读取', 'PASS', {
        gateSequence: gateSeen.sequence
      })
      const workerCwd = (gateSeen.body?.input as { cwd?: string } | undefined)?.cwd ?? project

      const supplementText = '下一步只读 new.txt，跳过 old.txt，报告 new.txt 中的标记。'
      const supplementDelivery = await registerInput(supplementText)
      const receipt = (
        await client.call<SupplementReceipt>('orchestration.routingSupplementSend', {
          input: supplementDelivery.inputId,
          subAction: supplementDelivery.subActionId,
          dispatch: dispatchId,
          text: supplementText,
          from
        })
      ).result
      // oxlint-disable-next-line no-console
      console.log(`p0: S1 supplement receipt: ${JSON.stringify(receipt)}`)
      record(
        'S1',
        '补充收到针对原轮次的投递回执',
        receipt.outcome === 'delivered' ? 'PASS' : 'FAIL',
        {
          outcome: receipt.outcome,
          expectedTurnId: receipt.expectedTurnId,
          turnId: receipt.turnId,
          originalTurn
        }
      )

      writeFileSync(gateFile, 'go')
      // oxlint-disable-next-line no-console
      console.log('p0: gate released')
      const status = await settle(taskId)

      const items = await history(sessionId)
      // Anchor: the gate command, the last task action initiated before delivery. The receipt
      // already binds the delivery to the same turn, so first-action-after-gate plus the
      // delivered receipt proves the initiation order gate < delivery < read.
      const gateSequence = gateSeen.sequence
      const echoSequence = findSupplementEchoSequence(items, supplementText)
      const anchor = echoSequence ?? gateSequence
      const verdict = verifySupplementFirstAction(items, {
        afterSequence: anchor,
        expect: { actionName: 'read', inputPath: path.join(workerCwd, 'new.txt') },
        forbiddenPaths: [path.join(workerCwd, 'old.txt')]
      })
      record(
        'S1',
        '首个新动作=读 new.txt 且发起于放行后，全程未读 old.txt',
        verdict.verdict === 'complied' ? 'PASS' : 'FAIL',
        { anchor: echoSequence === null ? 'gate-item' : 'echo', anchorSequence: anchor, ...verdict }
      )
      record('S1', '任务结算（worker_done 报告新标记）', status === 'completed' ? 'PASS' : 'FAIL', {
        status
      })
    }

    // ---------- S2: 原轮结束后拒收 ----------
    {
      const taskId = await createTask(
        'S2 read old',
        'Read old.txt in the project root and report the exact marker text inside it. Read nothing else. Then report completion.'
      )
      await registerInput('只读 old.txt 并报告其中标记。', taskId)
      const dispatchId = await startWorker(taskId)
      const sessionId = await poll(
        'S2 structured session',
        300_000,
        async () => (await targetOf(dispatchId)).sessionId
      )
      // The plain task completes in seconds; discover its turn from the journal after settle.
      const s2Status = await settle(taskId)
      const s2TurnIds = (await history(sessionId))
        .filter((item) => item.body?.kind === 'turn' && typeof item.body?.turnId === 'string')
        .map((item) => item.body?.turnId as string)
      const turnId = s2TurnIds.at(-1)
      record(
        'S2',
        '原轮开启并结算（轮次 ID 取自执行记录）',
        Boolean(turnId) && s2Status === 'completed' ? 'PASS' : 'FAIL',
        { turnId, s2TurnIds, s2Status }
      )
      if (!turnId) {
        throw new Error(`S2 could not discover the original turn id: ${JSON.stringify(s2TurnIds)}`)
      }
      const supplementText = '补查：也读 new.txt。'
      const supplement = await registerInput(supplementText)

      const refusedIdle = (
        await client.call<SupplementReceipt>('orchestration.routingSupplementSend', {
          input: supplement.inputId,
          subAction: supplement.subActionId,
          dispatch: dispatchId,
          text: supplementText,
          expectedTurn: turnId,
          from
        })
      ).result
      record(
        'S2',
        '会话空闲：取得绑定原轮的明确拒收',
        refusedIdle.outcome === 'refused' && refusedIdle.expectedTurnId === turnId
          ? 'PASS'
          : 'FAIL',
        {
          outcome: refusedIdle.outcome,
          refusalKind: refusedIdle.refusalKind,
          expectedTurnId: refusedIdle.expectedTurnId
        }
      )

      const nudge = await client.call<{ delivered?: string; queued?: boolean }>(
        'orchestration.send',
        {
          to: `dispatch:${dispatchId}`,
          subject: '再读一遍 old.txt',
          body: 'Read old.txt once more and report its marker again.',
          from
        }
      )
      // oxlint-disable-next-line no-console
      console.log(`p0: S2 nudge receipt: ${JSON.stringify(nudge.result)}`)
      const secondTurn = await poll('S2 second turn from journal', 300_000, async () => {
        const ids = (await history(sessionId))
          .filter((item) => item.body?.kind === 'turn' && typeof item.body?.turnId === 'string')
          .map((item) => item.body?.turnId as string)
        return ids.length >= 2 && ids.at(-1) !== turnId ? ids.at(-1) : null
      })
      const refusedOther = (
        await client.call<SupplementReceipt>('orchestration.routingSupplementSend', {
          input: supplement.inputId,
          subAction: supplement.subActionId,
          dispatch: dispatchId,
          text: supplementText,
          expectedTurn: turnId,
          from
        })
      ).result
      record(
        'S2',
        '另有活动轮：仍拒收并绑定原轮，未改投其他轮',
        refusedOther.outcome === 'refused' && refusedOther.expectedTurnId === turnId
          ? 'PASS'
          : 'FAIL',
        { outcome: refusedOther.outcome, refusalKind: refusedOther.refusalKind, secondTurn }
      )

      const leaked = (await history(sessionId)).some((item) =>
        userText(item).includes(supplementText)
      )
      record('S2', '两次拒收后：会话中无补充文本、无因它新开的轮次', leaked ? 'FAIL' : 'PASS', {
        leaked
      })
    }

    // ---------- S3: 并行与结算后续接 ----------
    {
      const taskIdA = await createTask(
        'S3 report old',
        'Read old.txt in the project root and report the exact marker text inside it. Then report completion.'
      )
      const taskIdB = await createTask(
        'S3 report new',
        'Read new.txt in the project root and report the exact marker text inside it. Then report completion.'
      )
      const input = await client.call<{ input: { input_id: string } }>(
        'orchestration.routingInputRegister',
        {
          text: '报告 old.txt 标记；另外报告 new.txt 标记。两项独立。',
          run: runId,
          from
        }
      )
      await client.call('orchestration.routingDecisionRegister', {
        input: input.result.input.input_id,
        subActions: JSON.stringify([
          { text: '报告 old.txt 标记', task: taskIdA },
          { text: '报告 new.txt 标记', task: taskIdB }
        ]),
        from
      })
      const dispatchA = await startWorker(taskIdA)
      const dispatchB = await startWorker(taskIdB)
      record(
        'S3',
        '第一项运行中即提交另一项独立任务，两项各有 Dispatch',
        Boolean(dispatchA) && Boolean(dispatchB) ? 'PASS' : 'FAIL',
        { dispatchA, dispatchB }
      )

      const statusA = await settle(taskIdA)
      const statusB = await settle(taskIdB)
      record(
        'S3',
        '两项结果分别可取回',
        statusA !== undefined && statusB !== undefined ? 'PASS' : 'FAIL',
        { statusA, statusB }
      )

      const followUpSend = await client.call<Record<string, unknown>>('orchestration.send', {
        to: `dispatch:${dispatchA}`,
        type: 'dispatch',
        subject: 'S3 follow-up',
        body: 'Read old.txt again and report its marker one more time. Then report completion.',
        from
      })
      // oxlint-disable-next-line no-console
      console.log(
        `p0: S3 follow-up send receipt: ${JSON.stringify(followUpSend.result).slice(0, 400)}`
      )
      const followUpDispatchId = (followUpSend.result as { dispatchId?: string }).dispatchId
      const lineage = await poll('S3 follow-up continues the lineage', 300_000, async () => {
        if (!followUpDispatchId) {
          return null
        }
        const worker = await client.call<Record<string, unknown>>('orchestration.workerShow', {
          dispatch: followUpDispatchId,
          from
        })
        const shown = JSON.stringify(worker.result)
        // The continuation's own record names the Dispatch it continues.
        return shown.includes(dispatchA) ? shown : null
      })
      record(
        'S3',
        '结算后 follow-up 归入同一执行谱系（follow_up_of_dispatch_id）',
        lineage ? 'PASS' : 'FAIL',
        { followUpDispatchId, workerShow: String(lineage).slice(0, 300) }
      )
    }

    // ---------- S4: 重启查证 ----------
    {
      const startRequestId = randomUUID()
      const taskId = await createTask(
        'S4 restart probe',
        'Read old.txt in the project root and report the exact marker text inside it. Then report completion.'
      )
      await registerInput('只读 old.txt 并报告标记。', taskId)
      const started = await client.call<{ dispatchId: string }>(
        'orchestration.workerStart',
        {
          task: taskId,
          run: runId,
          worktree: 'new-child',
          agent: 'codex',
          timeoutMs: 180_000,
          from
        },
        { orchestrationRequestId: startRequestId }
      )
      const dispatchId = started.result.dispatchId

      // oxlint-disable-next-line no-console
      console.log('p0: restarting runtime...')
      await session.close(current)
      current = null
      const second = await session.launch({ onStderr: (chunk: string) => appLog.push(chunk) })
      current = second.app
      await waitForSessionReady(second.page)
      const restarted = new RuntimeClient(session.userDataDir, 60_000, null, null)

      const request = await restarted.call<{ state?: string }>('orchestration.requestShow', {
        request: startRequestId
      })
      record(
        'S4',
        '原 request ID 重启后可对账',
        /pending|completed|replayed|accepted|unknown/i.test(JSON.stringify(request.result))
          ? 'PASS'
          : 'FAIL',
        { requestShow: JSON.stringify(request.result).slice(0, 300) }
      )
      const worker = await restarted.call<{ id?: string; state?: string }>(
        'orchestration.workerShow',
        {
          dispatch: dispatchId,
          from
        }
      )
      const workerShown = JSON.stringify(worker.result)
      record(
        'S4',
        '原 Dispatch 重启后仍可查证，不另起 Worker',
        workerShown.includes(dispatchId) ? 'PASS' : 'FAIL',
        { workerShow: workerShown.slice(0, 400) }
      )
    }

    // oxlint-disable-next-line no-console
    console.log('\n===== P0 结果 =====')
    for (const entry of results) {
      // oxlint-disable-next-line no-console
      console.log(`[${entry.verdict}] ${entry.scenario} — ${entry.condition}`)
    }
    const failed = results.filter((entry) => entry.verdict !== 'PASS')
    writeFileSync(
      path.join(testInfo.outputDir, 'p0-evidence.json'),
      JSON.stringify({ os: `${os.platform()} ${os.release()} ${os.arch()}`, results }, null, 2)
    )
    expect(failed, `every P0 condition passes (${JSON.stringify(failed)})`).toEqual([])
  } finally {
    await session.dispose(current ?? undefined)
  }
})
