import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import { recordEntryRoutingError } from './entry-assignment-errors'
import { entryTaskStatusAnswer } from './entry-results'
import { createAgentRouteProposalProvider } from '../../../orchestration/routing/agent-route-proposal-provider'
import { startRouteBypassTrial } from './entry-bypass-trial'
import {
  ROUTE_PROPOSAL_VERSION,
  parseRouteProposal,
  type RouteProposalV1
} from '../../../orchestration/routing/route-proposal'
import {
  deletedRoutingTasks,
  planningTemplateSubActions,
  routeRoutingInput,
  type RoutedDecision,
  type RoutingDecisionContext,
  type RoutingDecisionProposal,
  type RoutingDecisionProvider
} from '../../../orchestration/routing/routing-router'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import type { RunRow } from '../../../orchestration/db/orchestration-records'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { DecisionModelSettings } from '../../../../../shared/settings/decision-model-settings'

// Agent 单次路由（统一动作协议 v1，首版默认）：一次 Agent 调用产出动作批，Orca 逐项裁决——
// 从实际送出的候选快照校验任务引用，从账本生成状态答案，把 create_task/continue_task 落成
// 子动作、clarify 落成待澄清项、无效目标只挂起相关动作。派发仍由入口的共享尾部处理。

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

export type RouteQueryOutcome = { key: string; target: string; answer: string }
export type RouteClarificationItem = {
  key: string
  question: string
  taskId?: string
  about?: string
}

/** 执行前复核任务在当前项目的归属与可用状态：路由可能在候选快照生成后失效（软删除/归属
 *  变化）——快照只证明发送当时的资格，登记与派发以账本现状为准。 */
function routeTargetInvalidated(db: OrchestrationDb, runId: string, taskId: string): boolean {
  const task = db.getTask(taskId)
  if (!task || task.run_id !== runId) {
    return true
  }
  return deletedRoutingTasks(db, runId).has(taskId)
}

/** 同一请求可同时产生查询结果和工作动作：查询答案与待澄清项进决定（decision_json）与
 * reason，工作动作照常登记。目标越界的查询/续接只降级为该动作的待澄清——独立且有效的
 * 其他动作不受影响。规划模板的阶段行必须排在子动作数组最前（模板内部 dependsOn 是相对序号）。 */
