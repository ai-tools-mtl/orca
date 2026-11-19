/** The 决策模型 the 任务入口 auto-routes with (plan §5.1): the user's own ZCode coding plan
 *  credential, or any OpenAI-compatible chat-completions provider. */
export type DecisionModelSettings = {
  provider: 'zcode-plan' | 'custom'
  /** custom only: an OpenAI-compatible chat-completions base URL. */
  baseUrl?: string
  /** custom only: the bearer key for that endpoint. */
  apiKey?: string
  /** custom only: the model id to request. */
  modelId?: string
}
