import {
  workerStartOptionsAgent,
  workerStartOptionsReadOnly
} from '../workers/launch/worker-launch-observation'
import type { OrchestrationDb } from '../db/orchestration-db'
import type { RoutingInputRow, RoutingSubActionRow } from '../db/routing-records'
import {
  entryInvestigationNeedsReadOnly,
  requiresEntryWriteApproval
} from './entry-investigation-policy'

export function entryInputRequiresWriteApproval(input: RoutingInputRow | undefined): boolean {
  return input?.require_write_approval == null
    ? requiresEntryWriteApproval(input?.raw_text ?? '')
    : input.require_write_approval === 1
}

export function entrySubActionRequiresWriteApproval(
  db: OrchestrationDb,
  action: RoutingSubActionRow
): boolean {
  // 方向 2 转派行：写入已获审批放行，该行不再算写门禁（补充要求可送达其非只读 worker）。
  if (action.write_granted_at !== null) {
    return false
  }
  return (
    entryInputRequiresWriteApproval(db.getRoutingInput(action.input_id)) ||
    requiresEntryWriteApproval(action.text) ||
    requiresEntryWriteApproval(action.constraints_json)
  )
}

export function entrySubActionNeedsReadOnly(
  db: OrchestrationDb,
  action: RoutingSubActionRow
): boolean {
  return (
    entrySubActionRequiresWriteApproval(db, action) ||
    (!action.stage_kind && entryInvestigationNeedsReadOnly(action.text))
  )
}

export function isEntryReadOnlyWorker(db: OrchestrationDb, dispatchId: string): boolean {
  const options = db.getWorkerDispatch(dispatchId)?.start_options
  return (
    options != null &&
    workerStartOptionsReadOnly(options) &&
    workerStartOptionsAgent(options) === 'codex'
  )
}
