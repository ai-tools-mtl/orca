import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../core'
import { createOrchestrationRpcHarness } from './rpc-test-harness'
import type { SupplementReceipt } from './routing-supplements'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import { createRootDispatch } from '../../../orchestration/db/root-dispatch-test-fixture'
import {
  partialRuntimeStore,
  storeRepo
} from '../../../orca-runtime-tests/runtime-store-partial-fixture'
import type * as structuredSessionMailTargetModule from '../../../orchestration/mailbox/routing/structured-session-mail-target'
import type * as structuredAgentSessionExpectedSteerModule from '../../../../native-chat/agent-session-wire/providers/structured-agent-session-expected-steer'
import type * as structuredAgentSessionRegistryModule from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'

// 暂停补充恢复的授权四格（§派发授权/重放与恢复）：手动补充的恢复不问路由授权（暂停/恢复
// 由用户管理），路由生成的续接（taskReferences 绑定行）必须先拿到持久化授权。单卡
// entryResume 与项目 entryResume 同规则；再次重启与重放均不追加投递。会话投递经假宿主
// 记账（steerExpectedTurnViaAdapter mock），持久化回执直接断言账本行。

const agentRouter = vi.hoisted(() => ({ fn: vi.fn<() => Promise<unknown>>() }))

vi.mock('../../../orchestration/routing/agent-route-proposal-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof agentRouteProposalProviderModule>()),
  createAgentRouteProposalProvider: () => agentRouter.fn
}))

import type { createAgentRouteProposalProvider as agentRouteProposalProviderModule } from '../../../orchestration/routing/agent-route-proposal-provider'

const steerCalls = vi.hoisted(() => ({
  list: [] as {
    sessionId: string
    requestId: string
    expectedTurnId: string
    text: string
  }[]
}))

const custodySessions = vi.hoisted(() => ({ byDispatch: new Map<string, string>() }))

const fakeHost = vi.hoisted(() => ({
  deps: { adapter: {} },
  currentWorkAtRest: async () => ({ activeTurnId: () => 'turn-live' })
}))

vi.mock(
  '../../../orchestration/mailbox/routing/structured-session-mail-target',
  async (importOriginal) => {
    const actual = await importOriginal<typeof structuredSessionMailTargetModule>()
    return {
      ...actual,
      // 只有测试点名的补充目标 Dispatch 解析为可达会话；其余问询走真实实现。
      structuredMailboxCustody: (
        mailboxHandle: string,
        db: Parameters<typeof actual.structuredMailboxCustody>[1]
      ) => {
        if (mailboxHandle.startsWith('dispatch:')) {
          const sessionId = custodySessions.byDispatch.get(mailboxHandle.slice('dispatch:'.length))
          if (sessionId) {
            return { sessionId, dispatchId: mailboxHandle.slice('dispatch:'.length) }
          }
        }
        return actual.structuredMailboxCustody(mailboxHandle, db)
      }
    }
  }
)

vi.mock(
  '../../../../native-chat/agent-session-wire/providers/structured-agent-session-expected-steer',
  async (importOriginal) => ({
    ...(await importOriginal<typeof structuredAgentSessionExpectedSteerModule>()),
    steerExpectedTurnViaAdapter: async (
      _adapter: unknown,
      input: {
        sessionId: string
        clientMessageId: string
        body: { blocks: { text: string }[] }
        expectedTurnId: string
      }
    ) => {
      steerCalls.list.push({
        sessionId: input.sessionId,
        requestId: input.clientMessageId,
        expectedTurnId: input.expectedTurnId,
        text: input.body.blocks[0]!.text
      })
      return { status: 'delivered', turnId: `${input.expectedTurnId}-next`, via: 'steer' }
    }
  })
)

vi.mock(
  '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  async (importOriginal) => ({
    ...(await importOriginal<typeof structuredAgentSessionRegistryModule>()),
    getStructuredAgentSessionHost: () => fakeHost
  })
)

