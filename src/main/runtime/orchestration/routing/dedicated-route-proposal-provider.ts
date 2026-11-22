import { UNIFIED_ROUTE_SYSTEM_PROMPT, routeUserContent } from './agent-route-proposal-provider'
import {
  fetchDecisionCompletionDetailed,
  type ModelDecisionProviderConfig
} from './model-decision-provider'
import { parseRouteProposalContent, type RouteProposalV1 } from './route-proposal'
import type { RoutingDecisionContext } from './routing-router'

// 专用决策模型旁路（entry-intent-routing-design §专用决策模型旁路验收）：同一份统一动作
// 协议（与 Agent Router 相同的 system prompt 与 user 切分，保证对照公平），换一个
// completion 端点直接产出 RouteProposalV1。只用于旁路对照评估——实际路由继续走已验收的
// Agent Router；端点失败或输出无效只进对照记录，不影响任何执行路径。

export type DedicatedRouteProposalProviderConfig = ModelDecisionProviderConfig

export type DedicatedRouteProposal = RouteProposalV1 & {
  inputTokens?: number
  outputTokens?: number
}

export function createDedicatedRouteProposalProvider(
  config: DedicatedRouteProposalProviderConfig
): (context: RoutingDecisionContext) => Promise<DedicatedRouteProposal> {
  return async (context: RoutingDecisionContext) => {
    const completion = await fetchDecisionCompletionDetailed(
      config,
      UNIFIED_ROUTE_SYSTEM_PROMPT,
      routeUserContent(context)
    )
    const proposal = parseRouteProposalContent(completion.content)
    return {
      ...proposal,
      ...(completion.inputTokens !== undefined ? { inputTokens: completion.inputTokens } : {}),
      ...(completion.outputTokens !== undefined ? { outputTokens: completion.outputTokens } : {})
    }
  }
}
