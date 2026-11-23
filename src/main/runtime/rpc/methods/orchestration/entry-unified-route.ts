import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import { recordEntryRoutingError } from './entry-assignment-errors'
import { createAgentRouteProposalProvider } from '../../../orchestration/routing/agent-route-proposal-provider'
import { startRouteBypassTrial } from './entry-bypass-trial'
import { adjudicateRouteProposal } from './entry-route-adjudication'
import { ROUTE_PROPOSAL_VERSION } from '../../../orchestration/routing/route-proposal'
import {
  routeRoutingInput,
  type RoutedDecision,
  type RoutingDecisionContext,
  type RoutingDecisionProvider
} from '../../../orchestration/routing/routing-router'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import type { RunRow } from '../../../orchestration/db/orchestration-records'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { DecisionModelSettings } from '../../../../../shared/settings/decision-model-settings'

// Agent 单次路由（统一动作协议 v1，首版默认）：解析已配置的 Agent、一次调用产出动作批并落
// 审计；动作批的逐项裁决在 entry-route-adjudication.ts。派发仍由入口的共享尾部处理。

const UNIFIED_ROUTE_TIMEOUT_MS = 70_000

/** Unset falls to the first installed agent (the source's "已安装" promise); an explicit but
 *  unknown id is a stale config and errors instead of silently re-picking. */
export function resolveEntryRoutingAgent(
  configuredAgent: string | undefined,
  agents: readonly string[]
): TuiAgent | undefined {
  if (configuredAgent === undefined) {
    return agents.find(isTuiAgent) ?? 'codex'
  }
  return isTuiAgent(configuredAgent) ? configuredAgent : undefined
}

/** 入口 Agent 单次路由分支：解析已配置的 Agent（未设置回退首个已安装；显式未知 id 报错）、
 *  以统一协议 provider 路由一次，并为实际发生的这次调用落审计（协议版本、耗时、动作类型、
 *  实际结果；凭据与 Worker 报告全文不进审计）。 */
