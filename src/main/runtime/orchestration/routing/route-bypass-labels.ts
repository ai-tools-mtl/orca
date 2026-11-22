import { generateId } from '../db/generated-id'
import type { OrchestrationDb } from '../db/orchestration-db'

// 专用决策模型旁路对照的人工标注（entry-intent-routing-design §专用决策模型旁路验收）：
// 每条被评估输入一行——评估分组、期望动作集（与 RouteProposalV1 动作同形的子集）和备注。
// 两侧来源的提案都和这份标注比对；upsert 按 (run_id, input_id) 唯一。

import type { RouteBypassCategory } from '../../../../shared/rpc-contract/orchestration/orchestration-routing-params'

export type RouteBypassLabelRow = {
  label_id: string
  run_id: string
  input_id: string
  category: RouteBypassCategory
  expected_json: string
  notes: string | null
  created_at: string
  updated_at: string
}

export type RouteBypassLabelInput = {
  runId: string
  inputId: string
  category: RouteBypassCategory
  /** Expected action shapes (same field names as RouteProposalV1 actions) the router should
   *  have produced; free-form sub-object checks stay with the human reviewer. */
  expected: unknown
  notes?: string
}

/** 挂到 OrchestrationDb 的方法签名集（route-bypass-label-attach.ts 消费）。 */
export type RouteBypassLabelMethods = {
  saveRouteBypassLabel: typeof saveRouteBypassLabel
  getRouteBypassLabel: typeof getRouteBypassLabel
  listRouteBypassLabels: typeof listRouteBypassLabels
}

export function saveRouteBypassLabel(this: OrchestrationDb, label: RouteBypassLabelInput): void {
  this.db
    .prepare(
      `INSERT INTO route_bypass_labels (label_id, run_id, input_id, category, expected_json, notes)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, input_id) DO UPDATE SET
         category = excluded.category,
         expected_json = excluded.expected_json,
         notes = excluded.notes,
         updated_at = datetime('now')`
    )
    .run(
      generateId('rbpl'),
      label.runId,
      label.inputId,
      label.category,
      JSON.stringify(label.expected),
      label.notes ?? null
    )
}

export function getRouteBypassLabel(
  this: OrchestrationDb,
  query: { runId: string; inputId: string }
): RouteBypassLabelRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db
    .prepare('SELECT * FROM route_bypass_labels WHERE run_id = ? AND input_id = ?')
    .get(query.runId, query.inputId) as RouteBypassLabelRow | undefined
}

export function listRouteBypassLabels(
  this: OrchestrationDb,
  query: { runId: string; limit?: number }
): RouteBypassLabelRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db
    .prepare(
      'SELECT * FROM route_bypass_labels WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
    )
    .all(query.runId, Math.min(query.limit ?? 200, 500)) as RouteBypassLabelRow[]
}
