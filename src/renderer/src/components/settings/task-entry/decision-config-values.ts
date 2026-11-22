import {
  DEFAULT_DECISION_MODEL_SETTINGS,
  normalizeDecisionModelSettings,
  type DecisionModelSettings
} from '../../../../../shared/settings/decision-model-settings'

export type RouteConfig = DecisionModelSettings

export function routeConfigOf(config: RouteConfig): RouteConfig {
  return { source: 'agent', ...(config.agent ? { agent: config.agent } : {}) }
}

export function savedDecisionConfig(config?: DecisionModelSettings): DecisionModelSettings {
  return normalizeDecisionModelSettings(config) ?? DEFAULT_DECISION_MODEL_SETTINGS
}
