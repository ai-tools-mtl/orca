import { z } from 'zod'

// One completion round trip against a decision endpoint. Consumers: the 循环开发 reviewer
// pick (plain content) and the 专用决策模型旁路对照 (detailed: token usage for the
// per-request cost metrics).

export type ModelDecisionProviderConfig = {
  apiKey: string
  baseUrl: string
  modelId: string
  protocol?: 'openai' | 'anthropic'
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

export type DecisionCompletion = {
  content: string
  /** Prompt tokens from the endpoint's usage block, when it reports one. */
  inputTokens?: number
  /** Completion tokens from the endpoint's usage block, when it reports one. */
  outputTokens?: number
}

const completionEnvelopeSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }) }).catchall(z.unknown()))
    .min(1)
})

const anthropicEnvelopeSchema = z.object({
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }).catchall(z.unknown()))
    .min(1)
})

const usageSchema = z
  .object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional()
  })
  .catchall(z.unknown())

function usageOf(payload: unknown): { inputTokens?: number; outputTokens?: number } {
  // Both protocols report the usage block at the payload's top-level `usage` field.
  const usage = usageSchema.safeParse(
    payload !== null && typeof payload === 'object' && 'usage' in payload
      ? (payload as { usage: unknown }).usage
      : payload
  ).data
  if (!usage) {
    return {}
  }
  return {
    // openai names prompt/completion; anthropic names input/output.
    ...(usage.prompt_tokens !== undefined ? { inputTokens: usage.prompt_tokens } : {}),
    ...(usage.input_tokens !== undefined ? { inputTokens: usage.input_tokens } : {}),
    ...(usage.completion_tokens !== undefined ? { outputTokens: usage.completion_tokens } : {}),
    ...(usage.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {})
  }
}

/** Protocols: openai chat-completions and the Anthropic messages API. */
export async function fetchDecisionCompletionDetailed(
  config: ModelDecisionProviderConfig,
  systemPrompt: string,
  userContent: string
): Promise<DecisionCompletion> {
  const fetchImpl = config.fetchImpl ?? fetch
  const response =
    config.protocol === 'anthropic'
      ? await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
          method: 'POST',
          headers: {
            'x-api-key': config.apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: config.modelId,
            max_tokens: 2048,
            temperature: 0,
            system: systemPrompt,
            messages: [{ role: 'user', content: userContent }]
          })
        })
      : await fetchImpl(
          `${config.baseUrl.replace(/\/+$/, '')}${
            config.protocol === 'openai' ? '/chat/completions' : '/api/paas/v4/chat/completions'
          }`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: config.modelId,
              temperature: 0,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent }
              ]
            })
          }
        )
  if (!response.ok) {
    throw new Error(`decision model returned ${response.status}`)
  }
  const payload: unknown = await response.json()
  const usage = usageOf(payload)
  if (config.protocol === 'anthropic') {
    const envelope = anthropicEnvelopeSchema.safeParse(payload)
    const content = envelope.success
      ? envelope.data.content
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('')
      : undefined
    if (!content) {
      throw new Error('decision model returned no content')
    }
    return { content, ...usage }
  }
  const envelope = completionEnvelopeSchema.safeParse(payload)
  const content = envelope.success ? envelope.data.choices[0]?.message.content : undefined
  if (content === undefined) {
    throw new Error('decision model returned no content')
  }
  return { content, ...usage }
}

/** Plain-content variant kept for the 循环开发 reviewer pick. */
export async function fetchDecisionCompletion(
  config: ModelDecisionProviderConfig,
  systemPrompt: string,
  userContent: string
): Promise<string> {
  return (await fetchDecisionCompletionDetailed(config, systemPrompt, userContent)).content
}
