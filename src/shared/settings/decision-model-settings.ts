import type { NativeChatWidth } from '../native-chat/settings/native-chat-appearance-settings'

/** The 任务路由方式 the 任务入口 auto-routes with (entry-intent-routing-design): the unified
 *  single-pass action protocol (RouteProposalV1) proposed by an installed coding agent in one
 *  call per attempt. Legacy sources (intent hybrid / custom model / structured decisions
 *  service) were removed with the unified router — their stored shapes normalize to this. */
export type DecisionModelSettings = {
  source: 'agent'
  /** The installed agent that proposes the route; absent means the first installed one. */
  agent?: string
}

export const DEFAULT_DECISION_MODEL_SETTINGS: DecisionModelSettings = {
  source: 'agent'
}

/** Map settings saved by older builds onto the agent-only schema (idempotent): the retired
 *  zcode-plan source, the flat `intent_agent` shape (splitAgent was its routing agent), and
 *  the two-block custom/decisions/intent shapes all collapse to the unified agent router. */
export function normalizeDecisionModelSettings(
  raw:
    | {
        source?: string
        agent?: string
        splitAgent?: string
      }
    | undefined
): DecisionModelSettings | undefined {
  if (!raw) {
    return raw
  }
  const agent =
    raw.source === 'intent_agent'
      ? (raw.splitAgent || raw.agent || '').trim() || undefined
      : (raw.source === 'agent' ? (raw.agent ?? '') : '').trim() || undefined
  return { source: 'agent', ...(agent ? { agent } : {}) }
}

export type DispatchEntrySettings = {
  /** The 任务路由方式 the 任务入口's routing step uses for auto-routing. */
  decisionModel?: DecisionModelSettings
  dispatchEntryAutoRoute?: Record<string, boolean>
  /** 专用决策模型旁路对照（entry-intent-routing-design §专用决策模型旁路验收）：评估期
   *  与已验收的 Agent Router 对同一批请求各调用一次，结果只进对照评估——实际路由不变。
   *  独立字段组，与 decisionModel 互不共用。 */
  routeBypass?: RouteBypassSettings
  /** Transcript and composer width in Task Entry. Absent means wide. */
  dispatchEntryWidth?: NativeChatWidth
  /** Per-card seen markers for the 任务入口's unread dots: projectKey → subActionId → the
   *  execution marker (completedAt) last seen. */
  dispatchEntrySeenResults?: Record<string, Record<string, string>>
}

/** 专用决策模型端点（旁路对照评估用）：direct RouteProposalV1 output over an OpenAI-
 *  compatible or Anthropic-compatible completion endpoint. */
export type RouteBypassSettings = {
  enabled: boolean
  baseUrl?: string
  apiKey?: string
  modelId?: string
  protocol?: 'openai' | 'anthropic'
}

export const DEFAULT_ROUTE_BYPASS_SETTINGS: RouteBypassSettings = { enabled: false }

/** Fill defaults for stored partial shapes (idempotent); trims whitespace on identity fields. */
export function normalizeRouteBypassSettings(
  raw: Partial<RouteBypassSettings> | undefined
): RouteBypassSettings {
  const baseUrl = raw?.baseUrl?.trim() || undefined
  const apiKey = raw?.apiKey?.trim() || undefined
  const modelId = raw?.modelId?.trim() || undefined
  const protocol = raw?.protocol === 'anthropic' ? 'anthropic' : 'openai'
  return {
    enabled: raw?.enabled === true,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(modelId ? { modelId } : {}),
    protocol
  }
}
