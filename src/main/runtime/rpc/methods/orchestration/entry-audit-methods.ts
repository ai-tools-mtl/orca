import { defineOrchestrationMethod } from './access/orchestration-method-access'
import { DecisionAuditListParams } from '../../../../../shared/rpc-contract/orchestration/orchestration-routing-params'
import { coordinatedEntryRun } from './entry-run-scope'

// 决策审计的读面（调参参考）：最近的分类尝试（原请求 / 重试 / 升级重拆各一行），带原始
// 答案、映射分类与当时采用的分支+阈值快照。follow-through（派发结果 / 补充投递证据）在
// ledger 里按 input_id 关联——调参时两边对看。

function parseAuditJson(value: string | null): unknown {
  if (value === null) {
    return undefined
  }
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export const ORCHESTRATION_ENTRY_AUDIT_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.decisionAuditList',
    permission: 'workspace',
    params: DecisionAuditListParams,
    access: { kind: 'localOnly', targets: {} },
    handler: ({ group, input, limit }, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const { run } = coordinatedEntryRun(db, group)
      return {
        audits: db
          .listDecisionModelAudits({
            runId: run.id,
            ...(input ? { inputId: input } : {}),
            ...(limit ? { limit } : {})
          })
          .map((row) => ({
            auditId: row.audit_id,
            inputId: row.input_id,
            createdAt: row.created_at,
            source: row.source,
            model: row.model ?? undefined,
            outcome: row.outcome,
            errorMessage: row.error_message ?? undefined,
            httpStatus: row.http_status ?? undefined,
            latencyMs: row.latency_ms ?? undefined,
            creditsUsed: row.credits_used ?? undefined,
            inputTokens: row.input_tokens ?? undefined,
            state: parseAuditJson(row.state_json),
            answers: parseAuditJson(row.answers_json),
            classification: parseAuditJson(row.classification_json),
            applied: parseAuditJson(row.applied_json)
          }))
      }
    }
  })
]
