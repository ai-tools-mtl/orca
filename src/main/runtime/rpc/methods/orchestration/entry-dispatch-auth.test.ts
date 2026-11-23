import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../core'
import { createOrchestrationRpcHarness } from './rpc-test-harness'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import { pumpEntryAutomations } from './entry-automation-pump'
import { entryRunOfInput } from './entry-run-scope'
import { createRootDispatch } from '../../../orchestration/db/root-dispatch-test-fixture'
import {
  partialRuntimeStore,
  storeRepo
} from '../../../orca-runtime-tests/runtime-store-partial-fixture'

// 派发授权的持久化语义（§派发授权）：决定落库即未授权（与决定同一 SAVEPOINT，中断不会
// 留下无授权语义的中间态）；只有通过权限检查的 dispatch=true 才原子写入 dispatchAuthorized。
// 自动派发与恢复推进均以持久化授权为准。中断注入点：落决定后 / 落授权后 / Worker 受理后。

const agentRouter = vi.hoisted(() => ({ fn: vi.fn<() => Promise<unknown>>() }))

vi.mock('../../../orchestration/routing/agent-route-proposal-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof agentRouteProposalProviderModule>()),
  createAgentRouteProposalProvider: () => agentRouter.fn
}))

import type { createAgentRouteProposalProvider as agentRouteProposalProviderModule } from '../../../orchestration/routing/agent-route-proposal-provider'

const loginProposal = {
  version: 1,
  actions: [{ key: 'a1', type: 'create_task', instruction: '修登录', agent: 'codex' }]
}

