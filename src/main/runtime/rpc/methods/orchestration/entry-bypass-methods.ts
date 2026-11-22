import { coordinatedEntryRun } from './entry-run-scope'
import { defineOrchestrationMethod } from './access/orchestration-method-access'
import { bypassReportOf, parseJson } from './entry-bypass-report'
import {
  RouteBypassLabelListParams,
  RouteBypassLabelSetParams,
  RouteBypassReportParams,
  RouteBypassTrialListParams
} from '../../../../../shared/rpc-contract/orchestration/orchestration-routing-params'

// 专用决策模型旁路对照的评估面（entry-intent-routing-design §专用决策模型旁路验收）：
// routeBypassLabelSet/List 维护人工标注（分组 + 期望动作集），routeBypassReport 把同一份
// 标注与两侧提案按组比对，routeBypassTrialList 查看旁路原始结果。全部 localOnly（评估期
// CLI/桌面直调），凭据与全文报文不进任何输出。

export const ORCHESTRATION_ENTRY_BYPASS_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.routeBypassLabelSet',
    permission: 'workspace',
    params: RouteBypassLabelSetParams,
    access: { kind: 'localOnly', targets: {} },
    handler: ({ group, input, category, expected, notes }, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const { run } = coordinatedEntryRun(db, group)
      db.saveRouteBypassLabel({
        runId: run.id,
        inputId: input,
        category,
        expected,
        ...(notes ? { notes } : {})
      })
      const label = db.getRouteBypassLabel({ runId: run.id, inputId: input })!
      return {
        labelId: label.label_id,
        inputId: label.input_id,
        category: label.category,
        updatedAt: label.updated_at
      }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.routeBypassLabelList',
    permission: 'workspace',
    params: RouteBypassLabelListParams,
    access: { kind: 'localOnly', targets: {} },
    handler: ({ group, limit }, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const { run } = coordinatedEntryRun(db, group)
      return {
        labels: db
          .listRouteBypassLabels({ runId: run.id, ...(limit ? { limit } : {}) })
          .map((row) => ({
            labelId: row.label_id,
            inputId: row.input_id,
            category: row.category,
            expected: parseJson(row.expected_json),
            notes: row.notes ?? undefined,
            updatedAt: row.updated_at
          }))
      }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.routeBypassTrialList',
    permission: 'workspace',
    params: RouteBypassTrialListParams,
    access: { kind: 'localOnly', targets: {} },
    handler: ({ group, input, limit }, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const { run } = coordinatedEntryRun(db, group)
      return {
        trials: db
          .listDecisionModelAudits({
            runId: run.id,
            source: 'dedicated_bypass',
            ...(input ? { inputId: input } : {}),
            ...(limit ? { limit } : {})
          })
          .map((row) => ({
            auditId: row.audit_id,
            inputId: row.input_id,
            createdAt: row.created_at,
            model: row.model ?? undefined,
            outcome: row.outcome,
            errorMessage: row.error_message ?? undefined,
            latencyMs: row.latency_ms ?? undefined,
            inputTokens: row.input_tokens ?? undefined,
            outputTokens: row.output_tokens ?? undefined,
            proposal: parseJson(row.answers_json)
          }))
      }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.routeBypassReport',
    permission: 'workspace',
    params: RouteBypassReportParams,
    access: { kind: 'localOnly', targets: {} },
    handler: ({ group }, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const { run } = coordinatedEntryRun(db, group)
      return bypassReportOf(db, run)
    }
  })
]
