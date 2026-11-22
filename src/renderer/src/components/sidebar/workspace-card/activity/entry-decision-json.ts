// decision_json / depends_on_json 的小解析器：坏行静默降级为"无信息"，视图按缺省渲染。

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