export function adjudicateRouteProposal(
  db: OrchestrationDb,
  runId: string,
  rawProposal: RouteProposalV1,
  context: RoutingDecisionContext
): RoutingDecisionProposal {
  // 结构门在裁决入口重过一遍：版本未知、重复键、no_action 不单独出现等结构性错误在登记前
  // 拒绝（provider 解析之外的第二道防线——任何来源的提案都不绕过）。
  const proposal = parseRouteProposal(rawProposal)
  const candidates = new Map(context.candidateTasks.map((task) => [task.taskId, task]))
  const queries: RouteQueryOutcome[] = []
  const clarifications: RouteClarificationItem[] = []
  const subActions: RoutingDecisionProposal['subActions'] = []
  let noActionReason: string | undefined
  // 复合请求可含多个 planning 动作（§任务拆解）：每个动作各自展开阶段链并保留自包含
  // 指令，链与链之间互不合并——单变量会静默丢弃前面的规划请求。
  const planningRequests: { instruction: string; prototype: boolean; clarification: boolean }[] = []
  for (const action of proposal.actions) {
    switch (action.type) {
      case 'query_status': {
        if (action.target === 'project') {
          queries.push({
            key: action.key,
            target: 'project',
            answer: context.statusDigest ?? '当前没有进行中的任务记录。'
          })
        } else if (!candidates.has(action.target)) {
          clarifications.push({
            key: action.key,
            question:
              '要查询的任务无法在当前项目里定位。请指明要查询的任务，或查看各任务卡片的进展。',
            about: 'query_status'
          })
        } else if (routeTargetInvalidated(db, runId, action.target)) {
          // 快照内但路由期间失效：该查询进入待澄清，同批其他动作不受影响。
          clarifications.push({
            key: action.key,
            question:
              '要查询的任务已失效或不在当前项目里。请指明要查询的任务，或查看各任务卡片的进展。',
            about: 'query_status'
          })
        } else {
          const answer =
            entryTaskStatusAnswer(db, runId, action.target) ??
            `「${candidates.get(action.target)?.spec ?? action.target}」：尚无进展记录。`
          queries.push({ key: action.key, target: action.target, answer })
        }
        break
      }
      case 'continue_task': {
        // 执行前复核：越界/失效目标只降级为该动作的待澄清；可续接还要求任务在本 Run 里有
        // 可接收的派发（无派发同样只挂起这一项——投递层的暂停/拒收语义保持不变）。
        if (!candidates.has(action.taskId)) {
          clarifications.push({
            key: action.key,
            question: '要续接的任务无法在当前项目里定位。请指明要续接的任务。',
            about: 'continue_task'
          })
        } else if (routeTargetInvalidated(db, runId, action.taskId)) {
          clarifications.push({
            key: action.key,
            question: '要续接的任务已失效或不在当前项目里。请指明要续接的任务。',
            about: 'continue_task'
          })
        } else {
          const dispatch = db.getDispatchContext(action.taskId)
          if (dispatch && dispatch.run_id === runId) {
            subActions.push({ text: action.instruction, taskId: action.taskId })
          } else {
            clarifications.push({
              key: action.key,
              question:
                '要续接的任务当前没有进行中的会话。请改用新任务提交，或等任务恢复后再续接。',
              about: 'continue_task'
            })
          }
        }
        break
      }
      case 'create_task': {
        if (action.planning === true) {
          planningRequests.push({
            instruction: action.instruction,
            prototype: action.prototype === true,
            clarification: action.clarification !== false
          })
        } else {
          subActions.push({
            text: action.instruction,
            ...(action.agent ? { agent: action.agent } : {})
          })
        }
        break
      }
      case 'clarify': {
        clarifications.push({
          key: action.key,
          question: action.question,
          ...(action.taskId && candidates.has(action.taskId) ? { taskId: action.taskId } : {}),
          ...(action.about ? { about: action.about } : {})
        })
        break
      }
      case 'no_action': {
        noActionReason = action.reason
        break
      }
    }
  }
  const reason = [
    noActionReason,
    ...queries.map((query) =>
      query.target === 'project' ? `项目进展：${query.answer}` : `当前进展：${query.answer}`
    ),
    ...clarifications.map((item) => `待澄清：${item.question}`)
  ]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join('\n')
  // 每个规划动作各自展开阶段链（自包含指令即该链的需求原文）；模板的 dependsOn 是链内
  // 相对序号，拼入同一批次时按「该链起始行号」偏移，链与链的依赖各自闭合、互不串链。
  const planningStages: RoutingDecisionProposal['subActions'] = []
  let chainOffset = 0
  for (const request of planningRequests) {
    const chain = planningTemplateSubActions(
      request.instruction,
      request.prototype,
      request.clarification
    )
    for (const stage of chain) {
      if (stage.dependsOn) {
        stage.dependsOn = stage.dependsOn.map((edge) =>
          typeof edge === 'number' ? edge + chainOffset : edge
        )
      }
      planningStages.push(stage)
    }
    chainOffset += chain.length
  }
  return {
    subActions: [...planningStages, ...subActions],
    ...(reason ? { reason } : {}),
    decision: {
      strategy: 'unified_agent',
      protocolVersion: ROUTE_PROPOSAL_VERSION,
      queries,
      clarifications,
      actionTypes: proposal.actions.map((action) => action.type),
      // 实际发送的候选快照原样留存（含 spec/status）——回放与审计都以它为准。
      candidateSnapshot: context.candidateTasks
    }
  }
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
  statusDigest?: string,
  /** 测试注入短超时；生产固定 70s（CLI 一次调用上限的余量）。 */
  timeoutMs = UNIFIED_ROUTE_TIMEOUT_MS
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
    statusDigest,
    timeoutMs,
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
