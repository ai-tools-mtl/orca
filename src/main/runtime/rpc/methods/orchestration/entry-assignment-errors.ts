import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'

export function recordEntryRoutingError(db: OrchestrationDb, inputId: string, reason: string) {
  db.db
    .prepare(
      `UPDATE routing_inputs SET entry_error = ?
       WHERE input_id = ? AND decision_status = 'received' AND entry_deleted_at IS NULL`
    )
    .run(reason, inputId)
}

export function recordEntryAssignmentError(
  db: OrchestrationDb,
  inputId: string,
  subActionId: string,
  error: unknown
): string {
  const reason = error instanceof Error ? error.message : String(error)
  db.db
    .prepare(
      `UPDATE routing_sub_actions SET entry_error = ?
       WHERE input_id = ? AND sub_action_id = ?
         AND task_id IS NULL AND claimed_dispatch_id IS NULL AND entry_deleted_at IS NULL`
    )
    .run(reason, inputId, subActionId)
  return reason
}
