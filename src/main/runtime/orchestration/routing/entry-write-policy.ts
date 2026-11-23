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
  if (action.stage_kind) {
    // 阶段行的写入权威是门链（计划门/写前审批/输入级显式标记）——计划 worker 写的 spec 是
    // 正常产物文本，可能合法包含"只读"（如库存 UI 的只读空状态），不参与只读模式扫描。
    return entryInputRequiresWriteApproval(db.getRoutingInput(action.input_id))
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
