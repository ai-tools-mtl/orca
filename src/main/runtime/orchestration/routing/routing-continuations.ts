import { OrchestrationError } from '../orchestration-error'
import type { OrchestrationDb } from '../db/orchestration-db'
import type { RoutingContinuationRow } from '../db/routing-records'

/** Register the ONE continuation a sub-action may have (plan §5.3 row 3, §6 唯一续接记录);
 *  a second registration for the same sub-action reuses the recorded row. */
export function recordRoutingContinuation(
  this: OrchestrationDb,
  input: {
    subActionId: string
    inputId: string
    sourceDispatchId: string
    requestId: string
  }
): { continuation: RoutingContinuationRow; reused: boolean } {
  const info = this.db
    .prepare(
      `INSERT OR IGNORE INTO routing_sub_action_continuations
         (sub_action_id, input_id, source_dispatch_id, request_id)
       VALUES (?, ?, ?, ?)`
    )
    .run(input.subActionId, input.inputId, input.sourceDispatchId, input.requestId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  const continuation = this.db
    .prepare('SELECT * FROM routing_sub_action_continuations WHERE sub_action_id = ?')
    .get(input.subActionId) as RoutingContinuationRow | undefined
  if (!continuation) {
    throw new OrchestrationError(
      'lifecycle_not_found',
      `Routing continuation for sub-action ${input.subActionId} was not found after registration.`
    )
  }
  return { continuation, reused: info.changes === 0 }
}

export function getRoutingContinuation(
  this: OrchestrationDb,
  subActionId: string
): RoutingContinuationRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db
    .prepare('SELECT * FROM routing_sub_action_continuations WHERE sub_action_id = ?')
    .get(subActionId) as RoutingContinuationRow | undefined
}

/** Bind the follow-up Dispatch once; re-binding the same Dispatch is idempotent, a different one
 *  is a lifecycle conflict (plan §6: 每个子动作…唯一续接记录). */
export function bindRoutingContinuationFollowUp(
  this: OrchestrationDb,
  subActionId: string,
  followUpDispatchId: string
): RoutingContinuationRow {
  const existing = this.getRoutingContinuation(subActionId)
  if (!existing) {
    throw new OrchestrationError(
      'lifecycle_not_found',
      `Routing continuation for sub-action ${subActionId} was not found.`
    )
  }
  if (existing.follow_up_dispatch_id === followUpDispatchId) {
    return existing
  }
  if (existing.follow_up_dispatch_id !== null) {
    throw new OrchestrationError(
      'lifecycle_conflict',
      `Sub-action ${subActionId} already continues through ${existing.follow_up_dispatch_id}.`,
      { subActionId, followUpDispatchId: existing.follow_up_dispatch_id }
    )
  }
  this.db
    .prepare(
      'UPDATE routing_sub_action_continuations SET follow_up_dispatch_id = ? WHERE sub_action_id = ?'
    )
    .run(followUpDispatchId, subActionId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db
    .prepare('SELECT * FROM routing_sub_action_continuations WHERE sub_action_id = ?')
    .get(subActionId) as RoutingContinuationRow
}
