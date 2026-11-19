import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../core'
import { createOrchestrationRpcHarness } from './rpc-test-harness'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import { createRootDispatch } from '../../../orchestration/db/root-dispatch-test-fixture'
import {
  partialRuntimeStore,
  storeRepo
} from '../../../orca-runtime-tests/runtime-store-partial-fixture'

const decisionModel = {
  provider: 'custom',
  baseUrl: 'https://custom.example/v1',
  apiKey: 'synthetic-key',
  modelId: 'test'
}

const request = '修登录，另外查启动慢'

describe('desktop entry methods (plan §1/§9-A per-project 入口)', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext

  afterEach(() => {
    h.cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // Typed at each call site: the harness erases handler result types, so every call names the
  // receipt shape its method documents.
  async function call<T>(name: string, params: Record<string, unknown>): Promise<T> {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the asserted shape is the called method's documented receipt.
    return (await h.call(name, params, ctx)) as T
  }

  function prepareWorkers() {
    const repo = storeRepo({ id: 'proj_alpha', path: '/fixture/project', kind: 'git' })
    const state = h.setup(
      false,
      partialRuntimeStore({
        getRepos: () => [repo],
        getSettings: () => ({ defaultTuiAgent: 'codex', nativeChatProviders: {} })
      })
    )
    db = state.db
    ctx = { ...state.ctx, caller: { kind: 'desktop' } }
    const { runtime } = state
    vi.spyOn(runtime, 'detectProjectLaunchContext').mockResolvedValue({
      agents: ['codex', 'claude', 'zcode'],
      workspaceKind: 'git-worktree',
      executionContext: { kind: 'ssh' }
    })
    vi.spyOn(runtime, 'showRepo').mockResolvedValue(repo)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'listManagedWorktrees').mockResolvedValue({
      worktrees: [],
      totalCount: 0,
      truncated: false
    })
    vi.spyOn(runtime, 'listRetiredWorktreeNames').mockResolvedValue({
      retiredNamesByRepo: {},
      retiredNameTiersByRepo: {}
    })
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => `pane:${handle}`)
    vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
      runtime.getTerminalPaneKey(handle)
    )
    let nextWorker = 0
    vi.spyOn(runtime, 'createManagedWorktree').mockImplementation(async () => {
      const id = ++nextWorker
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this terminal-transport fixture supplies the worktree/start fields read by worker-start.
      return {
        worktree: { id: `wt_${id}` },
        startupTerminal: { spawned: true, handle: `term_${id}` }
      } as never
    })
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [],
      totalCount: 0,
      truncated: false
    })
    vi.spyOn(runtime, 'waitForTerminal').mockImplementation(async (handle) => ({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    }))
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockImplementation(async (handle) => ({
      handle,
      accepted: true,
      bytesWritten: 1
    }))
  }

  type TaskCard = {
    subAction: { sub_action_id: string; text: string; task_id: string | null }
    execution: { agent: string; dispatchId: string; status: string; result: string | null } | null
  }

  const group = 'proj_alpha'

  async function submitRequest(text = request) {
    const { input } = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text
    })
    return input.input_id
  }

  async function readCards() {
    const { inputs } = await call<{ inputs: { subActions: TaskCard[] }[] }>(
      'orchestration.entryShow',
      { group }
    )
    return inputs[0]!.subActions
  }

  async function reportResult(card: TaskCard, body: string) {
    if (!card.subAction.task_id || !card.execution) {
      throw new Error('Worker was not dispatched')
    }
    const from = db.getDispatchContextById(card.execution.dispatchId)?.assignee_handle
    if (!from) {
      throw new Error('Worker has no reporting identity')
    }
    await call('orchestration.send', {
      from,
      type: 'worker_done',
      subject: 'Done',
      body,
      payload: JSON.stringify({
        taskId: card.subAction.task_id,
        dispatchId: card.execution.dispatchId,
        outcome: 'succeeded'
      })
    })
  }

  it('auto-dispatches independent work and shows each worker result on its own card', async () => {
    prepareWorkers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      '{"subActions":[{"text":"修登录","agent":"codex"},{"text":"查启动慢","agent":"claude"}]}'
                  }
                }
              ]
            })
          )
      )
    )
    const input = await submitRequest('用 Codex 修登录，另外用 Claude 查启动慢')
    const route = { group, input, dispatch: true, decisionModel }
    expect(await call('orchestration.entryAutoRoute', route)).toMatchObject({
      routed: true,
      dispatchErrors: []
    })
    const [login, startup] = await readCards()
    expect(login.execution).toMatchObject({ agent: 'codex', status: 'dispatched' })
    expect(startup.execution).toMatchObject({ agent: 'claude', status: 'dispatched' })
    expect(login.execution?.dispatchId).not.toBe(startup.execution?.dispatchId)

    const runId = db.getTask(startup.subAction.task_id!)!.run_id
    db.insertMessage({
      runId,
      from: 'term_2',
      to: `run:${runId}`,
      type: 'escalation',
      subject: 'Agent hit an error',
      payload: JSON.stringify({
        dispatchId: startup.execution?.dispatchId,
        error: 'Select a model'
      })
    })
    expect(await readCards()).toMatchObject([
      { execution: { status: 'dispatched' } },
      { execution: { status: 'attention', failure: 'Select a model' } }
    ])

    await reportResult(startup, '启动慢由同步预热导致')
    expect(await readCards()).toMatchObject([
      { subAction: { text: '修登录' }, execution: { status: 'dispatched', result: null } },
      {
        subAction: { text: '查启动慢' },
        execution: { status: 'completed', result: '启动慢由同步预热导致' }
      }
    ])
    await reportResult(login, '已修复旧账号登录')
    await call('orchestration.entryAutoRoute', route)
    expect(await readCards()).toMatchObject([
      {
        execution: {
          dispatchId: login.execution?.dispatchId,
          status: 'completed',
          result: '已修复旧账号登录'
        }
      },
      {
        execution: {
          dispatchId: startup.execution?.dispatchId,
          status: 'completed',
          result: '启动慢由同步预热导致'
        }
      }
    ])
  })

  it('keeps each manually split task pending until its worker is chosen', async () => {
    prepareWorkers()
    const input = await submitRequest()
    await call('orchestration.entryPlan', { group, input, subActions: ['修登录', '查启动慢'] })
    const [login, startup] = await readCards()
    const assign = (card: TaskCard, agent: string) =>
      call('orchestration.entryAssign', {
        group,
        input,
        subAction: card.subAction.sub_action_id,
        agent
      })
    await expect(assign(startup, 'opencode')).rejects.toMatchObject({ code: 'agent_unconfigured' })
    await assign(login, 'claude')
    expect(await readCards()).toMatchObject([
      { execution: { agent: 'claude', status: 'dispatched' } },
      { execution: null }
    ])
    await assign(startup, 'codex')
    const [assignedLogin, assignedStartup] = await readCards()
    await reportResult(assignedLogin, '已修复登录')
    await reportResult(assignedStartup, '已定位启动阻塞')
    expect(await readCards()).toMatchObject([
      {
        subAction: { text: '修登录' },
        execution: { agent: 'claude', status: 'completed', result: '已修复登录' }
      },
      {
        subAction: { text: '查启动慢' },
        execution: { agent: 'codex', status: 'completed', result: '已定位启动阻塞' }
      }
    ])
  })

  it('shows an empty standing entry before the first request', async () => {
    ;({ ctx } = h.setup(false))
    const show = await call<{ run: unknown; inputs: unknown[]; watchdog: { paused: boolean } }>(
      'orchestration.entryShow',
      { group: 'proj_alpha' }
    )
    expect(show.run).toBeNull()
    expect(show.inputs).toEqual([])
    expect(show.watchdog.paused).toBe(false)
  })

  it('creates the entry Run on first submit and appends later requests to the same Run', async () => {
    ;({ ctx } = h.setup(false))
    const first = await call<{
      run: { id: string }
      input: { input_id: string; received_seq: number }
    }>('orchestration.entrySubmit', { group: 'proj_alpha', text: '修登录，另外查启动慢' })
    const second = await call<{
      run: { id: string }
      input: { input_id: string; received_seq: number }
    }>('orchestration.entrySubmit', { group: 'proj_alpha', text: '统计手册页数' })
    expect(second.run.id).toBe(first.run.id)
    expect(first.input.received_seq).toBe(1)
    expect(second.input.received_seq).toBe(2)

    const show = await call<{ run: { id: string }; inputs: { input: { input_id: string } }[] }>(
      'orchestration.entryShow',
      { group: 'proj_alpha' }
    )
    expect(show.run.id).toBe(first.run.id)
    expect(show.inputs.map((entry) => entry.input.input_id)).toEqual([
      first.input.input_id,
      second.input.input_id
    ])
  })

  it('keeps per-project entries isolated from each other', async () => {
    ;({ ctx } = h.setup(false))
    const alpha = await call<{ run: { id: string }; input: { input_id: string } }>(
      'orchestration.entrySubmit',
      { group: 'proj_alpha', text: 'alpha 请求' }
    )
    const beta = await call<{ run: { id: string } }>('orchestration.entrySubmit', {
      group: 'proj_beta',
      text: 'beta 请求'
    })
    expect(beta.run.id).not.toBe(alpha.run.id)
    const alphaShow = await call<{ inputs: { input: { input_id: string } }[] }>(
      'orchestration.entryShow',
      { group: 'proj_alpha' }
    )
    expect(alphaShow.inputs).toHaveLength(1)
    await expect(
      call<unknown>('orchestration.entrySupplement', {
        group: 'proj_beta',
        input: alpha.input.input_id,
        subAction: 'sa_x',
        dispatch: 'dispatch_x',
        text: '误投'
      })
    ).rejects.toMatchObject({ code: 'lifecycle_not_found' })
  })

  it('delivers and hands back a sub-action inside the entry Run', async () => {
    ;({ db, ctx } = h.setup(false))
    const submitted = await call<{ run: { id: string }; input: { input_id: string } }>(
      'orchestration.entrySubmit',
      { group: 'proj_alpha', text: '只读 new.txt，跳过 old.txt' }
    )
    const { subActions } = db.registerRoutingDecision({
      inputId: submitted.input.input_id,
      subActions: [{ text: '改读 new.txt' }]
    })
    const subActionId = subActions[0]!.sub_action_id
    const task = db.createTask({ runId: submitted.run.id, spec: 'entry worker' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')

    const send = await call<{ outcome: string; refusalKind?: string }>(
      'orchestration.entrySupplement',
      {
        group: 'proj_alpha',
        input: submitted.input.input_id,
        subAction: subActionId,
        dispatch: dispatch.id,
        text: '只读 new.txt，跳过 old.txt'
      }
    )
    expect(send.outcome).toBe('refused')

    // A refused delivery never claims; after an explicit claim the guarded handback releases.
    db.claimSubActionForDispatch(subActionId, dispatch.id)
    const handback = await call<{ released: boolean }>('orchestration.entryHandback', {
      group: 'proj_alpha',
      subAction: subActionId,
      dispatch: dispatch.id
    })
    expect(handback.released).toBe(true)
  })

  it('pauses and resumes the entry run, refusing supplements while paused', async () => {
    ;({ ctx } = h.setup(false))
    const submitted = await call<{ run: { id: string }; input: { input_id: string } }>(
      'orchestration.entrySubmit',
      { group: 'proj_alpha', text: '暂停期间不投递' }
    )
    const paused = await call<{ watchdog: { paused: boolean } }>('orchestration.entryPause', {
      group: 'proj_alpha'
    })
    expect(paused.watchdog.paused).toBe(true)
    await expect(
      call<unknown>('orchestration.entrySupplement', {
        group: 'proj_alpha',
        input: submitted.input.input_id,
        subAction: 'sa_x',
        dispatch: 'dispatch_x',
        text: '任何内容'
      })
    ).rejects.toMatchObject({ code: 'paused' })
    const resumed = await call<{ watchdog: { paused: boolean } }>('orchestration.entryResume', {
      group: 'proj_alpha'
    })
    expect(resumed.watchdog.paused).toBe(false)
  })

  it('shows and accepts the review cycle of a delegated task, scoped to the entry run', async () => {
    ;({ db, ctx } = h.setup(false))
    const submitted = await call<{ run: { id: string }; input: { input_id: string } }>(
      'orchestration.entrySubmit',
      { group: 'proj_alpha', text: '带审查的任务' }
    )
    const task = db.createTask({ runId: submitted.run.id, spec: 'entry worker' })
    const dispatch = createRootDispatch(db, task.id, 'term_writer')
    db.startReviewCycle({
      taskId: task.id,
      writerDispatchId: dispatch.id,
      reviewerDispatchId: 'ctx_reviewer'
    })
    const show = await call<{ cycle: { state: string } | null }>('orchestration.entryReviewShow', {
      group: 'proj_alpha',
      task: task.id
    })
    expect(show.cycle?.state).toBe('reviewing')
    // A task of another Run is not the entry's to accept.
    const otherRun = db.createRun({
      objective: 'Other run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: null
    })
    const otherTask = db.createTask({ runId: otherRun.id, spec: 'other run task' })
    await expect(
      call<unknown>('orchestration.entryReviewShow', { group: 'proj_alpha', task: otherTask.id })
    ).rejects.toMatchObject({ code: 'lifecycle_not_found' })
    const accepted = await call<{ cycle: { state: string } }>('orchestration.entryReviewAccept', {
      group: 'proj_alpha',
      task: task.id
    })
    expect(accepted.cycle.state).toBe('accepted')
    void ctx
  })

  it('auto-routes with a custom decision model endpoint', async () => {
    ;({ ctx } = h.setup(false))
    const submitted = await call<{ run: { id: string }; input: { input_id: string } }>(
      'orchestration.entrySubmit',
      { group: 'proj_alpha', text: '自定义端点拆分' }
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"subActions":[{"text":"拆分A"}]}' } }]
            }),
            { status: 200 }
          )
      )
    )
    const routed = await call<{ routed: boolean; subActions: { text: string }[] }>(
      'orchestration.entryAutoRoute',
      {
        group: 'proj_alpha',
        input: submitted.input.input_id,
        decisionModel: {
          provider: 'custom',
          baseUrl: 'https://custom.example/v1',
          apiKey: 'synthetic-custom-key',
          modelId: 'custom-model'
        }
      }
    )
    expect(routed.routed).toBe(true)
    expect(routed.subActions.map((subAction) => subAction.text)).toEqual(['拆分A'])
    const call0 = vi.mocked(fetch).mock.calls[0]
    expect(String(call0[0])).toContain('custom.example')
  })
})
