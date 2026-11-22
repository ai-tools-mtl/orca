import { workerStartOptionsReadOnly } from '../../../../orchestration/workers/launch/worker-launch-observation'
import type { z } from 'zod'
import type { ApprovalAnswerParams } from '../../../../../../shared/rpc-contract/orchestration/orchestration-approval-answer-params'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrchestrationAccessRuleInput } from './orchestration-method-access'

export type WorkerApprovalAccess = { answeredBy: 'person' | 'coordinator'; reason: string | null }

/** Approve requires a person, or an agent caller when the user's setting is on; deny allows an agent
 *  or a person. A person is proven by the transport: only the desktop app's own IPC. A paired device
 *  can carry a remote CLI, so it counts as an agent. The setting read is this machine's, which runs
 *  the worker. */
export function workerApprovalAccess({
  params,
  ctx
}: OrchestrationAccessRuleInput<z.infer<typeof ApprovalAnswerParams>>): WorkerApprovalAccess {
  const person = ctx.caller?.kind === 'desktop' && !ctx.plugin
  const reason = params.reason?.trim() || null
  if (params.decision === 'allow') {
    const db = ctx.runtime.getOrchestrationDb()
    const worker = db.getWorkerDispatch(params.dispatch)
    if (workerStartOptionsReadOnly(worker?.start_options)) {
      const dispatch = db.getDispatchContextById(params.dispatch)
      if (dispatch && db.isRoutingRunPaused(dispatch.run_id)) {
        throw new OrchestrationError('paused', 'Resume the entry before allowing this write.')
      }
      const card =
        dispatch === undefined ? undefined : db.getRoutingSubActionByTask(dispatch.task_id)
      if (card && db.isRoutingSubActionPaused(card.sub_action_id)) {
        throw new OrchestrationError('paused', 'Resume the task card before allowing this write.')
      }
      if (!person) {
        throw new OrchestrationError(
          'approval_requires_person',
          'Only the user can allow writes for this investigation.'
        )
      }
    }
  }

  // Without a reason it is not a coordinator's approve: a person on a remote-connected desktop
  // sends none, and keeps the refusal they always got.
  if (
    params.decision === 'allow' &&
    !person &&
    !(reason && ctx.runtime.coordinatorApprovalsEnabled())
  ) {
    throw new OrchestrationError(
      'approval_requires_person',
      `Only a person can allow ${params.prompt}, from Orca or the worker itself. You can deny it with a reason, or leave it for the person.`,
      { effectsApplied: false }
    )
  }
  if (!person && !reason) {
    throw new OrchestrationError(
      'invalid_argument',
      'Missing --reason: tell the worker what to do instead.',
      { effectsApplied: false }
    )
  }
  return { answeredBy: person ? 'person' : 'coordinator', reason }
}