describe('paused supplement resume authorization', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext
  let currentDatabasePath = ':memory:'

  const group = 'proj_resume'

  afterEach(() => {
    h.cleanup()
    agentRouter.fn.mockReset()
    custodySessions.byDispatch.clear()
    steerCalls.list.length = 0
    vi.restoreAllMocks()
  })

  async function call<T>(name: string, params: Record<string, unknown>): Promise<T> {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the asserted shape is the called method's documented receipt.
    return (await h.call(name, params, ctx)) as T
  }

  function prepareWorkers(databasePath: string): void {
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
        worktree: { id: 'wt_resume' },
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

  function fileLedger(prefix: string): string {
    return join(mkdtempSync(join(tmpdir(), prefix)), 'orchestration.db')
  }

  async function submit(text: string): Promise<string> {
    const { input } = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text
    })
    return input.input_id
  }

  function routeOnce(inputId: string, dispatch: boolean): Promise<unknown> {
    return call('orchestration.entryAutoRoute', {
      group,
      input: inputId,
      dispatch,
      decisionModel: { source: 'agent', agent: 'codex' }
    })
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

  /** 手动拆分（entryPlan）→ 逐卡指派：手动补充场景的既定目标（claimed Dispatch）。 */
  async function seedManualPlan(): Promise<{ inputId: string; loginId: string }> {
    const inputId = await submit('设计登录')
    const planned = await call<{ subActions: { sub_action_id: string }[] }>(
      'orchestration.entryPlan',
      { group, input: inputId, subActions: ['修登录', '优化启动'] }
    )
    const loginId = planned.subActions[0]!.sub_action_id
    await call('orchestration.entryAssign', {
      group,
      input: inputId,
      subAction: loginId,
      agent: 'codex'
    })
    return { inputId, loginId }
  }

  /** 暂停（单卡或项目）期间发出补充，断言账本留下 paused 拒收回执且保留原轮次。 */
  async function supplementWhilePaused(
    inputId: string,
    loginId: string,
    pause: 'card' | 'project'
  ): Promise<{ dispatchId: string; supplementId: string; receipt: SupplementReceipt }> {
    await call(
      'orchestration.entryPause',
      pause === 'card' ? { group, subAction: loginId } : { group }
    )
    const dispatchId = db.getSubAction(loginId)?.claimed_dispatch_id ?? ''
    expect(dispatchId).not.toBe('')
    custodySessions.byDispatch.set(dispatchId, 'sess_entry')
    const receipt = await call<SupplementReceipt>('orchestration.entrySupplement', {
      group,
      input: inputId,
      subAction: loginId,
      dispatch: dispatchId,
      text: '补充：覆盖 OAuth 路径',
      expectedTurn: 'turn-1'
    })
    expect(receipt.outcome).toBe('refused')
    expect(receipt.refusalKind).toBe('paused')
    expect(receipt.expectedTurnId).toBe('turn-1')
    return { dispatchId, supplementId: receipt.supplementId, receipt }
  }

  function expectRedeliveredOnce(
    loginId: string,
    supplementId: string,
    dispatchId: string,
    originalRequestId: string
  ): void {
    expect(steerCalls.list).toHaveLength(1)
    expect(steerCalls.list[0]).toEqual({
      sessionId: 'sess_entry',
      requestId: originalRequestId,
      expectedTurnId: 'turn-1',
      text: '补充：覆盖 OAuth 路径'
    })
    expect(db.listSupplements(loginId)).toHaveLength(1)
    expect(db.listSupplements(loginId)[0]!.target_dispatch_id).toBe(dispatchId)
    const attempts = db.listSupplementAttempts(supplementId)
    expect(attempts.map((attempt) => attempt.outcome)).toEqual(['refused', 'delivered'])
    expect(attempts[0]!.refusal_kind).toBe('paused')
    expect(attempts[1]!.target_dispatch_id).toBe(dispatchId)
    expect(attempts[1]!.request_id).toBe(originalRequestId)
    expect(attempts[1]!.expected_turn_id).toBe('turn-1')
  }

  it('delivers a paused manual supplement once per card resume on the original turn', async () => {
    prepareWorkers(fileLedger('orca-resume-card-'))
    const { inputId, loginId } = await seedManualPlan()
    const { dispatchId, supplementId, receipt } = await supplementWhilePaused(
      inputId,
      loginId,
      'card'
    )
    // 重启同一文件账本，只调用单卡恢复：手动补充不问路由授权，恰一次会话投递。
    restartOnSameLedger()
    await call('orchestration.entryResume', { group, subAction: loginId })
    expectRedeliveredOnce(loginId, supplementId, dispatchId, receipt.requestId)
    // 再次重启并重放单卡恢复：不追加投递。
    restartOnSameLedger()
    await call('orchestration.entryResume', { group, subAction: loginId })
    expect(steerCalls.list).toHaveLength(1)
    expect(db.listSupplementAttempts(supplementId)).toHaveLength(2)
  })

  it('delivers a paused manual supplement once per project resume on the original turn', async () => {
    prepareWorkers(fileLedger('orca-resume-proj-'))
    const { inputId, loginId } = await seedManualPlan()
    const { dispatchId, supplementId, receipt } = await supplementWhilePaused(
      inputId,
      loginId,
      'project'
    )
    // 重启同一文件账本，只调用项目恢复：手动补充恰一次会话投递。
    restartOnSameLedger()
    await call('orchestration.entryResume', { group })
    expectRedeliveredOnce(loginId, supplementId, dispatchId, receipt.requestId)
    // 再次重启并重放项目恢复：不追加投递。
    restartOnSameLedger()
    await call('orchestration.entryResume', { group })
    expect(steerCalls.list).toHaveLength(1)
    expect(db.listSupplementAttempts(supplementId)).toHaveLength(2)
  })

  /** v61 中断产物：dispatch:false 的路由续接，授权落库前已登记补充且有 paused 拒收回执。 */
  async function seedPausedRouteContinuation(prefix: string): Promise<{
    input: string
    taskId: string
    subActionId: string
    dispatchId: string
    supplementId: string
  }> {
    prepareWorkers(fileLedger(prefix))
    const taskId = await seedRunningWork()
    agentRouter.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'continue_task', taskId, instruction: '补并发场景回归测试' }]
    }))
    const input = await submit('给修登录那项补并发场景回归测试')
    await routeOnce(input, false)
    const dispatchId = db.getDispatchContext(taskId)!.id
    const subActionId = db.listSubActions(input)[0]!.sub_action_id
    const supplement = db.recordRoutingSupplement({
      inputId: input,
      subActionId,
      targetDispatchId: dispatchId,
      text: '补并发场景回归测试',
      origin: 'route'
    })
    db.recordSupplementAttempt({
      supplementId: supplement.supplement_id,
      requestId: 'rtsend_v61',
      targetDispatchId: dispatchId,
      expectedTurnId: 'turn-1',
      outcome: 'refused',
      refusalKind: 'paused',
      detail: null
    })
    custodySessions.byDispatch.set(dispatchId, 'sess_worker')
    restartOnSameLedger()
    return { input, taskId, subActionId, dispatchId, supplementId: supplement.supplement_id }
  }

  it('holds a paused route continuation at zero until the grant lands, then card resume stays at one', async () => {
    const seeded = await seedPausedRouteContinuation('orca-resume-cont-card-')
    // 合法 true 之前：单卡恢复零会话投递（路由续接需要持久化授权）。
    await call('orchestration.entryResume', { group, subAction: seeded.subActionId })
    expect(steerCalls.list).toHaveLength(0)
    expect(db.listSupplementAttempts(seeded.supplementId)).toHaveLength(1)
    // 合法 true：授权落库 → 复用原补充、原 Dispatch 与原轮次，恰一次会话投递。
    await routeOnce(seeded.input, true)
    expect(steerCalls.list).toHaveLength(1)
    expect(steerCalls.list[0]).toEqual({
      sessionId: 'sess_worker',
      requestId: 'rtsend_v61',
      expectedTurnId: 'turn-1',
      text: '补并发场景回归测试'
    })
    const attempts = db.listSupplementAttempts(seeded.supplementId)
    expect(attempts.map((attempt) => attempt.outcome)).toEqual(['refused', 'delivered'])
    expect(attempts[1]!.target_dispatch_id).toBe(seeded.dispatchId)
    expect(attempts[1]!.request_id).toBe('rtsend_v61')
    // 再次重启：单卡恢复与 dispatch=true 重放均不追加投递。
    restartOnSameLedger()
    await call('orchestration.entryResume', { group, subAction: seeded.subActionId })
    await routeOnce(seeded.input, true)
    expect(steerCalls.list).toHaveLength(1)
    expect(db.listSupplementAttempts(seeded.supplementId)).toHaveLength(2)
  })

  it('holds a paused route continuation at zero until the grant lands, then project resume stays at one', async () => {
    const seeded = await seedPausedRouteContinuation('orca-resume-cont-proj-')
    // 合法 true 之前：项目恢复零会话投递。
    await call('orchestration.entryResume', { group })
    expect(steerCalls.list).toHaveLength(0)
    expect(db.listSupplementAttempts(seeded.supplementId)).toHaveLength(1)
    // 合法 true：授权落库 → 复用原补充、原 Dispatch 与原轮次，恰一次会话投递。
    await routeOnce(seeded.input, true)
    expect(steerCalls.list).toHaveLength(1)
    expect(steerCalls.list[0]).toEqual({
      sessionId: 'sess_worker',
      requestId: 'rtsend_v61',
      expectedTurnId: 'turn-1',
      text: '补并发场景回归测试'
    })
    // 再次重启：项目恢复与 dispatch=true 重放均不追加投递。
    restartOnSameLedger()
    await call('orchestration.entryResume', { group })
    await routeOnce(seeded.input, true)
    expect(steerCalls.list).toHaveLength(1)
    expect(db.listSupplementAttempts(seeded.supplementId)).toHaveLength(2)
  })
})