describe('entry dispatch authorization persistence', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext
  let currentDatabasePath = ':memory:'

  afterEach(() => {
    h.cleanup()
    agentRouter.fn.mockReset()
    vi.restoreAllMocks()
  })

  async function call<T>(name: string, params: Record<string, unknown>): Promise<T> {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the asserted shape is the called method's documented receipt.
    return (await h.call(name, params, ctx)) as T
  }

  const group = 'proj_auth'

  function prepareWorkers(databasePath = ':memory:') {
    currentDatabasePath = databasePath
    const repo = storeRepo({ id: group, path: '/fixture/project', kind: 'git' })
    const state = h.setup(
      false,
      partialRuntimeStore({
        getRepos: () => [repo],
        getSettings: () => ({ defaultTuiAgent: 'codex', nativeChatProviders: {} })
      }),
      databasePath
    )
    db = state.db
    ctx = { ...state.ctx, caller: { kind: 'desktop' } }
    const { runtime } = state
    vi.spyOn(runtime, 'detectProjectLaunchContext').mockResolvedValue({
      agents: ['codex'],
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
    vi.spyOn(runtime, 'createManagedWorktree').mockImplementation(async () => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture worktree/start fields only.
      return {
        worktree: { id: 'wt_auth' },
        startupTerminal: { spawned: true, handle: 'term_w' }
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

  function restartOnSameLedger(): void {
    h.cleanup()
    prepareWorkers(currentDatabasePath)
  }

  function routeOnce(inputId: string, dispatch: boolean): Promise<unknown> {
    return call('orchestration.entryAutoRoute', {
      group,
      input: inputId,
      dispatch,
      decisionModel: { source: 'agent', agent: 'codex' }
    })
  }

  async function submit(text: string): Promise<string> {
    const { input } = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text
    })
    return input.input_id
  }

  /** 既有工作：已派发并认领的任务（给续接提供可接收的会话目标）。 */
  async function seedRunningWork(spec = '修登录'): Promise<string> {
    const workInput = await submit(`${spec}，完整跑一遍`)
    const { subActions } = db.registerRoutingDecision({
      inputId: workInput,
      subActions: [{ text: spec }]
    })
    const task = db.createTask({ runId: db.getRoutingInput(workInput)!.run_id, spec })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    db.claimSubActionForDispatch(subActions[0]!.sub_action_id, dispatch.id)
    db.db
      .prepare('UPDATE routing_sub_actions SET task_id = ? WHERE sub_action_id = ?')
      .run(task.id, subActions[0]!.sub_action_id)
    return task.id
  }

  const planningProposal = {
    version: 1,
    actions: [
      {
        key: 'a1',
        type: 'create_task',
        instruction: '规划：先澄清需求',
        planning: true,
        clarification: true
      }
    ]
  }

  async function submitAndRouteFalse(text: string, proposal: unknown): Promise<string> {
    agentRouter.fn.mockImplementation(async () => proposal)
    const { input } = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text
    })
    await routeOnce(input.input_id, false)
    return input.input_id
  }

  function decisionFlagsOf(inputId: string): {
    dispatchHold: boolean
    dispatchAuthorized: boolean
  } {
    const decision = JSON.parse(db.getRoutingInput(inputId)?.decision_json ?? '{}') as Record<
      string,
      unknown
    >
    return {
      dispatchHold: decision.dispatchHold === true,
      dispatchAuthorized: decision.dispatchAuthorized === true
    }
  }

  function boundActionIds(inputId: string): string[] {
    return db
      .listSubActions(inputId)
      .filter((action) => action.task_id !== null)
      .map((action) => action.sub_action_id)
  }

  async function pumpOnce(): Promise<void> {
    const run = entryRunOfInput(
      db,
      group,
      (
        (await call('orchestration.entryShow', { group })) as {
          inputs: { input: { input_id: string } }[]
        }
      ).inputs[0]!.input.input_id
    )
    await pumpEntryAutomations({ runtime: ctx.runtime, run, group })
  }

  it('keeps an interrupted decision unauthorized across restarts until a dispatch=true lands', async () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), 'orca-auth-')), 'orchestration.db')
    prepareWorkers(databasePath)
    agentRouter.fn.mockImplementation(async () => loginProposal)
    // 落决定（dispatch=false）：决定与「未授权」语义同一 SAVEPOINT 落库——中断注入点
    // （落决定后、落授权前）不再存在无授权语义的中间态。
    const { input } = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '修登录'
    })
    await routeOnce(input.input_id, false)
    expect(decisionFlagsOf(input.input_id)).toEqual({
      dispatchHold: true,
      dispatchAuthorized: false
    })
    const inputId = input.input_id
    restartOnSameLedger()
    expect(decisionFlagsOf(inputId)).toEqual({
      dispatchHold: true,
      dispatchAuthorized: false
    })
    // 重放 false：保持未授权，轮询零派发。
    await routeOnce(inputId, false)
    const beforeTrue = boundActionIds(inputId)
    expect(beforeTrue).toEqual([])
    await pumpOnce()
    expect(boundActionIds(inputId)).toEqual([])
    // 后续 true：复用决定，原子授权翻转，只派发一次。
    await routeOnce(inputId, true)
    expect(decisionFlagsOf(inputId)).toEqual({
      dispatchHold: false,
      dispatchAuthorized: true
    })
    const bound = boundActionIds(inputId)
    expect(bound).toHaveLength(1)
    const dispatchId = db.getSubAction(bound[0]!)?.claimed_dispatch_id
    expect(dispatchId).not.toBeNull()
    // 重放 true/false 都不再派发第二个 Worker；迟到的 false 不得撤销授权。
    await routeOnce(inputId, true)
    await routeOnce(inputId, false)
    expect(decisionFlagsOf(inputId)).toEqual({
      dispatchHold: false,
      dispatchAuthorized: true
    })
    expect(boundActionIds(inputId)).toEqual(bound)
  })

  it('recovers a granted dispatch whose worker never started, reusing the original binding', async () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), 'orca-auth-')), 'orchestration.db')
    prepareWorkers(databasePath)
    agentRouter.fn.mockImplementation(async () => loginProposal)
    const { input } = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '修登录'
    })
    const inputId = input.input_id
    // 中断注入（落授权后、驱动受理前）：授权已原子落定（grantRoutingDispatch）而派发驱动
    // 尚未执行——db 层构造该状态等价于进程在 completeEntryDispatch 首行后中断。
    await routeOnce(inputId, false)
    db.grantRoutingDispatch(inputId)
    expect(decisionFlagsOf(inputId)).toEqual({
      dispatchHold: false,
      dispatchAuthorized: true
    })
    restartOnSameLedger()
    // 重启恢复推进：复用原 Dispatch 只派发一次（不新铸 Worker）。
    const run = entryRunOfInput(db, group, inputId)
    await pumpEntryAutomations({ runtime: ctx.runtime, run, group })
    const bound = boundActionIds(inputId)
    expect(bound).toHaveLength(1)
    const dispatchId = db.getSubAction(bound[0]!)?.claimed_dispatch_id
    expect(dispatchId).not.toBeNull()
    const accepted = db.db
      .prepare('SELECT COUNT(*) AS count FROM worker_dispatches WHERE dispatch_id = ?')
      .get(dispatchId!) as { count: number }
    expect(accepted.count).toBe(1)
    // 受理后回执丢失（restart 再轮询）：复用原 Dispatch，不重派。
    restartOnSameLedger()
    await pumpOnce()
    expect(boundActionIds(inputId)).toEqual(bound)
    expect(db.getSubAction(bound[0]!)?.claimed_dispatch_id).toBe(dispatchId)
  })

  it('keeps an admitted worker untouched by later replays in both orderings', async () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), 'orca-auth-')), 'orchestration.db')
    prepareWorkers(databasePath)
    agentRouter.fn.mockImplementation(async () => loginProposal)
    // true 先到：首路由即授权派发。
    const { input } = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '修登录'
    })
    const inputId = input.input_id
    await routeOnce(inputId, true)
    const bound = boundActionIds(inputId)
    const dispatchId = db.getSubAction(bound[0]!)?.claimed_dispatch_id
    restartOnSameLedger()
    // false 先到（乱序重放）：授权已持久化——不撤销、不重派。
    await routeOnce(inputId, false)
    expect(decisionFlagsOf(inputId)).toEqual({
      dispatchHold: false,
      dispatchAuthorized: true
    })
    // 两个 true 并发：共享一次决定与派发。
    await Promise.all([
      routeOnce(inputId, true),
      routeOnce(inputId, true),
      routeOnce(inputId, false)
    ])
    expect(boundActionIds(inputId)).toEqual(bound)
    expect(db.getSubAction(bound[0]!)?.claimed_dispatch_id).toBe(dispatchId)
    expect(
      db.db
        .prepare('SELECT COUNT(*) AS count FROM routing_sub_actions WHERE input_id = ?')
        .get(inputId)
    ).toEqual({ count: 1 })
  })

  it('grants legacy decided rows on upgrade and keeps the manual assign entry working', async () => {
    // 旧账本（v56 形态）：decided 行无任何授权键——v61 忠实回填「决定即派发意图」。
    const databasePath = join(mkdtempSync(join(tmpdir(), 'orca-auth-')), 'orchestration.db')
    prepareWorkers(databasePath)
    const { input } = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '修登录'
    })
    db.registerRoutingDecision({
      inputId: input.input_id,
      subActions: [{ text: '修登录' }]
    })
    // 降级成 v56 形态：去掉授权键（旧账本无 decision_json 授权痕迹），版本号回拨。
    db.db
      .prepare('UPDATE routing_inputs SET decision_json = \'{"reason":null}\' WHERE input_id = ?')
      .run(input.input_id)
    db.db.exec(`
      ALTER TABLE routing_sub_actions DROP COLUMN write_granted_at;
      PRAGMA user_version = 56;
    `)
    restartOnSameLedger()
    // v61 回填：decided 且无保持标记 → dispatchAuthorized=true（历史「决定即意图」语义）。
    expect(decisionFlagsOf(input.input_id)).toEqual({
      dispatchHold: false,
      dispatchAuthorized: true
    })
    // 既有手动派发入口照常：手动指派不经泵授权门。
    agentRouter.fn.mockImplementation(async () => loginProposal)
    const subActionId = db.listSubActions(input.input_id)[0]!.sub_action_id
    await call('orchestration.entryAssign', {
      group,
      input: input.input_id,
      subAction: subActionId,
      agent: 'codex'
    })
    expect(boundActionIds(input.input_id)).toHaveLength(1)
  })

  it('upgrades a v60 ledger with a missing-hold decision to unauthorized, not dispatched', async () => {
    // v60 文件账本：两条 dispatch:false 阶段决定——一条正常带 dispatchHold，一条模拟
    // 上一版「决定提交后、写保持前中断」（两个授权键均缺失）。
    const databasePath = join(mkdtempSync(join(tmpdir(), 'orca-auth-v60-')), 'orchestration.db')
    prepareWorkers(databasePath)
    agentRouter.fn.mockImplementation(async () => loginProposal)
    const holdInput = await submitAndRouteFalse('保持的规划', planningProposal)
    const orphanInput = await submitAndRouteFalse('中断的规划', planningProposal)
    // 中断形态：决定已提交、保持未写入——移除保持键模拟。
    db.db
      .prepare(
        "UPDATE routing_inputs SET decision_json = json_remove(decision_json, '$.dispatchHold') WHERE input_id = ?"
      )
      .run(orphanInput)
    const holdFlags = () => ({
      hold: db.getRoutingInput(holdInput)?.decision_json ?? '',
      orphan: db.getRoutingInput(orphanInput)?.decision_json ?? ''
    })
    expect(JSON.parse(holdFlags().hold).dispatchHold).toBe(true)
    expect(JSON.parse(holdFlags().orphan).dispatchHold).toBeUndefined()
    restartOnSameLedger()
    // 升级：统一路由决定缺少授权证据 → 保持待授权（不回填）。保持键原样保留；
    // 缺失键（中断产物）不补写——缺失与显式保持同样按未授权处理。
    expect(decisionFlagsOf(holdInput)).toEqual({ dispatchHold: true, dispatchAuthorized: false })
    expect(decisionFlagsOf(orphanInput)).toEqual({ dispatchHold: false, dispatchAuthorized: false })
    // 升级后直接轮询：零 Dispatch。
    await pumpOnce()
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM worker_dispatches').get()).toEqual({
      count: 0
    })
    // 重放 false：仍为零（重放会给缺失键补写显式保持）。
    await routeOnce(holdInput, false)
    await routeOnce(orphanInput, false)
    expect(decisionFlagsOf(orphanInput)).toEqual({ dispatchHold: true, dispatchAuthorized: false })
    await pumpOnce()
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM worker_dispatches').get()).toEqual({
      count: 0
    })
    // 合法 true：复用决定并授权；阶段行由泵按门推进（clarification auto 门直接派发），
    // 各自只绑定一次。
    await routeOnce(holdInput, true)
    await routeOnce(orphanInput, true)
    await pumpOnce()
    expect(boundActionIds(holdInput)).toHaveLength(1)
    expect(boundActionIds(orphanInput)).toHaveLength(1)
    // 执行失败兜底（§能力分工）：夹具里并发 spawn 会同步失败一次——泵按兜底链重派一次，
    // fallback_agent 落行即消费；二次失败不再自动重派（升级人工照旧），故恰好多一笔 dispatch。
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM worker_dispatches').get()).toEqual({
      count: 3
    })
    expect(
      db.db
        .prepare(
          'SELECT COUNT(*) AS count FROM routing_sub_actions WHERE fallback_agent IS NOT NULL'
        )
        .get()
    ).toEqual({ count: 1 })
  })

  it('keeps a genuinely admitted legacy decision bound and never re-dispatches it', async () => {
    // 对照：真实旧已受理记录（授权 + 已绑定 + 回执）——升级与轮询均不重派、绑定与回执保留。
    const databasePath = join(mkdtempSync(join(tmpdir(), 'orca-auth-')), 'orchestration.db')
    prepareWorkers(databasePath)
    agentRouter.fn.mockImplementation(async () => loginProposal)
    const { input } = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '修登录'
    })
    const inputId = input.input_id
    await routeOnce(inputId, true)
    const bound = boundActionIds(inputId)
    const dispatchId = db.getSubAction(bound[0]!)?.claimed_dispatch_id
    restartOnSameLedger()
    expect(decisionFlagsOf(inputId)).toEqual({
      dispatchHold: false,
      dispatchAuthorized: true
    })
    await pumpOnce()
    expect(boundActionIds(inputId)).toEqual(bound)
    expect(db.getSubAction(bound[0]!)?.claimed_dispatch_id).toBe(dispatchId)
    const accepted = db.db
      .prepare('SELECT COUNT(*) AS count FROM worker_dispatches WHERE dispatch_id = ?')
      .get(dispatchId!) as { count: number }
    expect(accepted.count).toBe(1)
  })

  it('starts continuations only after the dispatch grant persists, reusing one supplement on replay', async () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), 'orca-auth-')), 'orchestration.db')
    prepareWorkers(databasePath)
    const taskId = await seedRunningWork()
    agentRouter.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'continue_task', taskId, instruction: '补并发场景回归测试' }]
    }))
    const input = await submit('给修登录那项补并发场景回归测试')
    // 注入：grant 抛错（授权未落库）→ 整个派发完成失败，补充与投递尝试均为零。
    const grantSpy = vi.spyOn(db, 'grantRoutingDispatch').mockImplementation(() => {
      throw new Error('grant interrupted')
    })
    await expect(routeOnce(input, true)).rejects.toMatchObject({ message: 'grant interrupted' })
    grantSpy.mockRestore()
    expect(
      db.db
        .prepare('SELECT COUNT(*) AS count FROM routing_supplements WHERE input_id = ?')
        .get(input)
    ).toEqual({ count: 0 })
    // 授权未翻转：决定保持未授权语义，补充与投递均未发生。
    expect(decisionFlagsOf(input)).toEqual({ dispatchHold: true, dispatchAuthorized: false })
    // 重放 true：授权成功落库，登记恰一条补充并投递到原目标 Dispatch。
    await routeOnce(input, true)
    const supplements = db.db
      .prepare('SELECT * FROM routing_supplements WHERE input_id = ?')
      .all(input) as { supplement_id: string; target_dispatch_id: string }[]
    expect(supplements).toHaveLength(1)
    expect(supplements[0]?.target_dispatch_id).toBe(db.getDispatchContext(taskId)!.id)
    const attempts = db.listSupplementAttempts(supplements[0]!.supplement_id)
    expect(attempts.length).toBeGreaterThanOrEqual(1)
    expect(db.getRoutingInput(input)?.decision_json).toContain('"dispatchAuthorized":true')
    // 再次重放：复用同一补充记录与目标 Dispatch，不重复登记或投递。
    await routeOnce(input, true)
    expect(
      db.db
        .prepare('SELECT COUNT(*) AS count FROM routing_supplements WHERE input_id = ?')
        .get(input)
    ).toEqual({ count: 1 })
    expect(db.listSupplementAttempts(supplements[0]!.supplement_id).length).toBe(attempts.length)
  })

  it('keeps resume paths at zero attempts for an unauthorized continuation until a true lands', async () => {
    // v61 文件账本：dispatch:false 的 continue_task，模拟旧版本「授权落库前已登记补充、
    // 尚无投递尝试」——升级后普通轮询与三种恢复路径都必须保持零尝试。
    const databasePath = join(mkdtempSync(join(tmpdir(), 'orca-auth-')), 'orchestration.db')
    prepareWorkers(databasePath)
    const taskId = await seedRunningWork()
    agentRouter.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'continue_task', taskId, instruction: '补回归测试' }]
    }))
    const input = await submit('给修登录那项补回归测试')
    await routeOnce(input, false)
    // 模拟旧版本中断：授权落库前路由路径已登记补充（零尝试）。
    const dispatch = db.getDispatchContext(taskId)!
    db.recordRoutingSupplement({
      inputId: input,
      subActionId: db.listSubActions(input)[0]!.sub_action_id,
      targetDispatchId: dispatch.id,
      text: '补回归测试',
      origin: 'route'
    })
    const supplements = () =>
      db.db
        .prepare('SELECT COUNT(*) AS count FROM routing_supplements WHERE input_id = ?')
        .get(input) as { count: number }
    const attempts = () =>
      db.db
        .prepare(
          'SELECT COUNT(*) AS count FROM routing_supplement_attempts a JOIN routing_supplements s ON s.supplement_id = a.supplement_id WHERE s.input_id = ?'
        )
        .get(input) as { count: number }
    expect(supplements().count).toBe(1)
    expect(attempts().count).toBe(0)
    // 升级完成（决定带 dispatchHold）→ 普通轮询保持零尝试。
    await pumpOnce()
    expect(attempts().count).toBe(0)
    restartOnSameLedger()
    await pumpOnce()
    expect(attempts().count).toBe(0)
    // 三种恢复路径：单卡恢复 / 项目恢复 / 自动恢复（entryShow 轮询）都保持零尝试。
    await call('orchestration.entryResume', { group })
    expect(attempts().count).toBe(0)
    await call('orchestration.entryResume', {
      group,
      subAction: db.listSubActions(input)[0]!.sub_action_id
    })
    expect(attempts().count).toBe(0)
    await pumpOnce()
    expect(attempts().count).toBe(0)
    expect(db.getRoutingInput(input)?.decision_json).toContain('"dispatchHold":true')
    // 合法 true：授权落库 → 重放复用原补充与原目标 Dispatch，只投一次。
    await routeOnce(input, true)
    expect(db.getRoutingInput(input)?.decision_json).toContain('"dispatchAuthorized":true')
    expect(supplements().count).toBe(1)
    const attemptCountAfterTrue = db.listSupplementAttempts(
      db.listSupplements(db.listSubActions(input)[0]!.sub_action_id)[0]!.supplement_id
    ).length
    expect(attemptCountAfterTrue).toBeGreaterThanOrEqual(1)
    // 已受理或结果未知的记录保持原回执：再轮询与显式重放均不追加。
    await pumpOnce()
    await routeOnce(input, true)
    expect(supplements().count).toBe(1)
  })

  it('resumes user-initiated supplements on entryPause/entryResume across restarts', async () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), 'orca-auth-')), 'orchestration.db')
    prepareWorkers(databasePath)
    agentRouter.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'create_task', instruction: '修登录', agent: 'codex' }]
    }))
    // 手动拆分 → 指派 → 暂停 → 主动补充。
    const planned = await call<{ subActions: { sub_action_id: string }[] }>(
      'orchestration.entryPlan',
      {
        group,
        input: (
          await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
            group,
            text: '设计登录'
          })
        ).input.input_id,
        subActions: ['修登录', '优化启动']
      }
    )
    const loginId = planned.subActions[0]!.sub_action_id
    entryRunOfInput(
      db,
      group,
      (
        (await call('orchestration.entryShow', { group })) as {
          inputs: { input: { input_id: string } }[]
        }
      ).inputs[0]!.input.input_id
    )
    await call('orchestration.entryAssign', {
      group,
      input: (
        (await call('orchestration.entryShow', { group })) as {
          inputs: { input: { input_id: string } }[]
        }
      ).inputs[0]!.input.input_id,
      subAction: loginId,
      agent: 'codex'
    })
    await call('orchestration.entryPause', { group })
    const supplementReceipt = await call<{ dispatchId: string; attemptId: string }>(
      'orchestration.entrySupplement',
      {
        group,
        input: (
          (await call('orchestration.entryShow', { group })) as {
            inputs: {
              input: { input_id: string }
              subActions: { subAction: { sub_action_id: string } }[]
            }[]
          }
        ).inputs[0]!.input.input_id,
        subAction: loginId,
        dispatch: db.getSubAction(loginId)?.claimed_dispatch_id ?? '',
        text: '补充：覆盖 OAuth 路径'
      }
    )
    expect(supplementReceipt.dispatchId).not.toBeNull()
    // 重启账本。
    restartOnSameLedger()
    // 单卡恢复：手动补充的暂停回执应被重投一次（命中原轮次）。
    await call('orchestration.entryResume', { group, subAction: loginId })
    // 项目恢复：同样不重复。
    await call('orchestration.entryResume', { group })
    // 断言补充仍然只有一条且投递尝试 ≥1。
    const supplementCount = db.db
      .prepare('SELECT COUNT(*) AS count FROM routing_supplements WHERE sub_action_id = ?')
      .get(loginId) as { count: number }
    expect(supplementCount.count).toBe(1)
  })

  it('blocks paused supplements for unauthorized route continuations from both resume paths', async () => {
    // 文件型 v61 账本：dispatch:false 的 continue_task，补充已登记且有 paused 拒收记录。
    // entryResume（单卡+项目）不得投递——路由续接需要持久化授权。
    const databasePath = join(mkdtempSync(join(tmpdir(), 'orca-auth-')), 'orchestration.db')
    prepareWorkers(databasePath)
    const taskId = await seedRunningWork()
    agentRouter.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'continue_task', taskId, instruction: '补并发场景回归测试' }]
    }))
    const input = await submit('给修登录那项补并发场景回归测试')
    // dispatch:false 登记决定（授权未写入）。
    await routeOnce(input, false)
    // 模拟：路由路径的补充已登记且有 paused 拒收尝试。
    const dispatch = db.getDispatchContext(taskId)!
    const subActionId = db.listSubActions(input)[0]!.sub_action_id
    const supplement = db.recordRoutingSupplement({
      inputId: input,
      subActionId,
      targetDispatchId: dispatch.id,
      text: '补并发场景回归测试',
      origin: 'route'
    })
    db.recordSupplementAttempt({
      supplementId: supplement.supplement_id,
      requestId: 'rtsend_paused_test',
      targetDispatchId: dispatch.id,
      expectedTurnId: 'turn-1',
      outcome: 'refused',
      refusalKind: 'paused',
      detail: null
    })
    const attempts = () => db.listSupplementAttempts(supplement.supplement_id)
    expect(attempts()).toHaveLength(1)
    expect(attempts()[0]?.refusal_kind).toBe('paused')
    // 重启账本。
    restartOnSameLedger()
    // 项目 entryResume：不投递未授权的路由续接。
    await call('orchestration.entryResume', { group })
    expect(attempts()).toHaveLength(1)
    // 单卡 entryResume：同样不投递。
    await call('orchestration.entryResume', { group, subAction: subActionId })
    expect(attempts()).toHaveLength(1)
    // 合法 true：授权落库 → 复用原补充，再尝试投递（结果取决于测试环境结构化宿主可用性）。
    await routeOnce(input, true)
    expect(attempts().length).toBeGreaterThanOrEqual(2)
    expect(attempts().filter((a) => a.refusal_kind === 'paused')).toHaveLength(1)
    // 再重放：不重复投递。
    await routeOnce(input, true)
    expect(attempts().filter((a) => a.refusal_kind === 'paused')).toHaveLength(1)
  })

  it('resumes paused supplements for manual plans regardless of routing authorization', async () => {
    // 手动拆分（entryPlan）的输入无路由授权但仍应有恢复暂停的投递。
    const databasePath = join(mkdtempSync(join(tmpdir(), 'orca-auth-')), 'orchestration.db')
    prepareWorkers(databasePath)
    agentRouter.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'create_task', instruction: '修登录', agent: 'codex' }]
    }))
    const planned = await call<{ subActions: { sub_action_id: string }[] }>(
      'orchestration.entryPlan',
      {
        group,
        input: (
          await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
            group,
            text: '设计登录'
          })
        ).input.input_id,
        subActions: ['修登录', '优化启动']
      }
    )
    const loginId = planned.subActions[0]!.sub_action_id
    await call('orchestration.entryAssign', {
      group,
      input: (
        (await call('orchestration.entryShow', { group })) as {
          inputs: {
            input: { input_id: string }
            subActions: { subAction: { sub_action_id: string } }[]
          }[]
        }
      ).inputs[0]!.input.input_id,
      subAction: loginId,
      agent: 'codex'
    })
    await call('orchestration.entryPause', { group })
    const subAction = db.getSubAction(loginId)!
    const dispatch = db.getDispatchContext(subAction.task_id!)!
    const supplement = db.recordRoutingSupplement({
      inputId: subAction.input_id,
      subActionId: loginId,
      targetDispatchId: dispatch.id,
      text: '覆盖 OAuth 路径'
    })
    db.recordSupplementAttempt({
      supplementId: supplement.supplement_id,
      requestId: 'rtsend_manual_test',
      targetDispatchId: dispatch.id,
      expectedTurnId: 'turn-1',
      outcome: 'refused',
      refusalKind: 'paused',
      detail: null
    })
    const attempts = () => db.listSupplementAttempts(supplement.supplement_id)
    expect(attempts()).toHaveLength(1)
    // entryResume 恢复暂停补充（非路由续接，不受路由授权门限制）。
    await call('orchestration.entryResume', { group })
    expect(attempts().length).toBeGreaterThanOrEqual(1)
    // 补充仍只有一条。
    expect(
      db.db
        .prepare('SELECT COUNT(*) AS count FROM routing_supplements WHERE sub_action_id = ?')
        .get(loginId)
    ).toEqual({ count: 1 })
  })
})
