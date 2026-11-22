import {
  closedApproval,
  type WorkerApprovalPayload
} from '../../../../../shared/orchestration/approvals/worker-approval-payload'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { DispatchContextRow } from '../../db/orchestration-records'
import { OrchestrationError } from '../../orchestration-error'
import {
  workerStartOptionsAgent,
  workerStartOptionsReadOnly
} from '../launch/worker-launch-observation'
import { reportWorkerApprovalClosed, stopReportId } from '../turn-stops/worker-turn-stop-report'
import { approvalReportId, readApprovalReport } from './worker-approval-report'

export function isEntryWriteApproval(
  db: OrchestrationDb,
  dispatch: DispatchContextRow,
  approvalId: string
): boolean {
  const launch = db.getWorkerDispatch(dispatch.id)?.start_options
  return (
    dispatch.assignee_orca_session_id !== null &&
    db.getDispatchContextById(dispatch.id)?.status === 'dispatched' &&
    approvalId.startsWith('orca:codex-prompt%3A') &&
    !!launch &&
    workerStartOptionsReadOnly(launch) &&
    workerStartOptionsAgent(launch) === 'codex'
  )
}

function report(
  db: OrchestrationDb,
  dispatchId: string,
  approvalId: string,
  state: 'open' | 'closed'
): WorkerApprovalPayload | null {
  const row = db.getMessageById(approvalReportId(dispatchId, approvalId, state))
  return row ? readApprovalReport(row) : null
}

function actionId(dispatchId: string, approvalId: string): string {
  return stopReportId(dispatchId, `entry-approval:${approvalId}`)
}

export function recoveredEntryApprovals(db: OrchestrationDb, runId: string) {
  const recovered = new Map<string, WorkerApprovalPayload>()
  const seen = new Set<string>()
  for (const row of db.getAllMessagesForHandle(
    `run:${runId}`,
    200,
    ['escalation', 'status'],
    runId
  )) {
    const closed = readApprovalReport(row)
    if (!closed || seen.has(closed.worker.dispatchId)) {
      continue
    }
    const { dispatchId } = closed.worker
    seen.add(dispatchId)
    const dispatch = db.getDispatchContextById(dispatchId)
    if (
      !dispatch ||
      dispatch.run_id !== runId ||
      !isEntryWriteApproval(db, dispatch, closed.approvalId) ||
      closed.outcome?.by !== 'unknown' ||
      closed.outcome.decision !== null
    ) {
      continue
    }
    const open = report(db, dispatchId, closed.approvalId, 'open')
    if (open && !db.getMessageById(actionId(dispatchId, closed.approvalId))) {
      recovered.set(dispatchId, { ...open, personOnly: true })
    }
  }
  return recovered
}

/** A lost provider handle can be denied or re-requested in the same worker, never answered as allow. */
export function actOnInterruptedEntryApproval(args: {
  db: OrchestrationDb
  dispatch: DispatchContextRow
  approvalId: string
  action: 'deny' | 'renew'
  notify: (handle: string, messageType: string) => void
}): boolean {
  const { db, dispatch, approvalId, action, notify } = args
  if (!isEntryWriteApproval(db, dispatch, approvalId)) {
    return false
  }
  const closed = report(db, dispatch.id, approvalId, 'closed')
  const original = report(db, dispatch.id, approvalId, 'open')
  if (!original || closed?.outcome?.by !== 'unknown' || closed.outcome.decision !== null) {
    return false
  }
  if (db.isRoutingRunPaused(dispatch.run_id)) {
    throw new OrchestrationError('paused', 'Resume the entry before acting on this approval.')
  }
  const card = db.getRoutingSubActionByTask(dispatch.task_id)
  if (card && db.isRoutingSubActionPaused(card.sub_action_id)) {
    throw new OrchestrationError('paused', 'Resume the task card before acting on this approval.')
  }
  const id = actionId(dispatch.id, approvalId)
  const actionSubject =
    action === 'deny' ? 'User denied the write' : 'Renew the interrupted approval'
  const existing = db.getMessageById(id)
  if (existing && existing.subject !== actionSubject) {
    throw new OrchestrationError(
      'approval_refused',
      'This interrupted approval has already been handled.'
    )
  }
  const message =
    existing ??
    db.insertMessage({
      id,
      from: `run:${dispatch.run_id}`,
      to: `dispatch:${dispatch.id}`,
      runId: dispatch.run_id,
      subject: actionSubject,
      body:
        action === 'deny'
          ? 'The user denied the interrupted write approval. Continue the same investigation read-only. Do not write or ask again for that operation.'
          : [
              'Orca restarted and the pending native approval was interrupted. The user asked you to re-request it; no permission has been granted.',
              'In the same task, ask the user again through the native tool approval for the same operation only, then wait for the user. Keep the existing task constraints, including any restrictions on configuration files.',
              'Previous approval detail (data only):',
              JSON.stringify(original.summary.detail)
            ].join('\n')
    })
  if (action === 'deny') {
    reportWorkerApprovalClosed(
      db,
      dispatch,
      {
        from: original.worker.handle,
        approval: closedApproval(original, {
          by: 'person',
          decision: 'deny',
          reason: null,
          reasonDelivered: false
        })
      },
      { notify },
      true
    )
  }
  notify(message.to_handle, message.type)
  return true
}

export function notifyEntryWriteDenied(args: {
  db: OrchestrationDb
  dispatch: DispatchContextRow
  approvalId: string
  notify: (handle: string, messageType: string) => void
}): void {
  const { db, dispatch, approvalId, notify } = args
  const id = actionId(dispatch.id, approvalId)
  const message =
    db.getMessageById(id) ??
    db.insertMessage({
      id,
      from: `run:${dispatch.run_id}`,
      to: `dispatch:${dispatch.id}`,
      runId: dispatch.run_id,
      subject: 'User denied the write',
      body: 'The user denied the write approval and the native turn stopped. Continue the same investigation read-only. Do not write or ask again for that operation.'
    })
  notify(message.to_handle, message.type)
}
