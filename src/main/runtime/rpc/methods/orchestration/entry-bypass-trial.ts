import { createDedicatedRouteProposalProvider } from '../../../orchestration/routing/dedicated-route-proposal-provider'
import { ROUTE_PROPOSAL_VERSION } from '../../../orchestration/routing/route-proposal'
import type { RoutingDecisionContext } from '../../../orchestration/routing/routing-router'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../orca-runtime'

/** 递归脱敏提案对象中的所有字符串值：在 JSON.stringify 之前修改对象，规避转义字符
 *  匹配失败。协议结构字段（version/actions/type/key/taskId）保持不变，只替换文本值。 */
function sanitizeProposalStrings(proposal: unknown, secrets: string[]): unknown {
  if (typeof proposal === 'string') {
    let result = proposal
    for (const secret of secrets) {
      if (secret) {
        result = result.split(secret).join('\u2022\u2022\u2022\u2022')
      }
    }
    return result
  }
  if (Array.isArray(proposal)) {
    return proposal.map((item) => sanitizeProposalStrings(item, secrets))
  }
  if (proposal !== null && typeof proposal === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(proposal)) {
      result[key] = sanitizeProposalStrings(value, secrets)
    }
    return result
  }
  return proposal
}

/** 专用决策模型旁路对照 trial（评估专用）：fire-and-forget——每次路由尝试最多调用一次专用
 *  端点（幂等键是审计行本身：同 input 已有 dedicated_bypass 行则跳过），端点失败或输出无效
 *  都落 dedicated_bypass 审计行供报告统计。凭据与端点错误详情不进审计（错误只记消息）。 */
export function startRouteBypassTrial(
  db: OrchestrationDb,
  runtime: OrcaRuntimeService,
  target: { runId: string; inputId: string; context?: RoutingDecisionContext }
): void {
  const existing = db.listDecisionModelAudits({
    runId: target.runId,
    inputId: target.inputId,
    source: 'dedicated_bypass',
    limit: 1
  })
  if (existing.length > 0) {
    return
  }
  const config = runtime.requireStore().getSettings().routeBypass
  if (
    !config?.enabled ||
    !config.baseUrl?.trim() ||
    !config.apiKey?.trim() ||
    !config.modelId?.trim()
  ) {
    return
  }
  const endpointConfig = {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl.trim(),
    modelId: config.modelId.trim(),
    ...(config.protocol ? { protocol: config.protocol } : {})
  }
  void (async () => {
    const startedAt = Date.now()
    try {
      if (!target.context) {
        throw new Error('no routing context captured for the bypass trial')
      }
      const rawProposal = await createDedicatedRouteProposalProvider(endpointConfig)(target.context)
      // 逐字段脱敏（在 JSON.stringify 之前修改对象，规避转义字符匹配失败）：
      // reason 等文本字段可能回显端点配置密钥或含引号的密钥——在对象层替换后序列化，
      // 保留对照评估所需的结构化信息（version/actions/type/key 等）。
      const secrets = [endpointConfig.apiKey, endpointConfig.baseUrl].filter(Boolean)
      const sanitizedProposal = sanitizeProposalStrings(rawProposal, secrets) as typeof rawProposal
      db.recordDecisionModelAudit({
        runId: target.runId,
        inputId: target.inputId,
        source: 'dedicated_bypass',
        model: endpointConfig.modelId,
        outcome: 'classified',
        latencyMs: Date.now() - startedAt,
        inputTokens: sanitizedProposal.inputTokens,
        outputTokens: sanitizedProposal.outputTokens,
        answers: sanitizedProposal,
        applied: {
          protocolVersion: ROUTE_PROPOSAL_VERSION,
          actions: sanitizedProposal.actions.map((action) => action.type)
        }
      })
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error)
      for (const secret of [endpointConfig.apiKey, endpointConfig.baseUrl]) {
        if (secret) {
          message = message.split(secret).join('\u2022\u2022\u2022\u2022')
        }
      }
      message = message.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1\u2022\u2022\u2022\u2022')
      db.recordDecisionModelAudit({
        runId: target.runId,
        inputId: target.inputId,
        source: 'dedicated_bypass',
        model: endpointConfig.modelId,
        outcome: 'error',
        latencyMs: Date.now() - startedAt,
        errorMessage: message.slice(0, 300),
        applied: { protocolVersion: ROUTE_PROPOSAL_VERSION }
      })
    }
  })()
}
