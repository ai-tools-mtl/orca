import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  planningTemplateSubActions,
  routeRoutingInput
} from '../../../orchestration/routing/routing-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../core'
import { createOrchestrationRpcHarness } from './rpc-test-harness'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import type { RunRow } from '../../../orchestration/db/orchestration-records'
import {
  partialRuntimeStore,
  storeRepo
} from '../../../orca-runtime-tests/runtime-store-partial-fixture'
import {
  pumpEntryAutomations,
  type EntryDispatchSubAction,
  type EntryLoopSpawn
} from './entry-automation-pump'
import * as localWorkerStart from './worker/start/local-worker-start'
import { dispatchEntryDecision, dispatchEntrySubAction } from './entry-dispatch'
import { grantRoutingStageGate } from '../../../orchestration/routing/routing-stage-gates'
import { resolveStageUpstream } from '../../../orchestration/routing/routing-stage-gates'

// The §5.6/§7 pump state machine: same-folder queue draining, the 循环开发 review rounds, and
// the per-card pause gate on supplement delivery. The spawns are stubbed — the assertions pin
// the ledger/cycle bookkeeping, not the runtime.

describe('entry automation pump (§5.6 同目录排队 / §7 循环开发)', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let dbDir: string | undefined
  let ctx: RpcContext
  let runtime: ReturnType<ReturnType<typeof createOrchestrationRpcHarness>['setup']>['runtime']

  afterEach(() => {
    h.cleanup()
    if (dbDir) {
      rmSync(dbDir, { recursive: true, force: true })
      dbDir = undefined
    }
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function call<T>(name: string, params: Record<string, unknown>): Promise<T> {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the asserted shape is the called method's documented receipt.
    return (await h.call(name, params, ctx)) as T
  }

  function prepareProject(
    workspaceKind: 'git-worktree' | 'folder' = 'git-worktree',
    durable = false
  ) {
    dbDir = durable ? mkdtempSync(join(tmpdir(), 'orca-entry-review-')) : undefined
    const repo = storeRepo({ id: 'proj_alpha', path: '/fixture/project', kind: 'git' })
    const state = h.setup(
      false,
      partialRuntimeStore({
        getRepos: () => [repo],
        getSettings: () => ({
          defaultTuiAgent: 'codex',
          nativeChatProviders: {},
          decisionModel: { source: 'agent' }
        })
      }),
      dbDir ? join(dbDir, 'orchestration.db') : ':memory:'
    )
    db = state.db
    ctx = { ...state.ctx, caller: { kind: 'desktop' } }
    runtime = state.runtime
    vi.spyOn(state.runtime, 'detectProjectLaunchContext').mockResolvedValue({
      agents: ['codex', 'claude', 'zcode'],
      workspaceKind,
      executionContext: { kind: 'ssh' }
    })
    vi.spyOn(state.runtime, 'showRepo').mockResolvedValue(repo)
    vi.spyOn(state.runtime, 'showTerminalWorkspaceLaunchScope').mockImplementation(async (id) => ({
      id,
      path: '/fixture/project',
      repo,
      connectionId: null,
      folderWorkspace: null
    }))
    vi.spyOn(state.runtime, 'getRuntimeGitStatus').mockResolvedValue({
      head: 'git-head-a',
      entries: [],
      conflictOperation: 'unknown'
    })
    vi.spyOn(state.runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(state.runtime, 'listManagedWorktrees').mockResolvedValue(
      workspaceKind === 'folder'
        ? ({
            worktrees: [{ id: 'wt_folder' }],
            totalCount: 1,
            truncated: false
          } as never)
        : { worktrees: [], totalCount: 0, truncated: false }
    )
    vi.spyOn(state.runtime, 'listRetiredWorktreeNames').mockResolvedValue({
      retiredNamesByRepo: {},
      retiredNameTiersByRepo: {}
    })
    vi.spyOn(state.runtime, 'getTerminalPaneKey').mockImplementation((handle) => `pane:${handle}`)
    vi.spyOn(state.runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
      state.runtime.getTerminalPaneKey(handle)
    )
    vi.spyOn(state.runtime, 'listTerminals').mockResolvedValue({
      terminals: [],
      totalCount: 0,
      truncated: false
    })
    vi.spyOn(state.runtime, 'waitForTerminal').mockImplementation(async (handle) => ({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    }))
    vi.spyOn(state.runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(state.runtime, 'sendTerminalAgentPrompt').mockImplementation(async (handle) => ({
      handle,
      accepted: true,
      bytesWritten: 1
    }))
  }

  let runId: string | undefined

  function pumpWith(dispatch: EntryDispatchSubAction, spawn: EntryLoopSpawn): Promise<void> {
    if (!runId) {
      throw new Error('seed the entry run first')
    }
    return pumpEntryAutomations(
      { runtime, run: { id: runId } as RunRow, group: 'proj_alpha' },
      dispatch,
      spawn
    )
  }

  async function submitEntry(text: string, extra: Record<string, unknown> = {}) {
    const submitted = await call<{ run: { id: string }; input: { input_id: string } }>(
      'orchestration.entrySubmit',
      { group: 'proj_alpha', text, ...extra }
    )
    runId = submitted.run.id
    return submitted
  }

  function planEntry(inputId: string, subActions: (string | Record<string, unknown>)[]) {
    return call<{ subActions: { sub_action_id: string }[] }>('orchestration.entryPlan', {
      group: 'proj_alpha',
      input: inputId,
      subActions
    })
  }

  function seedLoopWorker(
    request: { intentId: string; spec: string; taskTitle?: string; agent: string },
    worktreeId: string
  ) {
    const seeded = db.createStartingWorkerDispatch({
      entryReviewIntentId: request.intentId,
      taskSpec: request.spec,
      ...(request.taskTitle ? { taskTitle: request.taskTitle } : {}),
      taskRunId: runId!,
      startOptions: { agent: request.agent },
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    db.db
      .prepare('UPDATE worker_dispatches SET worktree_id = ? WHERE dispatch_id = ?')
      .run(worktreeId, seeded.dispatch.id)
    return seeded
  }

  it('drains the same-folder queue in order; a refused waiter stays queued', async () => {
    prepareProject('folder')
    let run = { id: '' }
    for (const text of ['更新依赖锁文件', '顺手整理脚本文档']) {
      const submitted = await submitEntry(text)
      run = submitted.run
      await planEntry(submitted.input.input_id, [text])
    }
    runId = run.id
    // The guard queued both while the folder was occupied; seq order decides the waiters.
    db.db
      .prepare("UPDATE routing_sub_actions SET queued_at = datetime('now') WHERE run_id = ?")
      .run(run.id)
    const ordered = db.listQueuedSubActions(run.id)
    const [firstId, secondId] = [ordered[0]!.sub_action_id, ordered[1]!.sub_action_id]

    const attempted: string[] = []
    const refuseFirst: EntryDispatchSubAction = async (spawn) => {
      attempted.push(spawn.subActionId)
      if (spawn.subActionId === firstId) {
        throw new Error('occupied again')
      }
      return { queued: false }
    }
    await pumpWith(refuseFirst, async () => {
      throw new Error('no loop work in this test')
    })
    expect(attempted).toEqual([firstId, secondId])
    expect(db.getSubAction(firstId)?.queued_at).not.toBeNull()
    expect(db.getSubAction(secondId)?.queued_at).toBeNull()

    const acceptAll: EntryDispatchSubAction = async (spawn) => {
      attempted.push(spawn.subActionId)
      return { queued: false }
    }
    await pumpWith(acceptAll, async () => {
      throw new Error('no loop work in this test')
    })
    expect(attempted.at(-1)).toBe(firstId)
    expect(db.getSubAction(firstId)?.queued_at).toBeNull()
  })

  it('recovers a concurrent review launch, retries rework, and verifies the current revision for acceptance', async () => {
    prepareProject('git-worktree', true)
    const submitted = await submitEntry('修登录超时，回归补齐', {
      loop: true,
      decisionModel: { source: 'agent' }
    })
    const planned = await planEntry(submitted.input.input_id, ['修登录超时，回归补齐'])
    const subActionId = planned.subActions[0]!.sub_action_id

    // The writer completed in its own workspace with a worker report.
    const writer = db.createStartingWorkerDispatch({
      entrySubActionId: subActionId,
      taskSpec: '修登录超时，回归补齐',
      taskRunId: runId!,
      startOptions: { agent: 'codex' },
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    db.db
      .prepare('UPDATE worker_dispatches SET worktree_id = ? WHERE dispatch_id = ?')
      .run('repo_x::/fixture/wt-writer', writer.dispatch.id)
    db.db.prepare("UPDATE tasks SET status = 'completed', result = ? WHERE id = ?").run(
      JSON.stringify({
        provenance: 'worker_report',
        outcome: 'completed',
        subject: '修复完成',
        body: '修复登录超时，回归 10 passed。',
        filesModified: ['src/a.ts']
      }),
      writer.task.id
    )

    const spawnDispatchIds: string[] = []
    const spawns: { agent: string; spec: string; readOnly: boolean }[] = []
    const firstLaunch = Promise.withResolvers<void>()
    const releaseFirstLaunch = Promise.withResolvers<void>()
    let failBeforeRework = true
    const spawn: EntryLoopSpawn = async (spawnRequest) => {
      if (!spawnRequest.readOnly && failBeforeRework) {
        failBeforeRework = false
        throw new Error('fixture failure before Dispatch acceptance')
      }
      spawns.push({
        agent: spawnRequest.agent,
        spec: spawnRequest.spec,
        readOnly: spawnRequest.readOnly
      })
      const seeded = seedLoopWorker(spawnRequest, 'repo_x::/fixture/wt-writer')
      const reviewerBody =
        spawnDispatchIds.length === 0
          ? '审查发现：\n[R1-01] blocking: 未覆盖 legacy 入口回归'
          : '复审通过：\n无阻塞意见'
      db.db.prepare("UPDATE tasks SET status = 'completed', result = ? WHERE id = ?").run(
        JSON.stringify({
          provenance: 'worker_report',
          outcome: 'completed',
          subject: spawnRequest.taskTitle,
          body: reviewerBody
        }),
        seeded.task.id
      )
      spawnDispatchIds.push(seeded.dispatch.id)
      if (spawnDispatchIds.length === 1) {
        firstLaunch.resolve()
        await releaseFirstLaunch.promise
        throw new Error('fixture lost response after Dispatch acceptance')
      }
      return seeded.dispatch.id
    }
    // The decision model picks zcode as the reviewer (stubbed completion endpoint).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"agent":"zcode"}' } }] })
      }))
    )
    const noopDispatch: EntryDispatchSubAction = async () => {
      throw new Error('no folder work in this test')
    }

    // Round 1: the writer's completion started a review cycle with the model-picked reviewer.
    const starting = pumpWith(noopDispatch, spawn)
    await Promise.race([
      firstLaunch.promise,
      starting.then(() => {
        throw new Error('The first review launch did not reach dispatch.')
      })
    ])
    try {
      await pumpWith(noopDispatch, spawn)
      await expect(
        call('orchestration.entryReviewAccept', {
          group: 'proj_alpha',
          task: writer.task.id,
          cycle: 'not-created',
          revision: 1
        })
      ).rejects.toMatchObject({ code: 'lifecycle_not_found' })
    } finally {
      vi.spyOn(db, 'startReviewCycle').mockImplementationOnce(() => {
        throw new Error('fixture interrupted before review cycle commit')
      })
      releaseFirstLaunch.resolve()
      await starting
    }
    expect(db.getLatestReviewCycleForTask(writer.task.id)).toBeUndefined()
    db = h.reopenDatabase()
    await pumpWith(noopDispatch, spawn)
    const cycle = db.getLatestReviewCycleForTask(writer.task.id)
    expect(cycle).toBeDefined()
    expect(cycle?.state).toBe('reviewing')
    expect(cycle?.active_reviewer_dispatch_id).toBe(spawnDispatchIds[0])
    expect(spawns[0]).toMatchObject({ agent: 'zcode', readOnly: true })
    expect(spawns[0]!.spec).toContain('[R1-01] blocking')

    // The reviewer reported a blocking opinion: recorded, cycle flips to rework, and the
    // writer takes another turn in its own workspace.
    await pumpWith(noopDispatch, spawn)
    expect(db.getLatestReviewCycleForTask(writer.task.id)).toMatchObject({
      state: 'rework',
      active_writer_dispatch_id: writer.dispatch.id,
      current_revision: 1
    })
    db = h.reopenDatabase()
    await pumpWith(noopDispatch, spawn)
    const rework = db.getLatestReviewCycleForTask(writer.task.id)!
    expect(rework.state).toBe('rework')
    expect(db.listReviewOpinions(rework.cycle_id)).toHaveLength(1)
    expect(rework.active_writer_dispatch_id).not.toBe(rework.writer_dispatch_id)
    expect(spawns[1]!.readOnly).toBe(false)
    expect(spawns[1]!.spec).toContain('未覆盖 legacy 入口回归')

    // The rework finished → revision bumps and the reviewer re-reviews (clean this time).
    db.db
      .prepare(
        "UPDATE tasks SET status = 'completed', result = ? WHERE id = (SELECT task_id FROM dispatch_contexts WHERE id = ?)"
      )
      .run(
        JSON.stringify({
          provenance: 'worker_report',
          outcome: 'completed',
          subject: '返工 R1',
          body: '已补 legacy 回归测试。'
        }),
        rework.active_writer_dispatch_id
      )
    await pumpWith(noopDispatch, spawn)
    const reReview = db.getLatestReviewCycleForTask(writer.task.id)!
    expect(reReview.current_revision).toBe(2)
    expect(reReview.state).toBe('reviewing')
    expect(reReview.active_reviewer_dispatch_id).toBe(spawnDispatchIds[2])
    expect(spawns[2]).toMatchObject({ agent: 'zcode', readOnly: true })
    expect(spawns[2]!.spec).toContain('复审 R2')

    // The clean re-review leaves the cycle awaiting the user's acceptance.
    await pumpWith(noopDispatch, spawn)
    expect(db.getLatestReviewCycleForTask(writer.task.id)?.state).toBe('reviewing')
    await expect(
      call('orchestration.entryReviewAccept', {
        group: 'proj_alpha',
        task: writer.task.id,
        cycle: reReview.cycle_id,
        revision: 1
      })
    ).rejects.toMatchObject({ code: 'lifecycle_conflict' })
    await expect(
      call('orchestration.entryReviewAccept', {
        group: 'proj_alpha',
        task: writer.task.id,
        cycle: reReview.cycle_id,
        revision: 2
      })
    ).resolves.toMatchObject({ cycle: { state: 'accepted' } })
  })

  it('invalidates a completed review when the workspace changes before acceptance', async () => {
    prepareProject()
    let worktreeContent = 'first reviewed edit'
    vi.mocked(runtime.getRuntimeGitStatus).mockResolvedValue({
      head: 'same-head',
      conflictOperation: 'unknown',
      entries: [{ path: 'login.ts', status: 'modified', area: 'unstaged' }]
    })
    vi.spyOn(runtime, 'getRuntimeGitDiff').mockImplementation(async () => ({
      kind: 'text',
      originalContent: 'base',
      modifiedContent: worktreeContent,
      originalIsBinary: false,
      modifiedIsBinary: false
    }))
    const { run, input } = await submitEntry('修改登录', {
      loop: true,
      decisionModel: { source: 'agent' }
    })
    const { subActions } = db.registerRoutingDecision({
      inputId: input.input_id,
      subActions: [{ text: '修改登录' }]
    })
    const writer = settleSubAction(subActions[0]!.sub_action_id, '修改完成', 'repo_x::/fixture/wt')
    const noDispatch: EntryDispatchSubAction = async () => {
      throw new Error('unexpected stage')
    }
    const spawn: EntryLoopSpawn = async (request) => {
      const worker = db.createStartingWorkerDispatch({
        entryReviewIntentId: request.intentId,
        taskSpec: request.spec,
        taskRunId: run.id,
        startOptions: { agent: request.agent },
        creator: { kind: 'system' },
        maxDepth: 5
      })
      db.db
        .prepare('UPDATE worker_dispatches SET worktree_id = ? WHERE dispatch_id = ?')
        .run(request.worktreeId, worker.dispatch.id)
      return worker.dispatch.id
    }
    await pumpWith(noDispatch, spawn)
    const cycle = db.getLatestReviewCycleForTask(writer.task.id)!
    const accept = () =>
      call('orchestration.entryReviewAccept', {
        group: 'proj_alpha',
        task: writer.task.id,
        cycle: cycle.cycle_id,
        revision: 1
      })
    await expect(accept()).rejects.toMatchObject({ code: 'lifecycle_conflict' })
    const reviewerTask = db.getDispatchContextById(cycle.active_reviewer_dispatch_id!)!.task_id
    const report = (body: string) =>
      db.db
        .prepare("UPDATE tasks SET status = 'completed', result = ? WHERE id = ?")
        .run(JSON.stringify({ provenance: 'worker_report', body }), reviewerTask)
    report('无法判断是否无阻塞意见。')
    await pumpWith(noDispatch, spawn)
    await expect(accept()).rejects.toMatchObject({ code: 'lifecycle_conflict' })
    report('无阻塞意见')
    await pumpWith(noDispatch, spawn)
    worktreeContent = 'unreviewed edit at the same HEAD'
    await expect(accept()).rejects.toThrow('The workspace changed after review.')
    await pumpWith(noDispatch, spawn)
    expect(db.getLatestReviewCycleForTask(writer.task.id)).toMatchObject({
      current_revision: 2,
      state: 'reviewing',
      reviewed_dispatch_id: null
    })
  })

  it('confirms a completed clarification without expanding it as an implementation plan', async () => {
    prepareProject()
    const { input } = await submitEntry('设计多模块系统')
    const [clarification, next] = (
      await routeRoutingInput(db, {
        inputId: input.input_id,
        provider: async () => ({
          subActions: planningTemplateSubActions('设计多模块系统', false, true)
        })
      })
    ).subActions
    const clarifyId = clarification!.sub_action_id
    // v58：clarification 门模板已改 'auto'——手动 grant 对 auto 门行报 no user gate，
    // 放行由泵完成；完成前的计划仍被上游卡住。
    const grant = () =>
      call('orchestration.entryGateGrant', { group: 'proj_alpha', subAction: clarifyId })
    await expect(grant()).rejects.toThrow('has no user gate')
    expect(resolveStageUpstream(db, db.getSubAction(next!.sub_action_id)!)?.blockedOn).not.toEqual(
      []
    )
    settleSubAction(clarifyId, '交付需求说明和验收要点。', 'repo_x::/fixture/wt')
    await pumpWith(
      async () => ({ queued: false }),
      async () => {
        throw new Error('no loop spawn expected')
      }
    )
    // 澄清完成即自动放行（auto 门）；下一阶段解锁，计划阶段仍受人工门约束。
    expect(resolveStageUpstream(db, db.getSubAction(next!.sub_action_id)!)?.blockedOn).toEqual([])
  })

  it('migrates existing clarification cards and scrubs the saved decision credential', async () => {
    prepareProject('git-worktree', true)
    const { input } = await submitEntry('设计多模块系统')
    const [clarification] = (
      await routeRoutingInput(db, {
        inputId: input.input_id,
        provider: async () => ({
          subActions: planningTemplateSubActions('设计多模块系统', false, true)
        })
      })
    ).subActions
    const id = clarification!.sub_action_id
    settleSubAction(id, '交付需求说明。', 'repo_x::/fixture/wt')
    // v55 真实形态：旧模板把澄清行登记为 plan + user_confirm（v56 清洗的命中条件）。
    db.db
      .prepare(
        "UPDATE routing_sub_actions SET stage_kind = 'plan', gate = 'user_confirm', text = '需求澄清与拆解：先把需求整理成一份需求说明——目标、边界与验收要点。', plan_json = ? WHERE sub_action_id = ?"
      )
      .run('{"parseError":"missing orca-plan"}', id)
    db.db
      .prepare('UPDATE routing_inputs SET review_model_json = ? WHERE input_id = ?')
      .run(
        '{"source":"custom","apiKey":"legacy-fixture-key","baseUrl":"https://example.invalid"}',
        input.input_id
      )
    db.db.exec(`
      DROP TABLE entry_review_dispatch_intents;
      ALTER TABLE review_cycles DROP COLUMN reviewed_workspace_revision;
      ALTER TABLE routing_inputs DROP COLUMN require_write_approval;
      ALTER TABLE routing_sub_actions DROP COLUMN write_granted_at;
      PRAGMA user_version = 55;
    `)
    db = h.reopenDatabase()
    expect(db.getRoutingInput(input.input_id)?.review_model_json).toBe(
      '{"source":"custom","agent":null}'
    )
    // 清洗（v56 clarification + plan_json 清空）后 v58 把该门改为 auto——放行由泵完成，
    // 行内无 task/未完成时泵自然跳过；手工 grant 对 auto 门行报 no user gate。
    expect(db.getSubAction(id)).toMatchObject({
      stage_kind: 'clarification',
      gate: 'auto',
      plan_json: null
    })
  })

  it('releases the shared worktree for the next stage after a start failure', async () => {
    prepareProject()
    const { run, input } = await submitEntry('先设计再实施')
    const { subActions } = db.registerRoutingDecision({
      inputId: input.input_id,
      subActions: [
        { text: '澄清需求', stageKind: 'clarification', gate: 'user_confirm' },
        { text: '编写实施代码', stageKind: 'implement', dependsOn: [1] }
      ]
    })
    const [upstream, downstream] = subActions
    const worktree = 'repo_x::/fixture/wt'
    const finished = settleSubAction(upstream!.sub_action_id, '需求说明完成。', worktree)
    db.db
      .prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?")
      .run(finished.dispatch.id)
    db.grantRoutingStageGate(upstream!.sub_action_id)
    const inputId = input.input_id
    const subActionId = downstream!.sub_action_id
    const launchError = new Error('fixture failed before new stage was accepted')
    vi.spyOn(localWorkerStart, 'startLocalWorker')
      .mockRejectedValueOnce(launchError)
      .mockImplementationOnce(async (args) =>
        db.createStartingWorkerDispatch({
          entrySubActionId: args.entrySubActionId,
          taskRunId: run.id,
          taskSpec: args.params.spec,
          startOptions: { agent: args.params.agent },
          creator: { kind: 'system' },
          maxDepth: 5
        })
      )
    const start = () =>
      dispatchEntrySubAction({
        runtime,
        run: run as RunRow,
        group: 'proj_alpha',
        inputId,
        subActionId,
        agent: 'codex',
        placement: { repo: 'id:proj_alpha', agents: ['codex'], supportsReadOnly: true }
      })
    await expect(start()).rejects.toThrow(launchError)
    await start()
    expect(db.getSubAction(subActionId)?.task_id).toEqual(expect.any(String))
  })

  it('enforces the original write restriction at the final admission of every stage', async () => {
    prepareProject()
    const { run, input } = await submitEntry('先调查登录，等我确认才修改登录')
    const { subActions } = db.registerRoutingDecision({
      inputId: input.input_id,
      subActions: [{ text: '调查登录' }, { text: '写入登录实现', stageKind: 'implement' }]
    })
    const write = subActions[1]!
    const start = (readOnly: boolean) =>
      db.createStartingWorkerDispatch({
        entrySubActionId: write.sub_action_id,
        taskRunId: run.id,
        taskSpec: write.text,
        startOptions: { agent: 'codex', readOnly },
        creator: { kind: 'system' },
        maxDepth: 5
      })
    expect(() => start(false)).toThrow('This task requires a read-only Codex worker.')
    expect(db.getSubAction(write.sub_action_id)?.task_id).toBeNull()
    const admitted = start(true)
    expect(db.getSubAction(write.sub_action_id)?.task_id).toBe(admitted.task.id)
  })

  it('holds supplement delivery while the card is paused and releases it on resume', async () => {
    prepareProject()
    const submitted = await submitEntry('改读 new.txt，跳过 old.txt')
    const planned = await planEntry(submitted.input.input_id, ['改读 new.txt'])
    const subActionId = planned.subActions[0]!.sub_action_id
    const seeded = db.createStartingWorkerDispatch({
      entrySubActionId: subActionId,
      taskSpec: '改读 new.txt',
      taskRunId: runId!,
      startOptions: { agent: 'codex' },
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    const paused = await call<{ subAction: { paused_at: string | null } }>(
      'orchestration.entryPause',
      { group: 'proj_alpha', subAction: subActionId }
    )
    expect(paused.subAction.paused_at).not.toBeNull()

    const refused = await call<{ outcome: string; refusalKind?: string }>(
      'orchestration.entrySupplement',
      {
        group: 'proj_alpha',
        input: submitted.input.input_id,
        subAction: subActionId,
        dispatch: seeded.dispatch.id,
        text: '只读检查'
      }
    )
    expect(refused.outcome).toBe('refused')
    expect(refused.refusalKind).toBe('paused')

    const resumed = await call<{ subAction: { paused_at: string | null } }>(
      'orchestration.entryResume',
      { group: 'proj_alpha', subAction: subActionId }
    )
    expect(resumed.subAction.paused_at).toBeNull()
    const redelivered = await call<{ refusalKind?: string }>('orchestration.entrySupplement', {
      group: 'proj_alpha',
      input: submitted.input.input_id,
      subAction: subActionId,
      dispatch: seeded.dispatch.id,
      text: '只读检查'
    })
    expect(redelivered.refusalKind).not.toBe('paused')
  })

  // 阶段化生命周期 (pipeline §11 P0): 确认前零实施派发 → grant → 下一阶段 → 计划解析 →
  // grant 展开 → 依赖序实施（同 worktree、agent hint）。gate 与展开直接走账本层——它们是
  // 行为的所有者；RPC 只是入口校验。
  function settleSubAction(subActionId: string, body: string, worktreeId: string) {
    const seeded = db.createStartingWorkerDispatch({
      entrySubActionId: subActionId,
      taskSpec: subActionId,
      taskRunId: runId!,
      startOptions: { agent: 'codex' },
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    db.db
      .prepare('UPDATE worker_dispatches SET worktree_id = ? WHERE dispatch_id = ?')
      .run(worktreeId, seeded.dispatch.id)
    db.db.prepare("UPDATE tasks SET status = 'completed', result = ? WHERE id = ?").run(
      JSON.stringify({
        provenance: 'worker_report',
        outcome: 'completed',
        subject: subActionId,
        body
      }),
      seeded.task.id
    )
    return seeded
  }

  it('runs the 阶段化链: 原型 → 确认门 → 计划解析 → 确认展开 → 依赖序实施', async () => {
    prepareProject()
    const submitted = await submitEntry('做一个设置页', { loop: true })
    const planned = await planEntry(submitted.input.input_id, [
      { text: '原型设计：产出原型设计稿', stageKind: 'prototype', gate: 'user_confirm' },
      {
        text: '任务设计与拆解：产出 orca-plan',
        stageKind: 'plan',
        gate: 'user_confirm',
        dependsOn: [1]
      }
    ])
    const [prototypeId, planId] = planned.subActions.map((entry) => entry.sub_action_id)

    // 手动规划落库即未授权（§派发授权）：显式 dispatch=true 写入授权后泵才推进。
    await call('orchestration.entryAutoRoute', {
      group: 'proj_alpha',
      input: submitted.input.input_id,
      dispatch: true
    })

    // The classic fan-out must skip stage rows entirely: zero dispatches, zero task bindings.
    const decisionErrors = await dispatchEntryDecision({
      runtime,
      run: { id: runId! } as RunRow,
      group: 'proj_alpha',
      inputId: submitted.input.input_id,
      agents: new Map()
    })
    expect(decisionErrors).toEqual([])
    expect(db.getSubAction(prototypeId)?.task_id).toBeNull()
    expect(db.getSubAction(planId)?.task_id).toBeNull()

    const attempted: string[] = []
    const recordDispatch: EntryDispatchSubAction = async (spawn) => {
      attempted.push(spawn.subActionId)
      return { queued: false }
    }
    // Loop spawns (原型审查) seed a reviewer dispatch that reports 无阻塞意见, like the §7 loop
    // test; stage dispatches stay on the recordDispatch stub.
    const reviewerSpawns: { agent: string; readOnly: boolean; spec: string }[] = []
    const loopSpawn: EntryLoopSpawn = async (spawnRequest) => {
      reviewerSpawns.push({
        agent: spawnRequest.agent,
        readOnly: spawnRequest.readOnly,
        spec: spawnRequest.spec
      })
      const seeded = seedLoopWorker(spawnRequest, 'repo_x::/fixture/wt-a')
      db.db.prepare("UPDATE tasks SET status = 'completed', result = ? WHERE id = ?").run(
        JSON.stringify({
          provenance: 'worker_report',
          outcome: 'completed',
          subject: spawnRequest.taskTitle,
          body: '无阻塞意见'
        }),
        seeded.task.id
      )
      return seeded.dispatch.id
    }

    // Pump 1: only the prototype (no upstream) dispatches; the plan waits on its upstream.
    await pumpWith(recordDispatch, loopSpawn)
    expect(attempted).toEqual([prototypeId])

    // The prototype finished → 循环审查接上：claude 只读审查（原型对照需求），非阻塞意见；
    // cycle 验收前计划保持持有（确认前零推进）。
    settleSubAction(prototypeId, '原型已完成，见 prototype/。', 'repo_x::/fixture/wt-a')
    await pumpWith(recordDispatch, loopSpawn)
    const prototypeTaskId = db.getSubAction(prototypeId)!.task_id!
    const cycle = db.getLatestReviewCycleForTask(prototypeTaskId)
    expect(cycle?.state).toBe('reviewing')
    expect(reviewerSpawns).toHaveLength(1)
    // 原型审查固定 claude 对照需求（宿主已装 claude）。
    expect(reviewerSpawns[0]!.agent).toBe('claude')
    expect(reviewerSpawns[0]!.readOnly).toBe(true)
    // 审查 spec 对照需求本身：原始需求原文随 spec 进入审查者上下文。
    expect(reviewerSpawns[0]!.spec).toContain('原始需求：')
    expect(reviewerSpawns[0]!.spec).toContain('做一个设置页')
    await pumpWith(recordDispatch, loopSpawn)
    expect(attempted).toEqual([prototypeId])
    expect(db.getSubAction(planId)?.task_id ?? null).toBeNull()

    // 用户验收原型 cycle → settle 达成；grant 后计划派发。
    await call('orchestration.entryReviewAccept', {
      group: 'proj_alpha',
      task: prototypeTaskId,
      cycle: cycle!.cycle_id,
      revision: 1
    })
    const prototypeGrant = grantRoutingStageGate.call(db, prototypeId)
    expect(prototypeGrant.expanded).toEqual([])
    await pumpWith(recordDispatch, loopSpawn)
    expect(attempted).toEqual([prototypeId, planId])

    // The plan stage reported an orca-plan: parsed once, no dispatch until the user grants it.
    settleSubAction(
      planId,
      '计划如下：\n```orca-plan\n{"stages":[{"title":"架构与接口契约","agent":"codex","spec":"先定架构与接口契约","checkpoint":true},{"title":"全量验收与交付","agent":"codex","spec":"全量验收并交付"}]}\n```',
      'repo_x::/fixture/wt-a'
    )
    await pumpWith(recordDispatch, loopSpawn)
    expect(attempted).toEqual([prototypeId, planId])
    const planRow = db.getSubAction(planId)!
    expect(planRow.plan_json).not.toBeNull()

    // Granting the plan expands the checkpoint chain (pipeline §8): 中间里程碑 merge 为 auto
    // （其授权已由计划门覆盖），链尾 merge 保留人工确认；implement 与 merge 交替 depends_on。
    const planGrant = grantRoutingStageGate.call(db, planId)
    expect(planGrant.expanded).toHaveLength(4)
    const contractRow = planGrant.expanded[0]!
    const midMergeRow = planGrant.expanded[1]!
    const acceptanceRow = planGrant.expanded[2]!
    const tailMergeRow = planGrant.expanded[3]!
    expect(contractRow.stage_kind).toBe('implement')
    expect(contractRow.gate).toBe('auto')
    expect(contractRow.agent_hint).toBe('codex')
    expect(contractRow.plan_source_id).toBe(planId)
    expect(JSON.parse(contractRow.depends_on_json!)).toEqual([planId])
    expect(midMergeRow.stage_kind).toBe('merge')
    expect(midMergeRow.gate).toBe('auto')
    expect(JSON.parse(midMergeRow.depends_on_json!)).toEqual([contractRow.sub_action_id])
    expect(acceptanceRow.stage_kind).toBe('implement')
    expect(acceptanceRow.agent_hint).toBe('codex')
    expect(JSON.parse(acceptanceRow.depends_on_json!)).toEqual([midMergeRow.sub_action_id])
    expect(tailMergeRow.stage_kind).toBe('merge')
    expect(tailMergeRow.gate).toBe('user_confirm')
    expect(JSON.parse(tailMergeRow.depends_on_json!)).toEqual([acceptanceRow.sub_action_id])

    // The expanded stage dispatches through the dependency gate: same upstream worktree, hint.
    await pumpWith(recordDispatch, loopSpawn)
    expect(attempted.at(-1)).toBe(contractRow.sub_action_id)
    const upstream = resolveStageUpstream(db, db.getSubAction(contractRow.sub_action_id)!)
    expect(upstream?.blockedOn).toEqual([])
    expect(upstream?.worktreeId).toBe('repo_x::/fixture/wt-a')
    // merge 检查点走系统合并（无 worker 派发）：中间里程碑等上游 settle 自动执行，链尾等人工确认。
    expect(attempted).not.toContain(midMergeRow.sub_action_id)
    expect(attempted).not.toContain(tailMergeRow.sub_action_id)
    expect(midMergeRow.task_id).toBeNull()
    expect(tailMergeRow.task_id).toBeNull()

    // A replayed grant is idempotent: no second expansion.
    expect(grantRoutingStageGate.call(db, planId).expanded).toHaveLength(4)

    // 中间里程碑：契约阶段 settle 并过循环审查后，auto 合并由泵直接执行。fixture 工作树无法
    // 真合并 → 失败即升级人工确认（gate 变回 user_confirm + entry_error），不自动重试；
    // 下游实施仍被未合并的里程碑挡住。
    settleSubAction(contractRow.sub_action_id, '架构契约已定稿。', 'repo_x::/fixture/wt-a')
    await pumpWith(recordDispatch, loopSpawn)
    const contractTaskId = db.getSubAction(contractRow.sub_action_id)!.task_id!
    const contractCycle = db.getLatestReviewCycleForTask(contractTaskId)
    expect(contractCycle?.state).toBe('reviewing')
    await call('orchestration.entryReviewAccept', {
      group: 'proj_alpha',
      task: contractTaskId,
      cycle: contractCycle!.cycle_id,
      revision: 1
    })
    await pumpWith(recordDispatch, loopSpawn)
    const promoted = db.getSubAction(midMergeRow.sub_action_id)!
    expect(promoted.gate).toBe('user_confirm')
    expect(promoted.gate_granted_at).toBeNull()
    expect(promoted.entry_error).not.toBeNull()
    expect(promoted.merged_at).toBeNull()
    expect(attempted).not.toContain(midMergeRow.sub_action_id)
    expect(db.getSubAction(acceptanceRow.sub_action_id)?.task_id ?? null).toBeNull()
    expect(
      resolveStageUpstream(db, db.getSubAction(acceptanceRow.sub_action_id)!)?.blockedOn
    ).toEqual([midMergeRow.sub_action_id])
  })

  it('holds the chain when the plan report has no orca-plan block; granting is refused', async () => {
    prepareProject()
    const submitted = await submitEntry('做一个设置页')
    const planned = await planEntry(submitted.input.input_id, [
      { text: '任务设计与拆解', stageKind: 'plan', gate: 'user_confirm' }
    ])
    const planId = planned.subActions[0]!.sub_action_id
    await call('orchestration.entryAutoRoute', {
      group: 'proj_alpha',
      input: submitted.input.input_id,
      dispatch: true
    })
    settleSubAction(planId, '我做完了，但忘了输出计划块。', 'repo_x::/fixture/wt-a')
    const recordDispatch: EntryDispatchSubAction = async () => ({ queued: false })
    await pumpWith(recordDispatch, async () => {
      throw new Error('no loop spawn expected')
    })
    expect(JSON.parse(db.getSubAction(planId)!.plan_json!)).toMatchObject({
      parseError: expect.any(String)
    })
    expect(() => grantRoutingStageGate.call(db, planId)).toThrow(/orca-plan/)
  })
})
