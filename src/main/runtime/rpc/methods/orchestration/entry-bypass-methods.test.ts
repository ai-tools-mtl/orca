import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../core'
import { createOrchestrationRpcHarness } from './rpc-test-harness'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import {
  partialRuntimeStore,
  storeRepo
} from '../../../orca-runtime-tests/runtime-store-partial-fixture'
import type { RouteBypassSettings } from '../../../../../shared/settings/decision-model-settings'
import type { createAgentRouteProposalProvider as agentRouteProposalProviderModule } from '../../../orchestration/routing/agent-route-proposal-provider'

// 专用决策模型旁路对照（评估）：主路由照常登记派发，旁路对同一输入各调用一次专用端点并
// 落 dedicated_bypass 审计行（幂等）；端点失败/无效输出只进对照记录，不影响任何执行路径。
// 标注 upsert 与对照报告按分组统计漏工作/绑错任务，并列两侧原始提案。

const agentRouter = vi.hoisted(() => ({ fn: vi.fn<() => Promise<unknown>>() }))

vi.mock('../../../orchestration/routing/agent-route-proposal-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof agentRouteProposalProviderModule>()),
  // 只替换 Agent 侧传输（CLI 不可入测）；协议 prompt/切分保持真实实现，旁路对照才公平。
  createAgentRouteProposalProvider: () => agentRouter.fn
}))

const bypassFetch = vi.hoisted(() => ({ fn: vi.fn<typeof fetch>() }))

const bypassSettings: RouteBypassSettings = {
  enabled: true,
  baseUrl: 'https://dedicated.example/v1',
  apiKey: 'synthetic-dedicated-key',
  modelId: 'dedicated-fast',
  protocol: 'openai'
}

function bypassResponse(actions: unknown[]): Response {
  return {
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({ version: 1, actions })
          }
        }
      ],
      usage: { prompt_tokens: 120, completion_tokens: 30 }
    })
  } as unknown as Response
}

