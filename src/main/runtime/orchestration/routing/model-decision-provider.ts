import { z } from 'zod'
import { routeRoutingInput, type RoutingDecisionProvider } from './routing-router'
import type { OrchestrationDb } from '../db/orchestration-db'

/** The credential a decision provider routes with — the ok shape plus any unavailable reason. */
export type ModelCredential =
  | { status: 'ok'; apiKey: string; baseUrl: string; modelId: string }
  | { status: 'absent' | 'error' | 'unavailable' }

// Plan §5.1's model-backed decision provider: the desktop's own coding-plan credential calls the
// plan site's chat completions endpoint, proposing sub-actions over the received input. The
// Router still validates (candidate task refs, sub-action presence) and registers atomically —
// the model proposes, Orca decides.

export type ModelDecisionProviderConfig = {
  apiKey: string
  baseUrl: string
  modelId: string
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

const DECISION_SYSTEM_PROMPT = `You are the routing step of a work dispatcher (plan §5.1). Split the user's request into independent sub-actions. Reply with ONLY a JSON object:
{"subActions":[{"text":"...","taskId":"<candidate id if the request names that existing task>"}],"reason":"..."}
Rules: each sub-action text is a self-contained instruction in the user's language; requests that name several targets split into one sub-action per target; dependent steps stay in ONE sub-action with the order stated; reference a candidate taskId only when the request clearly names that task; reply {"subActions":[],"reason":"..."} when nothing needs doing. At most six sub-actions.`

const decisionReplySchema = z.object({
  subActions: z.array(
    z
      .object({
        text: z.string().trim().min(1),
        taskId: z.string().trim().min(1).optional()
      })
      .transform((entry) => ({ text: entry.text, taskId: entry.taskId }))
  ),
  reason: z.string().trim().optional()
})

const completionEnvelopeSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }) }).catchall(z.unknown()))
    .min(1)
})

/** Models fence JSON even when told not to; the outermost object is the reply. */
function parseDecisionContent(content: string): {
  subActions: { text: string; taskId?: string | null }[]
  reason?: string
} {
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('decision model replied without a JSON object')
  }
  const reply = decisionReplySchema.parse(JSON.parse(content.slice(start, end + 1)))
  return {
    subActions: reply.subActions,
    ...(reply.reason !== undefined ? { reason: reply.reason } : {})
  }
}

export function createModelDecisionProvider(
  config: ModelDecisionProviderConfig
): RoutingDecisionProvider {
  const fetchImpl = config.fetchImpl ?? fetch
  return async (context) => {
    const response = await fetchImpl(`${config.baseUrl}/api/paas/v4/chat-completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.modelId,
        temperature: 0,
        messages: [
          { role: 'system', content: DECISION_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              `请求：${context.text}`,
              context.candidateTasks.length > 0
                ? `候选任务：${context.candidateTasks
                    .map((task) => `${task.taskId}（${task.spec}，${task.status}）`)
                    .join('；')}`
                : '候选任务：无',
              `执行者能力：${context.executorCapabilities.join('、') || '未声明'}`
            ].join('\n')
          }
        ]
      })
    })
    if (!response.ok) {
      return {
        subActions: [],
        reason: `decision model returned ${response.status}; the input stays received`
      }
    }
    const envelope = completionEnvelopeSchema.safeParse(await response.json())
    const content = envelope.success ? envelope.data.choices[0]?.message.content : undefined
    if (content === undefined) {
      return { subActions: [], reason: 'decision model returned no content' }
    }
    try {
      return parseDecisionContent(content)
    } catch {
      return {
        subActions: [],
        reason: 'decision model replied without valid JSON; the input stays received'
      }
    }
  }
}

export type ModelDecisionResolution =
  | { status: 'unavailable'; reason: string }
  | { status: 'ok'; provider: RoutingDecisionProvider }

/** Resolve the desktop's own coding-plan credential into a decision provider; the model is the
 *  user's v2 selection. Unavailable reads resolve to the manual reason, never an error. */
export async function resolveModelDecisionProvider(
  credential: ModelCredential
): Promise<ModelDecisionResolution> {
  if (credential.status !== 'ok') {
    return {
      status: 'unavailable',
      reason: 'no decision provider configured; the input awaits manual assignment'
    }
  }
  return {
    status: 'ok',
    provider: createModelDecisionProvider({
      apiKey: credential.apiKey,
      baseUrl: credential.baseUrl,
      modelId: credential.modelId
    })
  }
}

/** Auto-route one entry input through the model decision provider when a credential serves. */
export async function autoRouteWithModelProvider(
  db: OrchestrationDb,
  input: { inputId: string },
  credential: ModelCredential,
  executorCapabilities?: readonly string[]
): Promise<Awaited<ReturnType<typeof routeRoutingInput>>> {
  const resolution = await resolveModelDecisionProvider(credential)
  return routeRoutingInput(db, {
    inputId: input.inputId,
    executorCapabilities,
    ...(resolution.status === 'ok' ? { provider: resolution.provider } : {})
  })
}
