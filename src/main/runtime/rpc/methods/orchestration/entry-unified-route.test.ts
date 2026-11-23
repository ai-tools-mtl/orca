import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../core'
import { createOrchestrationRpcHarness } from './rpc-test-harness'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import { createRootDispatch } from '../../../orchestration/db/root-dispatch-test-fixture'
import { pumpEntryAutomations } from './entry-automation-pump'
import { entryRunOfInput } from './entry-run-scope'
import { autoRouteUnifiedAgentFromEntry } from './entry-unified-route'
import {
  partialRuntimeStore,
  storeRepo
} from '../../../orca-runtime-tests/runtime-store-partial-fixture'

// Agent 单次路由（统一动作协议 v1，entry-intent-routing-design 首版验收）：纯状态零 Worker、
// 查询夹带工作、续接歧义保留独立工作、人工确认前不可写、仅规划轮询零派发、false/true 到达
// 顺序与并发 true、整次提交重试与内容冲突、决定落库后重启复用、登记后未受理的恢复推进、
// 续接投递重放、无效输出与未知版本保持待路由。

const routeProvider = vi.hoisted(() => ({
  fn: vi.fn<() => Promise<unknown>>()
}))

vi.mock('../../../orchestration/routing/agent-route-proposal-provider', () => ({
  createAgentRouteProposalProvider: () => routeProvider.fn
}))

const unifiedModel = { source: 'agent' as const, agent: 'codex' }

