import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../core'
import { createOrchestrationRpcHarness } from './rpc-test-harness'
import type { SupplementReceipt } from './routing-supplements'
import { pumpEntryAutomations } from './entry-automation-pump'
import { entryRunOfInput } from './entry-run-scope'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import { createRootDispatch } from '../../../orchestration/db/root-dispatch-test-fixture'
import {
  partialRuntimeStore,
  storeRepo
} from '../../../orca-runtime-tests/runtime-store-partial-fixture'
import type * as structuredSessionMailTargetModule from '../../../orchestration/mailbox/routing/structured-session-mail-target'
import type * as structuredAgentSessionExpectedSteerModule from '../../../../native-chat/agent-session-wire/providers/structured-agent-session-expected-steer'
import type * as structuredAgentSessionRegistryModule from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'

// 续接补充的独立身份（§按动作核对受理）：路由生成的续接与用户主动补充共用同一子动作时，
// 各自持有独立的补充记录与回执——显式派发（dispatch=true）和授权后的自动恢复按稳定动作
// ID 找「路由自己的补充」（origin='route'），用户补充不替代它，也不被它替代。

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

describe('route continuation supplement identity', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext
  let currentDatabasePath = ':memory:'

  const group = 'proj_identity'

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
        worktree: { id: 'wt_identity' },
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

  /** 既有工作：已派发并认领的任务（给续接和用户补充提供可接收的会话目标）。 */
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

  /** 复现路径：dispatch:false 的自动续接 + 同一子动作上的用户主动补充（已送达）。 */
  async function seedUserSupplementOnHeldContinuation(
    prefix: string
  ): Promise<{ input: string; taskId: string; subActionId: string; dispatchId: string }> {
    prepareWorkers(fileLedger(prefix))
    const taskId = await seedRunningWork()
    agentRouter.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'continue_task', taskId, instruction: '补跑回归' }]
    }))
    const input = await submit('给修登录那项补跑回归')
    await routeOnce(input, false)
    const subActionId = db.listSubActions(input)[0]!.sub_action_id
    const dispatchId = db.getDispatchContext(taskId)!.id
    custodySessions.byDispatch.set(dispatchId, 'sess_worker')
    const userReceipt = await call<SupplementReceipt>('orchestration.entrySupplement', {
      group,
      input,
      subAction: subActionId,
      dispatch: dispatchId,
      text: '用户手动补充'
    })
    expect(userReceipt.outcome).toBe('delivered')
    // 授权前只送达手动消息：账本此刻只有用户补充，自动续接零记录。
    expect(steerCalls.list.map((entry) => entry.text)).toEqual(['用户手动补充'])
    expect(db.listSupplements(subActionId).map((supplement) => supplement.origin)).toEqual(['user'])
    return { input, taskId, subActionId, dispatchId }
  }

  it('registers the auto continuation as its own supplement after the grant, beside the user supplement', async () => {
    const seeded = await seedUserSupplementOnHeldContinuation('cont-identity-')
    // 重启同一文件账本，再对自动续接调用合法 dispatch:true。
    restartOnSameLedger()
    await routeOnce(seeded.input, true)
    // 只新增一条自动续接记录和一次对应投递；手动补充的回执原样保留。
    const supplements = db.listSupplements(seeded.subActionId)
    expect(supplements.map((supplement) => supplement.origin)).toEqual(['user', 'route'])
    const routeSupplement = supplements[1]!
    expect(routeSupplement.raw_text).toBe('补跑回归')
    expect(routeSupplement.target_dispatch_id).toBe(seeded.dispatchId)
    expect(steerCalls.list.map((entry) => entry.text)).toEqual(['用户手动补充', '补跑回归'])
    expect(steerCalls.list[1]).toMatchObject({ sessionId: 'sess_worker' })
    expect(db.listSupplementAttempts(routeSupplement.supplement_id).map((a) => a.outcome)).toEqual([
      'delivered'
    ])
    expect(db.listSupplementAttempts(supplements[0]!.supplement_id)).toHaveLength(1)
    // 并发重放 + 再次重启 + 两种恢复入口：不再新增记录或投递。
    await Promise.all([routeOnce(seeded.input, true), routeOnce(seeded.input, true)])
    restartOnSameLedger()
    await routeOnce(seeded.input, true)
    await call('orchestration.entryResume', { group })
    await call('orchestration.entryResume', { group, subAction: seeded.subActionId })
    expect(db.listSupplements(seeded.subActionId)).toHaveLength(2)
    expect(steerCalls.list.map((entry) => entry.text)).toEqual(['用户手动补充', '补跑回归'])
    expect(db.listSupplementAttempts(routeSupplement.supplement_id)).toHaveLength(1)
  })

  it('recovers the route supplement on the pump path after a grant without prior delivery', async () => {
    const seeded = await seedUserSupplementOnHeldContinuation('cont-identity-pump-')
    // 注入：授权已原子落定而派发完成未执行（completeEntryDispatch 首行后中断）。
    db.grantRoutingDispatch(seeded.input)
    restartOnSameLedger()
    // 授权后的自动恢复（泵）按稳定动作 ID 登记专属补充并投递一次。
    const run = entryRunOfInput(db, group, seeded.input)
    await pumpEntryAutomations({ runtime: ctx.runtime, run, group })
    const supplements = db.listSupplements(seeded.subActionId)
    expect(supplements.map((supplement) => supplement.origin)).toEqual(['user', 'route'])
    expect(supplements[1]!.raw_text).toBe('补跑回归')
    expect(supplements[1]!.target_dispatch_id).toBe(seeded.dispatchId)
    expect(steerCalls.list.map((entry) => entry.text)).toEqual(['用户手动补充', '补跑回归'])
    // 重复轮询零增量。
    await pumpEntryAutomations({ runtime: ctx.runtime, run, group })
    expect(db.listSupplements(seeded.subActionId)).toHaveLength(2)
    expect(steerCalls.list).toHaveLength(2)
  })

  it('backfills route-origin supplements on upgrade and never redelivers settled receipts', async () => {
    prepareWorkers(fileLedger('cont-identity-v63-'))
    const taskId = await seedRunningWork()
    custodySessions.byDispatch.set(db.getDispatchContext(taskId)!.id, 'sess_worker')
    // 输入A：路由补充已送达；同一子动作上另有用户补充（不同文本）。
    agentRouter.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'continue_task', taskId, instruction: '补跑回归' }]
    }))
    const inputA = await submit('给修登录那项补跑回归')
    await routeOnce(inputA, false)
    const subActionA = db.listSubActions(inputA)[0]!.sub_action_id
    const dispatchId = db.getDispatchContext(taskId)!.id
    const routeA = db.recordRoutingSupplement({
      inputId: inputA,
      subActionId: subActionA,
      targetDispatchId: dispatchId,
      text: '补跑回归'
    })
    db.recordSupplementAttempt({
      supplementId: routeA.supplement_id,
      requestId: 'rtsend_old_route',
      targetDispatchId: dispatchId,
      expectedTurnId: 'turn-1',
      outcome: 'delivered',
      turnId: 'turn-2'
    })
    const userA = db.recordRoutingSupplement({
      inputId: inputA,
      subActionId: subActionA,
      targetDispatchId: dispatchId,
      text: '用户手动补充'
    })
    db.recordSupplementAttempt({
      supplementId: userA.supplement_id,
      requestId: 'rtsend_old_user',
      targetDispatchId: dispatchId,
      expectedTurnId: 'turn-1',
      outcome: 'delivered',
      turnId: 'turn-2'
    })
    // 输入B：路由补充结果未知（unverified）。
    agentRouter.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'continue_task', taskId, instruction: '补查冷启动' }]
    }))
    const inputB = await submit('给修登录那项补查冷启动')
    await routeOnce(inputB, false)
    const subActionB = db.listSubActions(inputB)[0]!.sub_action_id
    const routeB = db.recordRoutingSupplement({
      inputId: inputB,
      subActionId: subActionB,
      targetDispatchId: dispatchId,
      text: '补查冷启动'
    })
    db.recordSupplementAttempt({
      supplementId: routeB.supplement_id,
      requestId: 'rtsend_old_unknown',
      targetDispatchId: dispatchId,
      expectedTurnId: 'turn-1',
      outcome: 'unverified'
    })
    // 降级成 v63 形态（origin 列移除、版本号回拨），重开触发 v64 回填。
    db.db.exec('ALTER TABLE routing_supplements DROP COLUMN origin')
    db.db.exec('PRAGMA user_version = 63')
    restartOnSameLedger()
    // 回填：路由行上文本一致的行 = 'route'，用户补充保持 'user'；目标与回执原样。
    const originOf = (supplementId: string) => db.getSupplement(supplementId)!.origin
    expect(originOf(routeA.supplement_id)).toBe('route')
    expect(originOf(userA.supplement_id)).toBe('user')
    expect(originOf(routeB.supplement_id)).toBe('route')
    expect(db.getSupplement(routeA.supplement_id)!.target_dispatch_id).toBe(dispatchId)
    // 合法 true：复用原补充与回执——已送达/结果未知均不重投。
    await routeOnce(inputA, true)
    await routeOnce(inputB, true)
    expect(steerCalls.list).toHaveLength(0)
    expect(db.listSupplements(subActionA)).toHaveLength(2)
    expect(db.listSupplementAttempts(routeA.supplement_id)).toHaveLength(1)
    expect(db.listSupplementAttempts(routeB.supplement_id)).toHaveLength(1)
    // 再次重启与重放零增量。
    restartOnSameLedger()
    await routeOnce(inputA, true)
    await routeOnce(inputB, true)
    expect(steerCalls.list).toHaveLength(0)
    expect(db.listSupplementAttempts(routeA.supplement_id)).toHaveLength(1)
    expect(db.listSupplementAttempts(routeB.supplement_id)).toHaveLength(1)
  })
})
