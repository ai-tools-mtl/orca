import { z } from 'zod'
import { translate } from '@/i18n/i18n'

// 入口账本 JSON 的小解析器（decision_json / depends_on_json / first_action evidence）：
// 坏行静默降级为"无信息"，视图按缺省渲染。

export function decisionRecordOf(
  rawDecision: string | null | undefined
): Record<string, unknown> | null {
  if (!rawDecision) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(rawDecision)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    // A malformed decision ledger row simply carries no verdict text.
    return null
  }
}

export function decisionReasonOf(rawDecision: string | null | undefined): string | undefined {
  const record = decisionRecordOf(rawDecision)
  const reason = record?.reason
  return typeof reason === 'string' && reason.trim() ? reason : undefined
}

export function taskReferencesOf(
  rawDecision: string | null | undefined
): (string | null)[] | undefined {
  const record = decisionRecordOf(rawDecision)
  const references = record?.taskReferences
  if (
    Array.isArray(references) &&
    references.every((entry) => typeof entry === 'string' || entry === null)
  ) {
    return references
  }
  return undefined
}

export type EntryClarification = { key: string; question: string; taskId?: string }

/** 统一路由动作批里的待澄清项（decision.decision.clarifications）：坏行静默降级为无。 */
export function entryClarificationsOf(
  rawDecision: string | null | undefined
): EntryClarification[] {
  const record = decisionRecordOf(rawDecision)
  const decision = record?.decision
  const items =
    decision && typeof decision === 'object'
      ? (decision as Record<string, unknown>).clarifications
      : undefined
  if (!Array.isArray(items)) {
    return []
  }
  return items.flatMap((item) => {
    if (typeof item !== 'object' || item === null) {
      return []
    }
    const entry = item as Record<string, unknown>
    const key = typeof entry.key === 'string' ? entry.key : ''
    const question = typeof entry.question === 'string' ? entry.question.trim() : ''
    if (!question) {
      return []
    }
    return [
      {
        key,
        question,
        ...(typeof entry.taskId === 'string' && entry.taskId ? { taskId: entry.taskId } : {})
      }
    ]
  })
}

export function parseDependsOn(raw: string | null | undefined): string[] | undefined {
  if (!raw) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.every((id) => typeof id === 'string')
      ? (parsed as string[])
      : undefined
  } catch {
    return undefined
  }
}

const firstActionEvidenceSchema = z.object({
  verdict: z.string(),
  reason: z.string().optional(),
  firstAction: z
    .object({ name: z.string().optional(), path: z.string().optional() })
    .partial()
    .optional()
})

/** 首个任务动作证据的摘要文案（§5.3 任务卡证据条）。 */
export function firstActionSummaryOf(rawEvidence: string | null): string | undefined {
  if (!rawEvidence) {
    return undefined
  }
  const parsed = firstActionEvidenceSchema.safeParse(JSON.parse(rawEvidence))
  if (!parsed.success) {
    return undefined
  }
  if (parsed.data.reason !== undefined) {
    return parsed.data.reason
  }
  const action = parsed.data.firstAction
  if (!action) {
    return undefined
  }
  return translate(
    'auto.components.sidebar.RoutingEntryCard.firstAction',
    'First action {{name}} {{path}}',
    { name: action.name ?? '', path: action.path ?? '' }
  ).trim()
}
