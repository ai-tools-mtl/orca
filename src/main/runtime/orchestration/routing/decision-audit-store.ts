import { generateId } from '../db/generated-id'
import type { OrchestrationDb } from '../db/orchestration-db'

// 决策模型审计 (调参参考)：one row per decision-source classification attempt (success or
// failure) — the raw service answers, the mapped classification and the branch the entry
// applied with the thresholds in force at decision time. Joins routing_inputs on input_id
// for the follow-through outcome (dispatch / supplement delivery evidence lives in the
// ledger), so tuning can correlate answers with what actually happened.

export type DecisionModelAuditRow = {
  audit_id: string
  run_id: string
  input_id: string
  created_at: string
  source: string
  model: string | null
  outcome: 'classified' | 'error'
  error_message: string | null
  http_status: number | null
  latency_ms: number | null
  credits_used: number | null
  input_tokens: number | null
  output_tokens: number | null
  state_json: string | null
  answers_json: string | null
  classification_json: string | null
  applied_json: string | null
}

export type DecisionModelAuditInput = {
  runId: string
  inputId: string
  source: string
  model?: string
  outcome: 'classified' | 'error'
  errorMessage?: string
  httpStatus?: number
  latencyMs?: number
  creditsUsed?: number
  inputTokens?: number
  outputTokens?: number
  state?: unknown
  answers?: unknown
  classification?: unknown
  applied?: unknown
}

function auditJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value)
}

export function recordDecisionModelAudit(
  this: OrchestrationDb,
  record: DecisionModelAuditInput
): void {
  this.db
    .prepare(
      `INSERT INTO decision_model_audits
         (audit_id, run_id, input_id, source, model, outcome, error_message, http_status,
          latency_ms, credits_used, input_tokens, output_tokens, state_json, answers_json, classification_json, applied_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      generateId('daud'),
      record.runId,
      record.inputId,
      record.source,
      record.model ?? null,
      record.outcome,
      record.errorMessage ?? null,
      record.httpStatus ?? null,
      record.latencyMs ?? null,
      record.creditsUsed ?? null,
      record.inputTokens ?? null,
      record.outputTokens ?? null,
      auditJson(record.state),
      auditJson(record.answers),
      auditJson(record.classification),
      auditJson(record.applied)
    )
}

export function listDecisionModelAudits(
  this: OrchestrationDb,
  query: { runId: string; inputId?: string; source?: string; limit?: number }
): DecisionModelAuditRow[] {
  const clauses = ['run_id = ?']
  if (query.inputId) {
    clauses.push('input_id = ?')
  }
  if (query.source) {
    clauses.push('source = ?')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db
    .prepare(
      `SELECT * FROM decision_model_audits
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC, rowid DESC LIMIT ?`
    )
    .all(
      query.runId,
      ...(query.inputId ? [query.inputId] : []),
      ...(query.source ? [query.source] : []),
      Math.min(query.limit ?? 50, 200)
    ) as DecisionModelAuditRow[]
}