describe('dedicated decision model bypass', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext

  afterEach(() => {
    h.cleanup()
    agentRouter.fn.mockReset()
    bypassFetch.fn.mockReset()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function call<T>(name: string, params: Record<string, unknown>): Promise<T> {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the asserted shape is the called method's documented receipt.
    return (await h.call(name, params, ctx)) as T
  }

  const group = 'proj_bypass'

  function prepareWorkers(
    withBypass: boolean,
    bypassOverride: Partial<typeof bypassSettings> = {}
  ) {
    const repo = storeRepo({ id: group, path: '/fixture/project', kind: 'git' })
    const settings = {
      defaultTuiAgent: 'codex' as const,
      nativeChatProviders: {},
      ...(withBypass
        ? { routeBypass: { ...bypassSettings, ...bypassOverride } }
        : { routeBypass: { ...bypassSettings, enabled: false } })
    }
    const state = h.setup(
      false,
      partialRuntimeStore({ getRepos: () => [repo], getSettings: () => settings })
    )
    db = state.db
    ctx = { ...state.ctx, caller: { kind: 'desktop' } }
  }

  async function submitAndRoute(text: string, actions: unknown[]): Promise<string> {
    const proposal = { version: 1, actions }
    vi.stubGlobal('fetch', bypassFetch.fn)
    agentRouter.fn.mockImplementation(async () => proposal)
    bypassFetch.fn.mockImplementation(async () => bypassResponse(actions))
    const { input } = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text
    })
    await call('orchestration.entryAutoRoute', {
      group,
      input: input.input_id,
      dispatch: false,
      decisionModel: { source: 'agent', agent: 'codex' }
    })
    return input.input_id
  }

  it('shadows each routed input exactly once without touching the primary path', async () => {
    prepareWorkers(true)
    const first = await submitAndRoute('修登录，另外查启动慢', [
      { key: 'a1', type: 'create_task', instruction: '修登录', agent: 'codex' },
      { key: 'a2', type: 'query_status', target: 'project' }
    ])
    const inputId = first
    // 旁路 trial 落 dedicated_bypass 审计行（fire-and-forget：轮询等待落账）：提案原样、tokens 计齐。
    await vi.waitFor(() => {
      expect(
        db.listDecisionModelAudits({
          runId: db.getRoutingInput(inputId)!.run_id,
          inputId,
          source: 'dedicated_bypass'
        })
      ).toHaveLength(1)
    })
    const trials = db.listDecisionModelAudits({
      runId: db.getRoutingInput(inputId)!.run_id,
      inputId,
      source: 'dedicated_bypass'
    })
    const trial = trials[0]!
    expect(trial.outcome).toBe('classified')
    expect(trial.input_tokens).toBe(120)
    expect(trial.output_tokens).toBe(30)
    const proposal = JSON.parse(trial.answers_json ?? 'null')
    expect(proposal.version).toBe(1)
    expect(proposal.actions).toHaveLength(2)
    expect(proposal.actions[0]).toMatchObject({ type: 'create_task', instruction: '修登录' })
    expect(proposal.actions[1]).toMatchObject({ type: 'query_status', target: 'project' })
    // 主链路不受旁路影响：agent 侧照常登记（同一输入一条 agent_router 审计 + 子动作）。
    expect(db.listSubActions(inputId).map((action) => action.text)).toEqual(['修登录'])
    expect(
      db.listDecisionModelAudits({
        runId: db.getRoutingInput(inputId)!.run_id,
        inputId,
        source: 'agent_router'
      })
    ).toHaveLength(1)
    // 同 input 的第二次路由尝试不重复旁路（每个来源每次只调用一次）。
    bypassFetch.fn.mockClear()
    await call('orchestration.entryAutoRoute', {
      group,
      input: inputId,
      dispatch: false,
      decisionModel: { source: 'agent', agent: 'codex' }
    })
    expect(bypassFetch.fn).not.toHaveBeenCalled()
    expect(
      db.listDecisionModelAudits({
        runId: db.getRoutingInput(inputId)!.run_id,
        inputId,
        source: 'dedicated_bypass'
      })
    ).toHaveLength(1)
    // 凭据不进审计行。
    expect(JSON.stringify(trials)).not.toContain('synthetic-dedicated-key')
  })

  it('keeps the primary path intact when the dedicated endpoint fails or returns invalid output', async () => {
    prepareWorkers(true)
    vi.stubGlobal('fetch', bypassFetch.fn)
    // 端点 500：旁路落 error 审计行，主路由照常登记派发决定。
    bypassFetch.fn.mockImplementation(
      async () => ({ ok: false, status: 500 }) as unknown as Response
    )
    agentRouter.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'create_task', instruction: '修登录', agent: 'codex' }]
    }))
    const failed = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '修登录'
    })
    await call('orchestration.entryAutoRoute', {
      group,
      input: failed.input.input_id,
      dispatch: false,
      decisionModel: { source: 'agent', agent: 'codex' }
    })
    await vi.waitFor(() => {
      expect(
        db.listDecisionModelAudits({
          runId: db.getRoutingInput(failed.input.input_id)!.run_id,
          inputId: failed.input.input_id,
          source: 'dedicated_bypass'
        })
      ).toHaveLength(1)
    })
    const failedTrial = db
      .listDecisionModelAudits({
        runId: db.getRoutingInput(failed.input.input_id)!.run_id,
        inputId: failed.input.input_id,
        source: 'dedicated_bypass'
      })
      .at(0)!
    expect(failedTrial.outcome).toBe('error')
    expect(failedTrial.error_message).toContain('decision model returned 500')
    expect(db.listSubActions(failed.input.input_id).map((action) => action.text)).toEqual([
      '修登录'
    ])
    // 端点返回结构无效（缺 actions）：旁路 error，主路由照常。
    bypassFetch.fn.mockImplementation(
      async () =>
        ({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify({ version: 2 }) } }]
          })
        }) as unknown as Response
    )
    agentRouter.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'create_task', instruction: '查启动慢' }]
    }))
    const invalid = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '查启动慢'
    })
    await call('orchestration.entryAutoRoute', {
      group,
      input: invalid.input.input_id,
      dispatch: false,
      decisionModel: { source: 'agent', agent: 'codex' }
    })
    await vi.waitFor(() => {
      expect(
        db.listDecisionModelAudits({
          runId: db.getRoutingInput(invalid.input.input_id)!.run_id,
          inputId: invalid.input.input_id,
          source: 'dedicated_bypass'
        })
      ).toHaveLength(1)
    })
    expect(db.listSubActions(invalid.input.input_id).map((action) => action.text)).toEqual([
      '查启动慢'
    ])
  })

  it('does not call the dedicated endpoint when the shadow run is disabled', async () => {
    prepareWorkers(false)
    bypassFetch.fn.mockImplementation(async () => bypassResponse([]))
    agentRouter.fn.mockImplementation(async () => [
      { key: 'a1', type: 'create_task', instruction: '修登录', agent: 'codex' }
    ])
    const input = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '修登录'
    })
    await call('orchestration.entryAutoRoute', {
      group,
      input: input.input.input_id,
      dispatch: false,
      decisionModel: { source: 'agent', agent: 'codex' }
    })
    expect(bypassFetch.fn).not.toHaveBeenCalled()
    expect(
      db.listDecisionModelAudits({
        runId: db.getRoutingInput(input.input.input_id)!.run_id,
        inputId: input.input.input_id,
        source: 'dedicated_bypass'
      })
    ).toHaveLength(0)
  })

  it('labels inputs, reports per-category misses, and lists raw trials', async () => {
    prepareWorkers(true)
    const routed = await submitAndRoute('修登录，另外查启动慢', [
      { key: 'a1', type: 'create_task', instruction: '修登录', agent: 'codex' },
      { key: 'a2', type: 'query_status', target: 'project' }
    ])
    const inputId = routed
    const runId = db.getRoutingInput(inputId)!.run_id
    // 标注：复合请求应有两个工作动作（登录修复 + 启动调查）→ 专用侧漏一个。
    await call('orchestration.routeBypassLabelSet', {
      group,
      input: inputId,
      category: 'composite',
      expected: [
        { type: 'create_task', instruction: '修登录' },
        { type: 'create_task', instruction: '调查启动慢' }
      ],
      notes: '两项独立交付'
    })
    // upsert：同 input 覆盖而不新增。
    await call('orchestration.routeBypassLabelSet', {
      group,
      input: inputId,
      category: 'composite',
      expected: [
        { type: 'create_task', instruction: '修登录' },
        { type: 'create_task', instruction: '调查启动慢的原因' }
      ]
    })
    expect(db.listRouteBypassLabels({ runId })).toHaveLength(1)
    const report = await call<{
      summary: {
        category: string
        labeled: number
        invalidOutputs: number
        missingWork: number
        mismatchedTasks: number
      }[]
      details: {
        inputId: string
        agent: { actions: { type: string }[] }
        dedicated: { outcome: string; actions: { type: string }[] }
        comparison: { missingWork: string[] }
      }[]
      pending: unknown[]
    }>('orchestration.routeBypassReport', { group })
    expect(report.summary).toHaveLength(1)
    expect(report.summary[0]).toMatchObject({
      category: 'composite',
      labeled: 1,
      invalidOutputs: 0,
      missingWork: 1,
      mismatchedTasks: 0
    })
    const detail = report.details[0]!
    // 两侧原始提案并列（约束丢弃由人工核对）。
    // agent 侧忠实反映登记产出：工作子动作 + 决定里的查询动作。
    expect(detail.agent.actions).toEqual([
      { type: 'create_task', instruction: '修登录' },
      { type: 'query_status' }
    ])
    expect(detail.dedicated.actions).toEqual([
      { key: 'a1', type: 'create_task', instruction: '修登录', agent: 'codex' },
      { key: 'a2', type: 'query_status', target: 'project' }
    ])
    expect(detail.comparison.missingWork).toHaveLength(1)
    expect(report.pending).toEqual([])
    // trial list 与报告同源。
    const trials = await call<{ trials: { inputId: string; outcome: string }[] }>(
      'orchestration.routeBypassTrialList',
      { group }
    )
    expect(trials.trials.map((trial) => trial.inputId)).toEqual([inputId])
    // 缺标注的已决输入列 pending。
    agentRouter.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'create_task', instruction: '再修登录', agent: 'codex' }]
    }))
    const second = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '再修登录'
    })
    await call('orchestration.entryAutoRoute', {
      group,
      input: second.input.input_id,
      dispatch: false,
      decisionModel: { source: 'agent', agent: 'codex' }
    })
    const pendingReport = await call<{
      pending: { inputId: string; reason: string }[]
    }>('orchestration.routeBypassReport', { group })
    expect(pendingReport.pending).toEqual([{ inputId: second.input.input_id, reason: 'no_label' }])
  })

  it('parses the anthropic messages protocol and reports its usage tokens', async () => {
    prepareWorkers(true, { protocol: 'anthropic' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          content: [
            { type: 'text', text: '{"version":1,"act' },
            { type: 'text', text: 'ions":[{"key":"a1","type":"no_action","reason":"nothing"}]}' }
          ],
          usage: { input_tokens: 55, output_tokens: 12 }
        })
      })) as unknown as Response
    )
    agentRouter.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'create_task', instruction: '修登录', agent: 'codex' }]
    }))
    const receipt = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '修登录'
    })
    const inputId = receipt.input.input_id
    await call('orchestration.entryAutoRoute', {
      group,
      input: inputId,
      dispatch: false,
      decisionModel: { source: 'agent', agent: 'codex' }
    })
    await vi.waitFor(() => {
      expect(
        db.listDecisionModelAudits({
          runId: db.getRoutingInput(inputId)!.run_id,
          inputId,
          source: 'dedicated_bypass'
        })
      ).toHaveLength(1)
    })
    const trial = db
      .listDecisionModelAudits({
        runId: db.getRoutingInput(inputId)!.run_id,
        inputId,
        source: 'dedicated_bypass'
      })
      .at(0)!
    expect(trial.input_tokens).toBe(55)
    expect(trial.output_tokens).toBe(12)
    expect(JSON.parse(trial.answers_json ?? 'null').actions).toEqual([
      { key: 'a1', type: 'no_action', reason: 'nothing' }
    ])
  })

  it('counts mismatched task bindings separately from missing work', async () => {
    prepareWorkers(true)
    const routed = await submitAndRoute('修登录，另外查启动慢', [
      { key: 'a1', type: 'create_task', instruction: '修登录', agent: 'codex' },
      { key: 'a2', type: 'query_status', target: 'project' }
    ])
    const inputId = routed
    // 期望两项工作并带任务归属；专用侧只产出无归属的修登录——漏启动调查 + 修登录绑错。
    await call('orchestration.routeBypassLabelSet', {
      group,
      input: inputId,
      category: 'composite',
      expected: [
        { type: 'create_task', instruction: '修登录', taskId: 'task_login' },
        { type: 'create_task', instruction: '调查启动慢', taskId: 'task_startup' }
      ]
    })
    const report = await call<{
      summary: { missingWork: number; mismatchedTasks: number }[]
      details: { comparison: { missingWork: string[]; mismatchedTasks: string[] } }[]
    }>('orchestration.routeBypassReport', { group })
    // 多重集合口径：实际 1 个无归属动作对期望 2 个带归属动作——两个期望归属均未满足
    //（missing task_login/task_startup），无归属动作本身计绑错（got none）。
    expect(report.summary[0]).toMatchObject({ missingWork: 2, mismatchedTasks: 1 })
    expect(report.details[0]?.comparison.missingWork).toEqual(['task_login', 'task_startup'])
    // 无归属动作以 instruction 作为身份标记进绑错明细。
    expect(report.details[0]?.comparison.mismatchedTasks).toEqual([
      'create_task: instruction:修登录 is not an expected binding'
    ])
  })

  it('reports dedicated latency percentiles and token totals', async () => {
    prepareWorkers(true)
    const inputId = await submitAndRoute('修登录，另外查启动慢', [
      { key: 'a1', type: 'create_task', instruction: '修登录', agent: 'codex' }
    ])
    const runId = db.getRoutingInput(inputId)!.run_id
    await call('orchestration.routeBypassLabelSet', {
      group,
      input: inputId,
      category: 'single_task',
      expected: [{ type: 'create_task', instruction: '修登录' }]
    })
    // 用固定延迟的旁路 trial 替换真实计时（fire-and-forget 的真实延迟不可控）。
    db.db
      .prepare(
        'UPDATE decision_model_audits SET latency_ms = 200 WHERE run_id = ? AND input_id = ? AND source = ?'
      )
      .run(runId, inputId, 'dedicated_bypass')
    const second = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '再修登录'
    })
    agentRouter.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'create_task', instruction: '再修登录', agent: 'codex' }]
    }))
    bypassFetch.fn.mockImplementation(async () =>
      bypassResponse([{ key: 'a1', type: 'create_task', instruction: '再修登录', agent: 'codex' }])
    )
    await call('orchestration.entryAutoRoute', {
      group,
      input: second.input.input_id,
      dispatch: false,
      decisionModel: { source: 'agent', agent: 'codex' }
    })
    db.db
      .prepare(
        'UPDATE decision_model_audits SET latency_ms = 400 WHERE run_id = ? AND input_id = ? AND source = ?'
      )
      .run(runId, second.input.input_id, 'dedicated_bypass')
    await call('orchestration.routeBypassLabelSet', {
      group,
      input: second.input.input_id,
      category: 'single_task',
      expected: [{ type: 'create_task', instruction: '再修登录' }]
    })
    const report = await call<{
      summary: {
        dedicatedLatency: { p50: number; p95: number }
        dedicatedTokens: { input: number; output: number }
      }[]
    }>('orchestration.routeBypassReport', { group })
    expect(report.summary[0]?.dedicatedLatency).toEqual({ p50: 200, p95: 400 })
    // tokens 合计来自两个 trial 的 usage（120+120 / 30+30）。
    expect(report.summary[0]?.dedicatedTokens).toEqual({ input: 240, output: 60 })
  })

  it('probes a dedicated endpoint through the routing test RPC', async () => {
    prepareWorkers(true)
    vi.stubGlobal('fetch', bypassFetch.fn)
    bypassFetch.fn.mockImplementation(async () =>
      bypassResponse([
        { key: 'a1', type: 'create_task', instruction: '检查登录表单的错误提示', agent: 'codex' }
      ])
    )
    const ok = await call<{ ok: boolean; detail?: string }>('orchestration.entryRoutingTest', {
      source: 'dedicated',
      baseUrl: bypassSettings.baseUrl,
      apiKey: bypassSettings.apiKey,
      modelId: bypassSettings.modelId
    })
    expect(ok.ok).toBe(true)
    const bad = await call<{ ok: boolean; detail?: string }>('orchestration.entryRoutingTest', {
      source: 'dedicated',
      baseUrl: bypassSettings.baseUrl,
      apiKey: bypassSettings.apiKey,
      modelId: bypassSettings.modelId,
      protocol: 'anthropic'
    })
    expect(bad.ok).toBe(false)
  })

  it('evaluates write-gate constraints, status answers, and treats reordered continuations as equivalent', async () => {
    prepareWorkers(true)
    // write_gated：原文带先确认约束，提案产出受限工作（输入只读门保持 → 不违规）。
    const gated = await submitAndRoute('先调查启动慢，等我确认再改', [
      { key: 'a1', type: 'create_task', instruction: '只读调查启动慢', agent: 'codex' }
    ])
    const gatedId = gated
    expect(db.getRoutingInput(gatedId)?.require_write_approval).toBe(1)
    // 纯状态：query_status 目标两侧都应答。
    const status = await submitAndRoute('项目进展如何？', [
      { key: 'a1', type: 'query_status', target: 'project' }
    ])
    const statusId = status
    // 换序等价：两个续接动作按序换位不算绑错/漏工作（同类型按序配对，集合式评估）。
    const reordered = await submitAndRoute('给修登录补回归测试和性能基线', [
      { key: 'a1', type: 'continue_task', taskId: 'task_b', instruction: '性能基线' },
      { key: 'a2', type: 'continue_task', taskId: 'task_a', instruction: '回归测试' }
    ])
    const reorderedId = reordered
    await call('orchestration.routeBypassLabelSet', {
      group,
      input: gatedId,
      category: 'write_gated',
      expected: [{ type: 'create_task', instruction: '只读调查启动慢' }]
    })
    await call('orchestration.routeBypassLabelSet', {
      group,
      input: statusId,
      category: 'status_only',
      expected: [{ type: 'query_status', target: 'project' }]
    })
    await call('orchestration.routeBypassLabelSet', {
      group,
      input: reorderedId,
      category: 'continuation_ambiguous',
      expected: [
        { type: 'continue_task', taskId: 'task_a', instruction: '回归测试' },
        { type: 'continue_task', taskId: 'task_b', instruction: '性能基线' }
      ]
    })
    const report = await call<{
      summary: {
        category: string
        statusAnswered: number
        writeGateViolations: number
        passes: boolean
      }[]
      passes: boolean
      details: {
        category: string
        writeGateRespected: boolean
        comparison: { mismatchedTasks: string[]; missingWork: string[] }
      }[]
      thresholds: { criticalViolationsMustBeZero: string[] }
    }>('orchestration.routeBypassReport', { group })
    const byCategory = Object.fromEntries(report.summary.map((group) => [group.category, group]))
    // 写入约束：标注 write_gated 且原文只读门保持 → 无违规、组达标。
    expect(byCategory['write_gated']?.writeGateViolations).toBe(0)
    expect(byCategory['write_gated']?.passes).toBe(true)
    // 纯状态：query_status 两侧应答。
    expect(byCategory['status_only']?.statusAnswered).toBe(1)
    expect(byCategory['status_only']?.passes).toBe(true)
    // 换序等价：同类型按序配对后归属一致 → 不计绑错/漏工作。
    const reorderedRow = report.details.find((row) => row.category === 'continuation_ambiguous')!
    expect(reorderedRow.comparison.mismatchedTasks).toEqual([])
    expect(reorderedRow.comparison.missingWork).toEqual([])
    // 门槛常量与整体达标可见。
    expect(report.thresholds.criticalViolationsMustBeZero).toEqual([
      'missingWork',
      'mismatchedTasks',
      'writeGateViolations'
    ])
    expect(report.passes).toBe(true)
  })

  it('scrubs echoed credentials from successful bypass proposals before writing to audit', async () => {
    prepareWorkers(true)
    vi.stubGlobal('fetch', bypassFetch.fn)
    // 端点返回有效 no_action 但 reason 回显配置密钥。
    bypassFetch.fn.mockImplementation(
      async () =>
        ({
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    version: 1,
                    actions: [
                      {
                        key: 'a1',
                        type: 'no_action',
                        reason: `no action needed for key ${bypassSettings.apiKey} at ${bypassSettings.baseUrl}`
                      }
                    ]
                  })
                }
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 }
          })
        }) as unknown as Response
    )
    agentRouter.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'create_task', instruction: '修登录', agent: 'codex' }]
    }))
    const input = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '修登录'
    })
    await call('orchestration.entryAutoRoute', {
      group,
      input: input.input.input_id,
      dispatch: false,
      decisionModel: { source: 'agent', agent: 'codex' }
    })
    await vi.waitFor(() => {
      expect(
        db.listDecisionModelAudits({
          runId: db.getRoutingInput(input.input.input_id)!.run_id,
          inputId: input.input.input_id,
          source: 'dedicated_bypass'
        })
      ).toHaveLength(1)
    })
    const trial = db
      .listDecisionModelAudits({
        runId: db.getRoutingInput(input.input.input_id)!.run_id,
        inputId: input.input.input_id,
        source: 'dedicated_bypass'
      })
      .at(0)!
    expect(trial.outcome).toBe('classified')
    // 提案 JSON 已脱敏：reason 中的凭据与端点地址替换为占位符。
    const proposal = JSON.parse(trial.answers_json ?? 'null') as { actions: { reason: string }[] }
    expect(proposal.actions[0]?.reason).not.toContain('synthetic-dedicated-key')
    expect(proposal.actions[0]?.reason).not.toContain('https://dedicated.example/v1')
    expect(proposal.actions[0]?.reason).toContain('\u2022\u2022\u2022\u2022')
    // routeBypassTrialList RPC 也不泄漏。
    const trials = await call<{ trials: { proposal: { actions: { reason: string }[] } }[] }>(
      'orchestration.routeBypassTrialList',
      { group }
    )
    const rpcProposal = trials.trials[0]?.proposal
    expect(rpcProposal?.actions[0]?.reason).not.toContain('synthetic-dedicated-key')
    expect(rpcProposal?.actions[0]?.reason).toContain('\u2022\u2022\u2022\u2022')
  })

  it('scrubs quoted keys from bypass proposals at the object level before JSON serialization', async () => {
    prepareWorkers(true)
    vi.stubGlobal('fetch', bypassFetch.fn)
    // 含双引号的配置密钥：JSON.stringify 后会变成 \" 转义——字符串 split/join 无法匹配。
    const quotedKey = 'sk-"quoted"-key-123'
    const endpointOverride = { apiKey: quotedKey, baseUrl: 'https://quoted.example/v1' }
    const settingsWithQuotedKey = {
      defaultTuiAgent: 'codex' as const,
      nativeChatProviders: {},
      routeBypass: {
        enabled: true,
        baseUrl: endpointOverride.baseUrl,
        apiKey: quotedKey,
        modelId: 'quoted-fast',
        protocol: 'openai' as const
      }
    }
    const repo = storeRepo({ id: group, path: '/fixture/project', kind: 'git' })
    const state = h.setup(
      false,
      partialRuntimeStore({ getRepos: () => [repo], getSettings: () => settingsWithQuotedKey })
    )
    db = state.db
    ctx = { ...state.ctx, caller: { kind: 'desktop' } }
    agentRouter.fn.mockImplementation(async () => ({
      version: 1,
      actions: [{ key: 'a1', type: 'create_task', instruction: '修登录', agent: 'codex' }]
    }))
    bypassFetch.fn.mockImplementation(
      async () =>
        ({
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    version: 1,
                    actions: [
                      {
                        key: 'a1',
                        type: 'no_action',
                        reason: `no action needed, auth key was ${quotedKey}`
                      }
                    ]
                  })
                }
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 }
          })
        }) as unknown as Response
    )
    const input = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '修登录'
    })
    await call('orchestration.entryAutoRoute', {
      group,
      input: input.input.input_id,
      dispatch: false,
      decisionModel: { source: 'agent', agent: 'codex' }
    })
    await vi.waitFor(() => {
      expect(
        db.listDecisionModelAudits({
          runId: db.getRoutingInput(input.input.input_id)!.run_id,
          inputId: input.input.input_id,
          source: 'dedicated_bypass'
        })
      ).toHaveLength(1)
    })
    const trial = db
      .listDecisionModelAudits({
        runId: db.getRoutingInput(input.input.input_id)!.run_id,
        inputId: input.input.input_id,
        source: 'dedicated_bypass'
      })
      .at(0)!
    expect(trial.outcome).toBe('classified')
    // 含引号的密钥在对象层脱敏后被替换——审计 JSON 中不含原始值。
    const answersStr = trial.answers_json ?? ''
    expect(answersStr).not.toContain(quotedKey)
    expect(answersStr).toContain('\u2022\u2022\u2022\u2022')
    // RPC 查询同样脱敏。
    const trials = await call<{ trials: { proposal: unknown }[] }>(
      'orchestration.routeBypassTrialList',
      { group }
    )
    expect(JSON.stringify(trials.trials[0]?.proposal)).not.toContain(quotedKey)
  })
})