export async function autoRouteUnifiedAgentFromEntry(
  db: OrchestrationDb,
  runtime: OrcaRuntimeService,
  params: { input: string; decisionModel: DecisionModelSettings | undefined },
  run: RunRow,
  executorCapabilities: readonly string[],
  options: {
    /** 确定性进展摘要（状态查询的回答来源）。 */
    statusDigest?: string
    /** 本 Run 最近几条输入及裁决（会话连续性参考）。 */
    recentTurns?: { text: string; outcome: string }[]
    /** 测试注入短超时；生产固定 70s（CLI 一次调用上限的余量）。 */
    timeoutMs?: number
  } = {}
): Promise<RoutedDecision> {
  const configuredAgent = params.decisionModel?.agent
  const agent = resolveEntryRoutingAgent(configuredAgent, executorCapabilities)
  if (!agent) {
    const reason = `任务路由 Agent「${configuredAgent}」不支持任务路由；输入保持待路由`
    recordEntryRoutingError(db, params.input, reason)
    return { routed: false, reused: false, reason, subActions: [] }
  }
  let attempted: { latencyMs: number; actionTypes: string[] } | undefined
  let routedContext: RoutingDecisionContext | undefined
  // 失败审计已落（provider 异常或 route 层超时）——迟到返回/迟到抛错不再重复写入。
  let failureAudited = false
  /** 外部异常映射为安全错误类别和摘要：不透传原始错误内容（可能含凭据、授权头或
   *  JSON 序列化的 headers），只保留 HTTP 状态码和错误类别供调参参考。 */
  const sanitizeRoutingError = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('timed out')) {
      return 'router timed out; the input stays retryable'
    }
    const statusMatch = message.match(/returned (\d{3})/)
    if (statusMatch) {
      return `routing endpoint returned HTTP ${statusMatch[1]}`
    }
    if (message.includes('ECONNREFUSED') || message.includes('ECONNRESET')) {
      return 'routing endpoint is unreachable'
    }
    return 'routing source failed; the input stays retryable'
  }
  const auditRouteFailure = (latencyMs: number, message: string): void => {
    failureAudited = true
    db.recordDecisionModelAudit({
      runId: run.id,
      inputId: params.input,
      source: 'agent_router',
      outcome: 'error',
      latencyMs,
      errorMessage: message,
      applied: { protocolVersion: ROUTE_PROPOSAL_VERSION, branch: 'route', failed: true }
    })
  }
  const cwd = runtime.requireStore().getSettings().workspaceDir || process.cwd()
  // One-shot CLI generation can run to its 60s cap; the 70s router cutoff spares the tail.
  const provider: RoutingDecisionProvider = async (context) => {
    const startedAt = Date.now()
    try {
      // 运行时参数惰性解析（与混合拆分者的 resolveRuntime 同法）：store 缺失等来源侧故障落在
      // routeRoutingInput 的 provider 捕获里，按「来源不可用」保持待路由，不让入口抛错。
      const settings = runtime.requireStore().getSettings()
      const proposal = await createAgentRouteProposalProvider({
        agent,
        cwd,
        ensureStructuredHost: () => runtime.ensureStructuredAgentSessionHost(),
        agentCommandOverride: settings.agentCmdOverrides?.[agent]?.trim()
      })(context)
      attempted = {
        latencyMs: Date.now() - startedAt,
        actionTypes: proposal.actions.map((action) => action.type)
      }
      routedContext = context
      return adjudicateRouteProposal(db, run.id, proposal, context)
    } catch (error) {
      // 来源调用失败（无效 JSON / 未知版本 / 来源抛错）：错误经 routeRoutingInput 转为
      // 「来源不可用」的可重试待路由状态，同时为这次实际调用落失败审计与耗时。
      // 路由层超时先行审计过（failureAudited）时，来源的迟到异常不再重复写入。
      if (!failureAudited) {
        auditRouteFailure(Date.now() - startedAt, sanitizeRoutingError(error))
      }
      // 抛出脱敏后的错误：routeRoutingInput 构造的 reason（入口 entry_error）不含凭据。
      throw new Error(sanitizeRoutingError(error))
    }
  }
  const decision = await routeRoutingInput(db, {
    inputId: params.input,
    executorCapabilities,
    statusDigest: options.statusDigest,
    recentTurns: options.recentTurns,
    timeoutMs: options.timeoutMs ?? UNIFIED_ROUTE_TIMEOUT_MS,
    provider
  })
  if (!attempted && !failureAudited && !decision.routed) {
    // route 层失败（来源超时或调度不可用）：立即写恰好一条失败审计与耗时。
    // 来源在超时后才返回或抛错的结果被丢弃（不登记迟到的决定），迟到异常也不再
    // 重复写审计（failureAudited 已置位）。
    auditRouteFailure(
      UNIFIED_ROUTE_TIMEOUT_MS,
      decision.reason?.startsWith('router unavailable')
        ? 'router timed out; the input stays retryable'
        : (decision.reason ?? 'router unavailable').slice(0, 300)
    )
  }
  if (attempted && !failureAudited) {
    db.recordDecisionModelAudit({
      runId: run.id,
      inputId: params.input,
      source: 'agent_router',
      outcome: decision.routed ? 'classified' : 'error',
      latencyMs: attempted.latencyMs,
      ...(decision.routed ? {} : { errorMessage: decision.reason?.slice(0, 300) }),
      applied: {
        protocolVersion: ROUTE_PROPOSAL_VERSION,
        branch: 'route',
        actions: attempted.actionTypes,
        routed: decision.routed,
        registeredActions: decision.routed ? decision.subActions.length : 0
      }
    })
    // 专用决策模型旁路对照（评估）：主路由落定后对同一批输入各调用一次专用端点，结果只进
    // 对照评估——不阻塞主链路返回，失败或无效输出只落审计行（不重试、不影响任何执行路径）。
    startRouteBypassTrial(db, runtime, {
      runId: run.id,
      inputId: params.input,
      ...(routedContext ? { context: routedContext } : {})
    })
  }
  return decision
}
