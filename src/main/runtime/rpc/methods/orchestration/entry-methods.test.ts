import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../core'
import { createOrchestrationRpcHarness } from './rpc-test-harness'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import { routeRoutingInput } from '../../../orchestration/routing/routing-router'
import { createRootDispatch } from '../../../orchestration/db/root-dispatch-test-fixture'
import {
  partialRuntimeStore,
  storeRepo
} from '../../../orca-runtime-tests/runtime-store-partial-fixture'

const decisionModel = { source: 'agent' as const }

const routeProposal = vi.hoisted(() => ({ fn: vi.fn<() => Promise<unknown>>() }))

vi.mock('../../../orchestration/routing/agent-route-proposal-provider', () => ({
  createAgentRouteProposalProvider: () => routeProposal.fn
}))

const request = '修登录，另外查启动慢'

describe('desktop entry methods (plan §1/§9-A per-project 入口)', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext

  afterEach(() => {
    h.cleanup()
    vi.unstubAllGlobals()
    routeProposal.fn.mockReset()
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

  async function readCards(
    method: 'orchestration.entryShow' | 'orchestration.entryPeek' = 'orchestration.entryShow'
  ) {
    const { inputs } = await call<{ inputs: { subActions: TaskCard[] }[] }>(method, { group })
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
    routeProposal.fn.mockImplementation(async () => ({
      version: 1,
      actions: [
        { key: 'a1', type: 'create_task', instruction: '修登录', agent: 'codex' },
        { key: 'a2', type: 'create_task', instruction: '优化启动', agent: 'claude' }
      ]
    }))
    const input = await submitRequest('用 Codex 修登录，另外用 Claude 优化启动')
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
    expect(await readCards('orchestration.entryPeek')).toMatchObject([
      { subAction: { text: '修登录' }, execution: { status: 'dispatched', result: null } },
      {
        subAction: { text: '优化启动' },
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
    await call('orchestration.entryPlan', { group, input, subActions: ['修登录', '优化启动'] })
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
        subAction: { text: '优化启动' },
        execution: { agent: 'codex', status: 'completed', result: '已定位启动阻塞' }
      }
    ])
  })

  it('blocks a gated investigation on a host without read-only worker support', async () => {
    prepareWorkers()
    const input = await submitRequest('修登录，另外查启动慢，等我确认才修改启动问题')
    routeProposal.fn.mockImplementation(async () => ({
      version: 1,
      actions: [
        { key: 'a1', type: 'create_task', instruction: '修登录' },
        { key: 'a2', type: 'create_task', instruction: '查启动慢，等我确认再修改' }
      ]
    }))
    await call('orchestration.entryAutoRoute', { group, input, dispatch: true, decisionModel })
    const cards = await readCards()
    expect(cards).toMatchObject([
      { subAction: { text: '修登录' }, execution: null },
      { subAction: { text: '查启动慢，等我确认再修改' }, execution: null }
    ])
    await expect(
      call('orchestration.entryAssign', {
        group,
        input,
        subAction: cards[1]!.subAction.sub_action_id,
        agent: 'codex'
      })
    ).rejects.toMatchObject({ code: 'agent_unconfigured' })
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
    expect(send).toMatchObject({ outcome: 'refused', refusalKind: 'admission-refused' })
    expect(() => db.claimSubActionForDispatch(subActionId, dispatch.id)).toThrow(
      'This task requires a read-only Codex worker.'
    )
    expect(db.getSubAction(subActionId)?.claimed_dispatch_id).toBeNull()
    const authorized = db.createStartingWorkerDispatch({
      taskRunId: submitted.run.id,
      taskSpec: '只读检查',
      startOptions: { agent: 'codex', readOnly: true },
      creator: { kind: 'system' },
      maxDepth: 5
    })
    db.claimSubActionForDispatch(subActionId, authorized.dispatch.id)
    const handback = await call<{ released: boolean }>('orchestration.entryHandback', {
      group: 'proj_alpha',
      subAction: subActionId,
      dispatch: authorized.dispatch.id
    })
    expect(handback.released).toBe(true)
  })

  it('transfers an existing assignment and records delivery for the new assignee', async () => {
    ;({ db, ctx } = h.setup(false))
    const { run, input } = await call<{ run: { id: string }; input: { input_id: string } }>(
      'orchestration.entrySubmit',
      { group, text: 'Review startup latency' }
    )
    const { subActions } = db.registerRoutingDecision({
      inputId: input.input_id,
      subActions: [{ text: 'Review startup latency' }]
    })
    const subAction = subActions[0]!.sub_action_id
    const original = createRootDispatch(
      db,
      db.createTask({ runId: run.id, spec: 'original worker' }).id,
      'term_original'
    )
    const destination = createRootDispatch(
      db,
      db.createTask({ runId: run.id, spec: 'destination worker' }).id,
      'term_destination'
    )
    db.claimSubActionForDispatch(subAction, original.id)
    const transfer = {
      group,
      input: input.input_id,
      subAction,
      fromDispatch: original.id,
      dispatch: destination.id,
      text: 'Focus on cold startup'
    }

    await expect(
      call('orchestration.entryTransfer', { ...transfer, fromDispatch: null })
    ).rejects.toMatchObject({ code: 'lifecycle_conflict' })
    expect(db.getSubAction(subAction)?.claimed_dispatch_id).toBe(original.id)
    expect(db.listSupplements(subAction)).toEqual([])

    await expect(call('orchestration.entryTransfer', transfer)).resolves.toMatchObject({
      dispatchId: destination.id,
      outcome: 'refused',
      refusalKind: 'not-structured-here'
    })
    expect(db.getSubAction(subAction)?.claimed_dispatch_id).toBe(destination.id)
    expect(db.listSubActionHandbacks(subAction)).toMatchObject([
      { handed_back_from: original.id, reason: 'desktop-entry-transfer' }
    ])
    expect(db.listSupplements(subAction)).toMatchObject([
      { target_dispatch_id: destination.id, raw_text: 'Focus on cold startup' }
    ])
    await expect(call('orchestration.entryTransfer', transfer)).rejects.toMatchObject({
      code: 'lifecycle_conflict'
    })
    expect(db.listSupplements(subAction)).toHaveLength(1)
  })

  it('preserves a paused follow-up and pauses again after resume', async () => {
    ;({ db, ctx } = h.setup(false))
    const { run, input } = await call<{ run: { id: string }; input: { input_id: string } }>(
      'orchestration.entrySubmit',
      { group, text: '查启动慢' }
    )
    const { subActions } = db.registerRoutingDecision({
      inputId: input.input_id,
      subActions: [{ text: '查启动慢' }]
    })
    const subAction = subActions[0]!.sub_action_id
    const task = db.createTask({ runId: run.id, spec: '查启动慢' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    await call('orchestration.entryPause', { group })
    const followUp = await call<{ supplementId: string }>('orchestration.entrySupplement', {
      group,
      input: input.input_id,
      subAction,
      dispatch: dispatch.id,
      text: '补查冷启动'
    })
    expect(followUp).toMatchObject({ outcome: 'refused', refusalKind: 'paused' })
    expect(db.getSupplement(followUp.supplementId)).toMatchObject({
      raw_text: '补查冷启动',
      target_dispatch_id: dispatch.id
    })
    expect(await call('orchestration.entryResume', { group })).toMatchObject({
      watchdog: { paused: false }
    })
    expect(await call('orchestration.entryPause', { group })).toMatchObject({
      watchdog: { paused: true }
    })
  })

  it('reads a scoped review and requires a person and a verified result to accept', async () => {
    ;({ db, ctx } = h.setup(false))
    const submitted = await call<{ run: { id: string }; input: { input_id: string } }>(
      'orchestration.entrySubmit',
      { group: 'proj_alpha', text: '带审查的任务' }
    )
    const task = db.createTask({ runId: submitted.run.id, spec: 'entry worker' })
    const dispatch = createRootDispatch(db, task.id, 'term_writer')
    const cycle = db.startReviewCycle({
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
    const accept = () =>
      call('orchestration.entryReviewAccept', {
        group: 'proj_alpha',
        task: task.id,
        cycle: cycle.cycle_id,
        revision: 1
      })
    await expect(accept()).rejects.toMatchObject({ code: 'approval_requires_person' })
    ctx = { ...ctx, caller: { kind: 'desktop' } }
    await expect(accept()).rejects.toMatchObject({ code: 'lifecycle_conflict' })
  })

  it('keeps the decision model credential outside submitted tasks and entry reads', async () => {
    ;({ db, ctx } = h.setup(false))
    const submit = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group: 'proj_alpha',
      text: '修改登录',
      decisionModel
    })
    expect(submit.input).not.toHaveProperty('review_model_json')
    expect(db.getRoutingInput(submit.input.input_id)?.review_model_json).toBe('{"source":"agent"}')
    const result = await call<{ inputs: { input: unknown }[] }>('orchestration.entryShow', {
      group: 'proj_alpha'
    })
    expect(result.inputs[0]?.input).not.toHaveProperty('review_model_json')
  })

  it('clears failed assignments in the current project while retaining assigned and unattempted instructions', async () => {
    prepareWorkers()
    const input = await submitRequest()
    await call('orchestration.entryPlan', {
      group,
      input,
      subActions: ['assign successfully', 'assign unsuccessfully', 'leave unassigned']
    })
    const [assigned, failed, unassigned] = await readCards()
    if (!assigned || !failed || !unassigned) {
      throw new Error('Missing sub-actions')
    }

    await call('orchestration.entryAssign', {
      group,
      input,
      subAction: assigned.subAction.sub_action_id,
      agent: 'codex'
    })
    await expect(
      call('orchestration.entryAssign', {
        group,
        input,
        subAction: failed.subAction.sub_action_id,
        agent: 'missing-worker'
      })
    ).rejects.toMatchObject({ code: 'agent_unconfigured' })

    const routingFailed = await submitRequest('cannot route')
    const untouched = await submitRequest('awaiting routing')
    await call('orchestration.entryAutoRoute', {
      group,
      input: routingFailed,
      dispatch: true,
      decisionModel: { source: 'agent', agent: 'missing-worker' }
    })
    const otherGroup = 'proj_beta'
    const { input: otherInput } = await call<{ input: { input_id: string } }>(
      'orchestration.entrySubmit',
      { group: otherGroup, text: 'another project' }
    )
    await call('orchestration.entryAutoRoute', {
      group: otherGroup,
      input: otherInput.input_id,
      dispatch: true,
      decisionModel: { source: 'agent', agent: 'missing-worker' }
    })
    await expect(call('orchestration.entryDelete', { group, scope: 'failed' })).resolves.toEqual({
      deleted: 2
    })
    expect((await readCards()).map(({ subAction }) => subAction.text)).toEqual([
      'assign successfully',
      'leave unassigned'
    ])
    expect(db.getRoutingInput(routingFailed)).toBeUndefined()
    expect(db.getRoutingInput(untouched)?.raw_text).toBe('awaiting routing')
    expect(db.getRoutingInput(otherInput.input_id)?.raw_text).toBe('another project')

    await expect(
      call('orchestration.entryDelete', { group, scope: 'request', input })
    ).rejects.toMatchObject({ code: 'lifecycle_conflict' })
    await expect(
      call('orchestration.entryDelete', {
        group,
        scope: 'sub-action',
        input,
        subAction: assigned.subAction.sub_action_id
      })
    ).rejects.toMatchObject({ code: 'lifecycle_conflict' })
    await expect(
      call('orchestration.entryDelete', {
        group,
        scope: 'sub-action',
        input,
        subAction: unassigned.subAction.sub_action_id
      })
    ).resolves.toEqual({ deleted: 1 })
    await expect(
      call('orchestration.entryDelete', { group, scope: 'request', input: untouched })
    ).resolves.toEqual({ deleted: 1 })
    expect((await readCards()).map(({ subAction }) => subAction.text)).toEqual([
      'assign successfully'
    ])
  })

  it('clears every deletable instruction with scope all, keeping running and other projects', async () => {
    prepareWorkers()
    const running = await submitRequest('still running')
    await call('orchestration.entryPlan', {
      group,
      input: running,
      subActions: ['long running task']
    })
    const planned = db.listSubActions(running)[0]
    await call('orchestration.entryAssign', {
      group,
      input: running,
      subAction: planned.sub_action_id,
      agent: 'codex'
    })
    const received = await submitRequest('awaiting routing')
    const failed = await submitRequest('cannot route')
    await call('orchestration.entryAutoRoute', {
      group,
      input: failed,
      dispatch: true,
      decisionModel: { source: 'agent', agent: 'missing-worker' }
    })
    const otherGroup = 'proj_gamma'
    const { input: otherInput } = await call<{ input: { input_id: string } }>(
      'orchestration.entrySubmit',
      { group: otherGroup, text: 'another project' }
    )

    // best-effort 清扫：received + 失败的可删，被认领在跑的和其他项目保留。
    await expect(call('orchestration.entryDelete', { group, scope: 'all' })).resolves.toEqual({
      deleted: 2
    })
    expect(db.getRoutingInput(running)?.raw_text).toBe('still running')
    expect(db.getRoutingInput(received)).toBeUndefined()
    expect(db.getRoutingInput(failed)).toBeUndefined()
    expect(db.getRoutingInput(otherInput.input_id)?.raw_text).toBe('another project')
    expect((await readCards()).map(({ subAction }) => subAction.text)).toEqual([
      'long running task'
    ])
  })

  it('clears a confirmed worker start failure and preserves a worker that accepted the instruction', async () => {
    prepareWorkers()
    const input = await submitRequest()
    await call('orchestration.entryPlan', {
      group,
      input,
      subActions: ['worker starts', 'worker launch fails']
    })
    const [started, failed] = await readCards()
    if (!started || !failed) {
      throw new Error('Missing sub-actions')
    }
    await call('orchestration.entryAssign', {
      group,
      input,
      subAction: started.subAction.sub_action_id,
      agent: 'codex'
    })
    vi.mocked(ctx.runtime.createManagedWorktree).mockRejectedValueOnce(
      new Error('Project worktree unavailable')
    )
    await call('orchestration.entryAssign', {
      group,
      input,
      subAction: failed.subAction.sub_action_id,
      agent: 'codex'
    }).catch(() => undefined)
    expect(await readCards()).toMatchObject([
      { execution: { status: 'dispatched' } },
      { execution: { status: 'failed' }, assignmentFailed: true, canDelete: true }
    ])
    await expect(call('orchestration.entryDelete', { group, scope: 'failed' })).resolves.toEqual({
      deleted: 1
    })
    expect(await readCards()).toMatchObject([{ execution: { status: 'dispatched' } }])
    const nextInput = await submitRequest('later instruction')
    await routeRoutingInput(db, {
      inputId: nextInput,
      provider: async ({ candidateTasks }) => {
        expect(candidateTasks.map((task) => task.spec)).toEqual(['worker starts'])
        return { subActions: [{ text: 'new instruction' }] }
      }
    }).then((result) => expect(result.routed).toBe(true))
  })
})