describe('entry auto-route with the unified single-pass agent router', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext

  afterEach(() => {
    h.cleanup()
    routeProvider.fn.mockReset()
    vi.restoreAllMocks()
  })

  async function call<T>(name: string, params: Record<string, unknown>): Promise<T> {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the asserted shape is the called method's documented receipt.
    return (await h.call(name, params, ctx)) as T
  }

  const group = 'proj_unified'

  async function submit(text: string, requestId?: string): Promise<string> {
    const { input } = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text,
      ...(requestId ? { requestId } : {})
    })
    return input.input_id
  }

  function autoRoute(
    input: string,
    dispatch: boolean
  ): Promise<{
    routed: boolean
    reused: boolean
    reason?: string
    subActions: { sub_action_id: string; text: string; task_id: string | null }[]
    dispatchErrors?: string[]
  }> {
    return call('orchestration.entryAutoRoute', {
      group,
      input,
      dispatch,
      decisionModel: unifiedModel
    })
  }

  function routeAudits(input: string) {
    return db.listDecisionModelAudits({
      runId: db.getRoutingInput(input)!.run_id,
      inputId: input,
      source: 'agent_router'
    })
  }

  /** 既有工作：一条已派发的任务，给状态查询提供账本事实（直接绑定，同生产账本形态）。 */
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

  function prepareWorkers(databasePath = ':memory:') {
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
    vi.spyOn(runtime, 'createManagedWorktree').mockImplementation(async () => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture worktree/start fields only.
      return {
        worktree: { id: 'wt_fixture' },
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

  it('answers a pure status query from the ledger with zero workers', async () => {
    prepareWorkers()
    const promptSpy = vi.mocked(ctx.runtime.sendTerminalAgentPrompt)
    const taskId = await seedRunningWork()
    routeProvider.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'query_status', target: taskId }]
    }))
    const input = await submit('登录修复进展如何？')
    const routed = await autoRoute(input, true)
    expect(routed.routed).toBe(true)
    // 答案由账本生成：点名任务的状态行进 reason，模型不代答。
    expect(routed.reason).toContain('当前进展')
    expect(routed.reason).toContain('修登录')
    // 零 Worker：纯查询登记为零子动作，没有任何派发；Agent 恰好调用一次（单次协议）。
    expect(routeProvider.fn).toHaveBeenCalledTimes(1)
    expect(promptSpy).not.toHaveBeenCalled()
    expect(db.listSubActions(input)).toEqual([])
    expect(db.getRoutingInput(input)?.decision_status).toBe('decided')
    const decisionJson = db.getRoutingInput(input)?.decision_json ?? ''
    expect(decisionJson).toContain('"strategy":"unified_agent"')
    expect(decisionJson).toContain('"protocolVersion":1')
    expect(decisionJson).toContain(`"target":"${taskId}"`)
    // 审计：协议版本 + 动作类型 + 结果，不含凭据。
    const audits = db.listDecisionModelAudits({
      runId: db.getRoutingInput(input)!.run_id,
      inputId: input
    })
    const route = audits.find((row) => row.source === 'agent_router')
    expect(route?.outcome).toBe('classified')
    expect(route?.applied_json).toContain('"actions":["query_status"]')
    expect(JSON.stringify(audits)).not.toContain('synthetic')
    // 重放复用登记结果：不再调用 Agent。
    await autoRoute(input, true)
    expect(routeProvider.fn).toHaveBeenCalledTimes(1)
  })

  it('keeps the query answer and the work of one hybrid request and dispatches only the work', async () => {
    prepareWorkers()
    const taskId = await seedRunningWork()
    routeProvider.fn.mockImplementation(async () => ({
      version: 1,
      actions: [
        { key: 'a1', type: 'query_status', target: taskId },
        { key: 'a2', type: 'create_task', instruction: '补旧版入口的回归测试', agent: 'codex' }
      ]
    }))
    const input = await submit('登录修到哪了？顺便补旧版入口的回归测试')
    const routed = await autoRoute(input, true)
    expect(routed.routed).toBe(true)
    expect(routed.subActions.map((action) => action.text)).toEqual(['补旧版入口的回归测试'])
    const show = await call<{
      inputs: {
        input: { input_id: string }
        subActions: { execution: { status: string } | null }[]
      }[]
    }>('orchestration.entryShow', { group })
    const entry = show.inputs.find((candidate) => candidate.input.input_id === input)!
    // 同一请求的两部分都在：查询答案进决定的 reason，工作部分派发。
    expect(entry.subActions[0]?.execution?.status).toBe('dispatched')
    const decisionJson = db.getRoutingInput(input)?.decision_json ?? ''
    expect(decisionJson).toContain('修登录：进行中')
    expect(decisionJson).toContain('"actionTypes":["query_status","create_task"]')
    // 实际送出的候选快照随决定保留。
    expect(decisionJson).toContain('"candidateSnapshot"')
  })

  it('answers an out-of-range query target with a clarification and still dispatches the independent work', async () => {
    prepareWorkers()
    await seedRunningWork()
    routeProvider.fn.mockImplementation(async () => ({
      version: 1,
      actions: [
        { key: 'a1', type: 'query_status', target: 'task_404' },
        { key: 'a2', type: 'create_task', instruction: '补一个启动耗时的记录脚本' }
      ]
    }))
    const input = await submit('查一下不存在的任务，顺便补一个启动耗时的记录脚本')
    const routed = await autoRoute(input, true)
    expect(routed.routed).toBe(true)
    // 越界目标只降级为该查询的待澄清；独立的调查动作照常登记与派发。
    const decisionJson = db.getRoutingInput(input)?.decision_json ?? ''
    expect(decisionJson).toContain('无法在当前项目里定位')
    expect(db.listSubActions(input).map((action) => action.text)).toEqual([
      '补一个启动耗时的记录脚本'
    ])
    const show = await call<{
      inputs: { input: { input_id: string }; subActions: { execution: unknown }[] }[]
    }>('orchestration.entryShow', { group })
    const entry = show.inputs.find((candidate) => candidate.input.input_id === input)!
    expect(entry.subActions[0]?.execution).not.toBeNull()
  })

  it('suspends only the ambiguous continuation and dispatches the independent work', async () => {
    prepareWorkers()
    routeProvider.fn.mockImplementation(async () => ({
      version: 1,
      actions: [
        { key: 'a1', type: 'clarify', question: '「刚才那项」指哪个任务？请指明要续接的任务。' },
        { key: 'a2', type: 'create_task', instruction: '补旧版入口的回归测试' }
      ]
    }))
    const input = await submit('刚才那项也补测一下，另外补旧版入口的回归测试')
    const routed = await autoRoute(input, true)
    expect(routed.routed).toBe(true)
    // 续接歧义只挂起相关动作；独立的补测动作照常派发。
    expect(db.listSubActions(input).map((action) => action.text)).toEqual(['补旧版入口的回归测试'])
    const decisionJson = db.getRoutingInput(input)?.decision_json ?? ''
    expect(decisionJson).toContain('clarifications')
    expect(decisionJson).toContain('「刚才那项」指哪个任务')
    const show = await call<{
      inputs: { input: { input_id: string }; subActions: { execution: unknown }[] }[]
    }>('orchestration.entryShow', { group })
    const entry = show.inputs.find((candidate) => candidate.input.input_id === input)!
    expect(entry.subActions[0]?.execution).not.toBeNull()
  })

  it('keeps a confirm-gated investigation read-only until the user approves', async () => {
    prepareWorkers()
    routeProvider.fn.mockImplementation(async () => ({
      version: 1,
      actions: [
        {
          key: 'a1',
          type: 'create_task',
          instruction: '先查启动慢，等我确认再改。只调查，不改文件。'
        }
      ]
    }))
    const input = await submit('先查启动慢，等我确认再改')
    const routed = await autoRoute(input, true)
    expect(routed.routed).toBe(true)
    // 现有授权逻辑从原文与子动作校验：调查需要只读 Codex 结构化会话，宿主不支持时不可写。
    expect(routed.dispatchErrors).toHaveLength(1)
    expect(db.getRoutingInput(input)?.require_write_approval).toBe(1)
    expect(db.listSubActions(input).every((action) => action.task_id === null)).toBe(true)
  })

  it('registers a plan-only decision without dispatching on polls, then dispatches on dispatch=true', async () => {
    prepareWorkers()
    routeProvider.fn.mockImplementation(async () => ({
      version: 1,
      actions: [
        {
          key: 'a1',
          type: 'create_task',
          instruction: '给后台增加一套权限管理',
          planning: true,
          clarification: true
        }
      ]
    }))
    const input = await submit('给后台增加一套权限管理')
    await autoRoute(input, false)
    // 规划模板照旧（澄清 + 计划两阶段，带用户门）。
    expect(db.listSubActions(input).map((action) => action.stage_kind)).toEqual([
      'clarification',
      'plan'
    ])
    expect(db.getRoutingInput(input)?.decision_json).toContain('"dispatchHold":true')
    const run = entryRunOfInput(db, group, input)
    const promptSpy = vi.mocked(ctx.runtime.sendTerminalAgentPrompt)
    // 仅规划后轮询：零 Worker。
    await pumpEntryAutomations({ runtime: ctx.runtime, run, group })
    expect(promptSpy).not.toHaveBeenCalled()
    expect(db.listSubActions(input).every((action) => action.task_id === null)).toBe(true)
    // dispatch=true 触达：保持清除，下一次轮询派发阶段。
    await autoRoute(input, true)
    expect(db.getRoutingInput(input)?.decision_json).not.toContain('dispatchHold')
    expect(db.getRoutingInput(input)?.decision_json).toContain('"dispatchAuthorized":true')
    await pumpEntryAutomations({ runtime: ctx.runtime, run, group })
    expect(db.listSubActions(input).some((action) => action.task_id !== null)).toBe(true)
  })

  it('merges false-first and true-arrival routes and completes the dispatch for the true caller', async () => {
    prepareWorkers()
    let calls = 0
    routeProvider.fn.mockImplementation(async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return {
        version: 1,
        actions: [{ key: 'a1', type: 'create_task', instruction: '修登录', agent: 'codex' }]
      }
    })
    const input = await submit('修登录')
    const [falseResult, trueResult] = await Promise.all([
      autoRoute(input, false),
      autoRoute(input, true)
    ])
    expect(falseResult.routed).toBe(true)
    expect(trueResult.routed).toBe(true)
    // 共享一次计算；只有 true 写入派发意图并完成派发。
    expect(calls).toBe(1)
    expect(trueResult.dispatchErrors).toEqual([])
    expect(db.listSubActions(input).some((action) => action.task_id !== null)).toBe(true)
    expect(db.getRoutingInput(input)?.decision_json).toContain('"dispatchAuthorized":true')
  })

  it('dispatches once under concurrent true callers and replays without a second agent call', async () => {
    prepareWorkers()
    let calls = 0
    routeProvider.fn.mockImplementation(async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return {
        version: 1,
        actions: [{ key: 'a1', type: 'create_task', instruction: '修登录', agent: 'codex' }]
      }
    })
    const input = await submit('修登录')
    const [first, second] = await Promise.all([autoRoute(input, true), autoRoute(input, true)])
    expect(first.routed).toBe(true)
    expect(second.routed).toBe(true)
    expect(calls).toBe(1)
    const show = await call<{ inputs: { subActions: { execution: unknown }[] }[] }>(
      'orchestration.entryShow',
      { group }
    )
    expect(
      show.inputs.flatMap((entry) => entry.subActions).filter((action) => action.execution !== null)
    ).toHaveLength(1)
    const replay = await autoRoute(input, true)
    expect(replay).toMatchObject({ routed: true, reused: true })
    expect(calls).toBe(1)
    expect(db.listSubActions(input)).toHaveLength(1)
  })

  it('reuses the recorded decision after a restart and dispatches what never started', async () => {
    const databasePath = join(
      mkdtempSync(join(tmpdir(), 'orca-unified-route-')),
      'orchestration.db'
    )
    // 落库（dispatch=false 登记计划），随后模拟「授权已落、Worker 未受理」的崩溃形态。
    prepareWorkers(databasePath)
    routeProvider.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'create_task', instruction: '修登录', agent: 'codex' }]
    }))
    const input = await submit('修登录')
    await autoRoute(input, false)
    expect(db.listSubActions(input).every((action) => action.task_id === null)).toBe(true)
    h.cleanup()
    // 重启：同一数据库文件重开，入口 Run 与输入仍可寻址。
    prepareWorkers(databasePath)
    expect(db.getRoutingInput(input)?.decision_status).toBe('decided')
    // 崩溃形态：授权已落（true 曾触达）但动作从未受理——标记后泵补派。
    db.setRoutingDispatchHold(input, false)
    db.setRoutingDispatchAuthorized(input)
    const run = entryRunOfInput(db, group, input)
    await pumpEntryAutomations({ runtime: ctx.runtime, run, group })
    expect(db.listSubActions(input).some((action) => action.task_id !== null)).toBe(true)
    // 决定已登记 ≠ 重新路由：重启后的 dispatch=true 复用原决定，不再调用 Agent。
    const replay = await autoRoute(input, true)
    expect(replay).toMatchObject({ routed: true, reused: true })
    expect(routeProvider.fn).toHaveBeenCalledTimes(1)
    expect(db.listSubActions(input)).toHaveLength(1)
  })

  it('replays a continue_task delivery without recording a second supplement', async () => {
    prepareWorkers()
    const taskId = await seedRunningWork()
    routeProvider.fn.mockImplementation(async () => ({
      version: 1,
      actions: [
        { key: 'a1', type: 'continue_task', taskId, instruction: '补一个并发场景的回归测试' }
      ]
    }))
    const input = await submit('给修登录那项补一个并发场景的回归测试')
    const routed = await autoRoute(input, true)
    expect(routed.routed).toBe(true)
    // 续接目标绑定到既有任务，投递走现有补充通道（认领的 Dispatch）。
    expect(routed.subActions[0]?.task_id).toBe(taskId)
    const supplements = () =>
      db.db
        .prepare('SELECT COUNT(*) AS count FROM routing_supplements WHERE input_id = ?')
        .get(input) as { count: number }
    expect(supplements().count).toBe(1)
    // 重放（同一输入再次 dispatch=true）：复用原补充记录，不登记第二份投递。
    await autoRoute(input, true)
    expect(supplements().count).toBe(1)
  })

  it('keeps the input awaiting routing on invalid output and lets an explicit retry succeed', async () => {
    prepareWorkers()
    routeProvider.fn.mockImplementationOnce(async () => ({
      version: 2,
      actions: [{ key: 'a1', type: 'no_action', reason: '未知版本' }]
    }))
    const input = await submit('修登录')
    const routed = await autoRoute(input, true)
    expect(routed.routed).toBe(false)
    expect(routed.reason).toContain('router unavailable')
    expect(db.getRoutingInput(input)?.decision_status).toBe('received')
    // 重复键同样是结构性拒绝。
    routeProvider.fn.mockImplementationOnce(async () => ({
      version: 1,
      actions: [
        { key: 'a1', type: 'create_task', instruction: '修登录' },
        { key: 'a1', type: 'create_task', instruction: '查启动慢' }
      ]
    }))
    const duplicated = await autoRoute(input, true)
    expect(duplicated.routed).toBe(false)
    // no_action 不单独出现也拒绝。
    routeProvider.fn.mockImplementationOnce(async () => ({
      version: 1,
      actions: [
        { key: 'a1', type: 'no_action', reason: '无需处理' },
        { key: 'a2', type: 'create_task', instruction: '修登录' }
      ]
    }))
    const mixedNoAction = await autoRoute(input, true)
    expect(mixedNoAction.routed).toBe(false)
    // Agent 恢复后显式重试成功（规划模板分支）。
    routeProvider.fn.mockImplementationOnce(async () => ({
      version: 1,
      actions: [
        {
          key: 'a1',
          type: 'create_task',
          instruction: '给后台增加一套权限管理',
          planning: true,
          clarification: true
        }
      ]
    }))
    const retried = await autoRoute(input, true)
    expect(retried).toMatchObject({ routed: true, reused: false })
    expect(db.listSubActions(input).map((action) => action.stage_kind)).toEqual([
      'clarification',
      'plan'
    ])
  })

  it('surfaces a no_action proposal as a decided zero-work verdict', async () => {
    prepareWorkers()
    routeProvider.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'no_action', reason: '这条消息只是打招呼，无需处理。' }]
    }))
    const input = await submit('你好')
    const routed = await autoRoute(input, true)
    expect(routed.routed).toBe(true)
    expect(routed.reason).toContain('无需处理')
    expect(db.listSubActions(input)).toEqual([])
    expect(db.getRoutingInput(input)?.decision_status).toBe('decided')
    const decisionJson = db.getRoutingInput(input)?.decision_json ?? ''
    expect(decisionJson).toContain('"actionTypes":["no_action"]')
  })

  it('sends only the invalidated query to clarification and still dispatches the independent work', async () => {
    prepareWorkers()
    const taskId = await seedRunningWork()
    // 快照已生成、提案返回前：把该任务从入口软删除（绑定子动作 entry_deleted_at）。
    routeProvider.fn.mockImplementation(async () => {
      db.db
        .prepare(
          "UPDATE routing_sub_actions SET entry_deleted_at = datetime('now') WHERE task_id = ?"
        )
        .run(taskId)
      return {
        version: 1,
        actions: [
          { key: 'a1', type: 'query_status', target: taskId },
          { key: 'a2', type: 'create_task', instruction: '补回归测试', agent: 'codex' }
        ]
      }
    })
    const input = await submit('登录修复进展如何？顺便补回归测试')
    const routed = await autoRoute(input, true)
    expect(routed.routed).toBe(true)
    // 失效目标进入待澄清，而不是账本上的假「尚无进展记录」。
    expect(routed.reason).toContain('待澄清')
    expect(routed.reason).toContain('已失效')
    expect(routed.reason).not.toContain('尚无进展记录')
    // 独立工作照常登记并按已有授权派发。
    expect(db.listSubActions(input).map((action) => action.text)).toEqual(['补回归测试'])
    expect(db.listSubActions(input)[0]?.task_id).not.toBeNull()
  })

  it('sends an invalidated continuation to clarification and keeps the independent work routable', async () => {
    prepareWorkers()
    const taskId = await seedRunningWork()
    routeProvider.fn.mockImplementation(async () => {
      db.db
        .prepare(
          "UPDATE routing_sub_actions SET entry_deleted_at = datetime('now') WHERE task_id = ?"
        )
        .run(taskId)
      return {
        version: 1,
        actions: [
          { key: 'a1', type: 'continue_task', taskId, instruction: '补并发场景回归测试' },
          { key: 'a2', type: 'create_task', instruction: '补回归测试', agent: 'codex' }
        ]
      }
    })
    const input = await submit('给修登录那项补并发场景回归测试，顺便补回归测试')
    const routed = await autoRoute(input, true)
    // 失效的续接只挂起自己，整批路由不失败；独立工作登记并派发。
    expect(routed.routed).toBe(true)
    expect(routed.reason).toContain('已失效')
    expect(db.listSubActions(input).map((action) => action.text)).toEqual(['补回归测试'])
    expect(db.listSubActions(input)[0]?.task_id).not.toBeNull()
    // 失效目标不出现在续接引用里（不会向已删除的任务登记投递）。
    const decisionJson = db.getRoutingInput(input)?.decision_json ?? ''
    expect(decisionJson).not.toContain(`"taskReferences":["${taskId}"`)
    expect(decisionJson).toContain('已失效')
  })

  it('sends a continuation without a receivable session to clarification', async () => {
    prepareWorkers()
    const workInput = await submit('修登录，完整跑一遍')
    const { subActions } = db.registerRoutingDecision({
      inputId: workInput,
      subActions: [{ text: '修登录' }]
    })
    const taskId = db.createTask({
      runId: db.getRoutingInput(workInput)!.run_id,
      spec: '修登录'
    }).id
    // 任务健在但没有派发上下文（无可接收的会话）。
    db.db
      .prepare('UPDATE routing_sub_actions SET task_id = ? WHERE sub_action_id = ?')
      .run(taskId, subActions[0]!.sub_action_id)
    routeProvider.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'continue_task', taskId, instruction: '补回归测试' }]
    }))
    const input = await submit('给修登录那项补回归测试')
    const routed = await autoRoute(input, true)
    expect(routed.routed).toBe(true)
    // 任务健在但没有可接收的会话（无派发上下文）：只挂起这一项。
    expect(routed.reason).toContain('没有进行中的会话')
    expect(db.listSubActions(input)).toEqual([])
  })

  it('resumes an authorized continuation that never recorded its delivery, exactly once', async () => {
    prepareWorkers()
    const taskId = await seedRunningWork()
    routeProvider.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'continue_task', taskId, instruction: '补并发场景回归测试' }]
    }))
    const input = await submit('给修登录那项补并发场景回归测试')
    // dispatch=false 登记决定：动作绑定目标任务，投递记录为零。
    await autoRoute(input, false)
    expect(db.listSubActions(input)[0]?.task_id).toBe(taskId)
    expect(
      db.db
        .prepare('SELECT COUNT(*) AS count FROM routing_supplements WHERE input_id = ?')
        .get(input)
    ).toEqual({ count: 0 })
    expect(db.getRoutingInput(input)?.decision_json).toContain('"dispatchHold":true')
    // 中断形态：派发授权已持久化，驱动尚未登记补充——重开同一账本后由轮询推进。
    db.setRoutingDispatchHold(input, false)
    db.setRoutingDispatchAuthorized(input)
    const run = entryRunOfInput(db, group, input)
    await pumpEntryAutomations({ runtime: ctx.runtime, run, group })
    const supplements = () =>
      db.db
        .prepare('SELECT COUNT(*) AS count FROM routing_supplements WHERE input_id = ?')
        .get(input) as { count: number }
    expect(supplements().count).toBe(1)
    // 重复轮询复用原记录：不登记第二份，也不向已受理动作重复投递。
    await pumpEntryAutomations({ runtime: ctx.runtime, run, group })
    expect(supplements().count).toBe(1)
    // 对照：dispatch=false 的输入在轮询后保持零派发、零补充投递。
    routeProvider.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'continue_task', taskId, instruction: '再补一个边界用例' }]
    }))
    const heldInput = await submit('给修登录那项再补一个边界用例')
    await autoRoute(heldInput, false)
    await pumpEntryAutomations({ runtime: ctx.runtime, run, group })
    expect(db.getRoutingInput(heldInput)?.decision_json).toContain('"dispatchHold":true')
    expect(
      db.db
        .prepare('SELECT COUNT(*) AS count FROM routing_supplements WHERE input_id = ?')
        .get(heldInput)
    ).toEqual({ count: 0 })
    expect(db.listSubActions(heldInput).every((action) => action.task_id !== null)).toBe(true)
  })

  it('resumes a recorded supplement with no attempts and keeps unknown-outcome ones held', async () => {
    prepareWorkers()
    const taskId = await seedRunningWork()
    routeProvider.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'continue_task', taskId, instruction: '补查冷启动' }]
    }))
    const input = await submit('给修登录那项补查冷启动')
    await autoRoute(input, false)
    const action = db.listSubActions(input)[0]!
    expect(action.task_id).toBe(taskId)
    // 「已有补充但尚无投递尝试」的中断形态：补充已落（指向原 Dispatch），尝试为零。
    const dispatch = db.getDispatchContext(taskId)!
    const supplement = db.recordRoutingSupplement({
      inputId: input,
      subActionId: action.sub_action_id,
      targetDispatchId: dispatch.id,
      text: action.text,
      origin: 'route'
    })
    db.setRoutingDispatchHold(input, false)
    db.setRoutingDispatchAuthorized(input)
    const run = entryRunOfInput(db, group, input)
    const attempts = () => db.listSupplementAttempts(supplement.supplement_id)
    const supplementCount = () =>
      db.db
        .prepare('SELECT COUNT(*) AS count FROM routing_supplements WHERE input_id = ?')
        .get(input) as { count: number }
    await pumpEntryAutomations({ runtime: ctx.runtime, run, group })
    // 复用原补充和原目标补投；本 harness 无结构化会话宿主，投递入口留下明确拒收记录。
    expect(supplementCount().count).toBe(1)
    expect(attempts()).toHaveLength(1)
    expect(attempts()[0]?.outcome).toBe('refused')
    expect(supplement.target_dispatch_id).toBe(dispatch.id)
    // 重复轮询复用记录：不登记第二份补充，也不新增尝试。
    await pumpEntryAutomations({ runtime: ctx.runtime, run, group })
    expect(supplementCount().count).toBe(1)
    expect(attempts()).toHaveLength(1)
    // 「已有尝试但结果未知」：保持待核对，不向新轮次重发。
    db.db
      .prepare(
        "UPDATE routing_supplement_attempts SET outcome = 'unverified', refusal_kind = NULL WHERE attempt_id = ?"
      )
      .run(attempts()[0]!.attempt_id)
    await pumpEntryAutomations({ runtime: ctx.runtime, run, group })
    expect(attempts()).toHaveLength(1)
    expect(attempts()[0]?.outcome).toBe('unverified')
    // 对照：dispatch:false 的输入保持零补充、零尝试。
    const held = await submit('给修登录那项再补一个边界用例')
    await autoRoute(held, false)
    await pumpEntryAutomations({ runtime: ctx.runtime, run, group })
    expect(
      db.db
        .prepare('SELECT COUNT(*) AS count FROM routing_supplements WHERE input_id = ?')
        .get(held)
    ).toEqual({ count: 0 })
  })

  it('keeps two independent planning chains with their own instructions and read-only constraints', async () => {
    prepareWorkers()
    routeProvider.fn.mockImplementation(async () => ({
      version: 1,
      actions: [
        {
          key: 'p1',
          type: 'create_task',
          instruction: '给登录模块做一次只读调查：先调查，等我确认再改。',
          planning: true,
          clarification: true
        },
        {
          key: 'p2',
          type: 'create_task',
          instruction: '给通知模块做一次只读调查：先调查，等我确认再改。',
          planning: true,
          clarification: true
        },
        { key: 'w1', type: 'query_status', target: 'project' }
      ]
    }))
    // 原文带只读与先确认约束——require_write_approval 从原文推导并保持生效。
    const input = await submit('登录模块和通知模块各做一次调查规划，先调查，等我确认再改')
    const routed = await autoRoute(input, false)
    expect(routed.routed).toBe(true)
    const rows = db.listSubActions(input)
    // 两条规划各自展开阶段链（澄清 + 计划各一），指令不互相吞并；查询动作不入子动作。
    expect(rows.filter((row) => row.stage_kind === 'clarification')).toHaveLength(2)
    expect(rows.filter((row) => row.stage_kind === 'plan')).toHaveLength(2)
    const clarifications = rows.filter((row) => row.stage_kind === 'clarification')
    expect(clarifications.some((row) => row.text.includes('登录模块'))).toBe(true)
    expect(clarifications.some((row) => row.text.includes('通知模块'))).toBe(true)
    // 阶段依赖绑定各自链：每条 clarification 的 plan 依赖自己的 clarification（链内闭合）。
    const planRows = rows.filter((row) => row.stage_kind === 'plan')
    for (const planRow of planRows) {
      const planDeps = JSON.parse(planRow.depends_on_json ?? '[]') as string[]
      expect(planDeps).toHaveLength(1)
      expect(clarifications.some((row) => row.sub_action_id === planDeps[0])).toBe(true)
    }
    // 原文的只读与先确认约束仍有效：输入带确认语义 → 只读/写入审批门保持。
    expect(db.getRoutingInput(input)?.require_write_approval).toBe(1)
    // 实际发送的候选快照完整留存（taskId/spec/status），非仅 ID。
    const snapshot = (
      JSON.parse(db.getRoutingInput(input)?.decision_json ?? '{}') as {
        decision: { candidateSnapshot: { taskId: string; spec: string; status: string }[] }
      }
    ).decision.candidateSnapshot
    expect(Array.isArray(snapshot)).toBe(true)
    for (const entry of snapshot) {
      expect(Object.keys(entry).sort()).toEqual(['spec', 'status', 'taskId'])
    }
  })

  it('audits a failed source call once and keeps the input retryable', async () => {
    prepareWorkers()
    // 无效输出（缺 version）：provider 抛结构错误 → 可重试待路由 + 一次失败审计（含耗时）。
    routeProvider.fn.mockImplementation(async () => ({
      actions: [{ key: 'a1', type: 'create_task' }]
    }))
    const input = await submit('修登录')
    const routed = await autoRoute(input, false)
    expect(routed.routed).toBe(false)
    expect(db.getRoutingInput(input)?.decision_status).toBe('received')
    const audits = routeAudits(input)
    expect(audits).toHaveLength(1)
    expect(audits[0]!.outcome).toBe('error')
    expect(audits[0]!.latency_ms).not.toBeNull()
    expect(audits[0]!.applied_json).toContain('"failed":true')
    // 失败后的显式重试是一次新的真实来源调用：再记一行失败审计（每次实际调用一行）。
    await autoRoute(input, false)
    expect(routeAudits(input)).toHaveLength(2)
    // 登记成功后的重放不重复计入调用：成功路由一次，重放不新增审计行。
    routeProvider.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'create_task', instruction: '修登录', agent: 'codex' }]
    }))
    await autoRoute(input, false)
    expect(db.getRoutingInput(input)?.decision_status).toBe('decided')
    const total = routeAudits(input)
    expect(total.map((row) => row.outcome)).toEqual(['classified', 'error', 'error'])
  })

  it('audits a route timeout exactly once; late results are dropped without double audit', async () => {
    prepareWorkers()
    // 来源永不返回：推进到路由超时，RPC 返回时恰有一条失败审计与耗时。
    const lateReject: { fn?: (error: Error) => void } = {}
    routeProvider.fn.mockImplementation(
      () =>
        new Promise<never>((_resolve, reject) => {
          lateReject.fn = reject
        })
    )
    const input = await submit('修登录')
    const run = entryRunOfInput(db, group, input)
    const routed = await autoRouteUnifiedAgentFromEntry(
      db,
      ctx.runtime,
      { input, decisionModel: unifiedModel },
      run,
      ['codex'],
      { timeoutMs: 60 }
    )
    expect(routed.routed).toBe(false)
    expect(db.getRoutingInput(input)?.decision_status).toBe('received')
    const audits = () => routeAudits(input)
    expect(audits()).toHaveLength(1)
    expect(audits()[0]!.outcome).toBe('error')
    expect(audits()[0]!.latency_ms).not.toBeNull()
    // 来源在超时后才返回：迟到结果被丢弃——不登记迟到的决定、不重复写审计。
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(audits()).toHaveLength(1)
    expect(db.getRoutingInput(input)?.decision_status).toBe('received')
    expect(db.listSubActions(input)).toEqual([])
    // 来源在超时后才抛错：不重复写审计。
    lateReject.fn?.(new Error('late source failure'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(audits()).toHaveLength(1)
    // 显式重试（新调用）：成功登记；重放不重复计入。
    routeProvider.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'create_task', instruction: '修登录', agent: 'codex' }]
    }))
    const retried = await autoRouteUnifiedAgentFromEntry(
      db,
      ctx.runtime,
      { input, decisionModel: unifiedModel },
      run,
      ['codex']
    )
    expect(retried.routed).toBe(true)
    const auditOutcomes = audits().map((row) => row.outcome)
    expect(auditOutcomes.filter((outcome) => outcome === 'error')).toHaveLength(1)
    expect(auditOutcomes).toContain('classified')
  })

  it('never leaks synthetic credentials into the ledger or audit on route failure', async () => {
    prepareWorkers()
    // 来源抛出含 Authorization: Bearer 合成凭据的错误——审计与入口错误均脱敏。
    routeProvider.fn.mockImplementation(async () => {
      throw new Error(
        'decision model returned 401: Authorization: Bearer sk-synthetic-abc123def456 was rejected'
      )
    })
    const input = await submit('修登录')
    const routed = await autoRoute(input, false)
    expect(routed.routed).toBe(false)
    // 入口持久化错误（entry_error）脱敏：凭据不出现。
    const entryError = db.getRoutingInput(input)?.entry_error ?? ''
    expect(entryError).not.toContain('sk-synthetic-abc123def456')
    // agent_router 审计 errorMessage 脱敏：凭据不出现。
    const audits = routeAudits(input)
    expect(audits).toHaveLength(1)
    expect(audits[0]!.outcome).toBe('error')
    expect(audits[0]!.error_message).not.toContain('sk-synthetic-abc123def456')
    expect(audits[0]!.latency_ms).not.toBeNull()
    // 输入保持可重试。
    expect(db.getRoutingInput(input)?.decision_status).toBe('received')
  })

  it('never leaks JSON-serialized x-api-key credentials into any output', async () => {
    prepareWorkers()
    // 来源抛出含 JSON 序列化 x-api-key 的错误。
    routeProvider.fn.mockImplementation(async () => {
      throw new Error(
        'fetch failed with headers {"x-api-key":"sk-synthetic-key-123456","Authorization":"Bearer sk-bearer-token-789"}: endpoint returned 401'
      )
    })
    const input = await submit('修登录')
    const routed = await autoRoute(input, false)
    expect(routed.routed).toBe(false)
    // RPC reason 脱敏。
    expect(routed.reason).not.toContain('sk-synthetic-key-123456')
    expect(routed.reason).not.toContain('sk-bearer-token-789')
    // 入口 entry_error 脱敏。
    const entryError = db.getRoutingInput(input)?.entry_error ?? ''
    expect(entryError).not.toContain('sk-synthetic-key-123456')
    expect(entryError).not.toContain('sk-bearer-token-789')
    // agent_router 审计脱敏。
    const audits = routeAudits(input)
    expect(audits).toHaveLength(1)
    const auditStr = JSON.stringify(audits)
    expect(auditStr).not.toContain('sk-synthetic-key-123456')
    expect(auditStr).not.toContain('sk-bearer-token-789')
    // 重试语义保留。
    expect(db.getRoutingInput(input)?.decision_status).toBe('received')
  })
})
