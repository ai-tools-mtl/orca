import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import type { RoutingSubActionRow } from '../../../orchestration/db/routing-records'
import { runLifecycleWriteTransaction } from '../../../orchestration/db/lifecycle-write-transaction-runner'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { parseStageDependsOn } from '../../../orchestration/routing/routing-stage-gates'
import type { EntryDeleteRequest } from '../../../../../shared/rpc-contract/orchestration/orchestration-routing-params'

function actionDeletionState(db: OrchestrationDb, action: RoutingSubActionRow) {
  if (!action.task_id) {
    const eligible =
      !action.claimed_dispatch_id &&
      action.claim_version === 0 &&
      db.listSupplements(action.sub_action_id).length === 0
    return { eligible, failed: eligible && Boolean(action.entry_error) }
  }

  const dispatch = db.getDispatchContext(action.task_id)
  const startFailed = Boolean(
    dispatch &&
    dispatch.id === action.claimed_dispatch_id &&
    (dispatch.status === 'failed' || dispatch.status === 'circuit_broken') &&
    !dispatch.assignee_handle &&
    !dispatch.assignee_orca_session_id &&
    db.getWorkerDispatch(dispatch.id)?.state === 'failed'
  )
  // 已结算的派发可清理：worker 已退场、无在途审查环、卡片未暂停（sweep 保留在跑/暂停/待审）。
  const worker = dispatch ? db.getWorkerDispatch(dispatch.id) : undefined
  const workerGone =
    worker === undefined ||
    worker.state === 'succeeded' ||
    worker.state === 'failed' ||
    worker.state === 'stopped'
  const cycle = dispatch ? db.getLatestReviewCycleForTask(action.task_id) : undefined
  const reviewActive = cycle !== undefined && cycle.state !== 'accepted'
  const settled = Boolean(
    dispatch &&
    !action.paused_at &&
    dispatch.status !== 'pending' &&
    dispatch.status !== 'dispatched' &&
    workerGone &&
    !reviewActive
  )
  // 失败旗标覆盖两种失败：未起步的（原判定）和跑完后失败的——「清理失败项」按钮按它显隐。
  const settledDispatchFailed =
    settled && (dispatch?.status === 'failed' || dispatch?.status === 'circuit_broken')
  return { eligible: startFailed || settled, failed: startFailed || settledDispatchFailed }
}

export function entryDeletionCandidates(db: OrchestrationDb, runId: string) {
  const entries = db.listRunRoutingInputs(runId).map((input) => ({
    input,
    actions: db.listSubActions(input.input_id)
  }))
  const dependents = new Map<string, string[]>()
  const actionStates = new Map(
    entries.flatMap(({ actions }) =>
      actions.map(
        (action) =>
          [
            action.sub_action_id,
            { ...actionDeletionState(db, action), upstreams: parseStageDependsOn(action) }
          ] as const
      )
    )
  )
  const failed = new Set<string>()
  const surviving: string[] = []
  for (const [id, state] of actionStates) {
    if (state.failed) {
      failed.add(id)
    } else {
      surviving.push(id)
    }
    for (const upstream of state.upstreams) {
      const downstream = dependents.get(upstream) ?? []
      downstream.push(id)
      dependents.set(upstream, downstream)
    }
  }
  for (const id of surviving) {
    for (const upstream of actionStates.get(id)?.upstreams ?? []) {
      if (failed.delete(upstream)) {
        surviving.push(upstream)
      }
    }
  }

  return entries.map(({ input, actions }) => {
    const actionIds = new Set(actions.map((action) => action.sub_action_id))
    const states = actions.map((action) => {
      const id = action.sub_action_id
      const state = actionStates.get(id)
      const eligible = state?.eligible ?? false
      const downstream = dependents.get(id) ?? []
      return {
        id,
        eligible,
        failed: state?.failed ?? false,
        canDeleteFailed: failed.has(id),
        canDelete: eligible && downstream.length === 0,
        hasExternalDependent: downstream.some((dependent) => !actionIds.has(dependent))
      }
    })
    // 无子动作的已决策输入（如无需派发）也视为可清理。
    const canDelete =
      input.decision_status === 'received' ||
      states.every((state) => state.eligible && !state.hasExternalDependent)
    const deleteFailedRequest = input.decision_status === 'received' && Boolean(input.entry_error)
    return { input, states, canDelete, deleteFailedRequest }
  })
}

export function deleteEntryRequests(
  db: OrchestrationDb,
  runId: string,
  request: EntryDeleteRequest
): { deleted: number } {
  return runLifecycleWriteTransaction(db.db, 'entry_delete', () => {
    const candidates = entryDeletionCandidates(db, runId)
    const deleteInput = db.db.prepare(
      "UPDATE routing_inputs SET entry_deleted_at = datetime('now') WHERE input_id = ?"
    )
    const deleteAction = db.db.prepare(
      "UPDATE routing_sub_actions SET entry_deleted_at = datetime('now') WHERE sub_action_id = ?"
    )
    let deleted = 0
    for (const { input, states, canDelete, deleteFailedRequest } of candidates) {
      const id = input.input_id
      if (request.scope !== 'failed' && request.scope !== 'all' && request.input !== id) {
        continue
      }
      const whole =
        (request.scope === 'all' && (canDelete || deleteFailedRequest)) ||
        (request.scope === 'request' && canDelete) ||
        (request.scope === 'failed' && deleteFailedRequest)
      const actions = states.filter(
        (state) =>
          whole ||
          (request.scope === 'failed'
            ? state.canDeleteFailed
            : state.canDelete && request.scope === 'sub-action' && request.subAction === state.id)
      )
      for (const action of actions) {
        deleteAction.run(action.id)
      }
      if (whole || (actions.length > 0 && actions.length === states.length)) {
        // Keep the ordinal reserved because it forms the stable IDs of later sub-actions.
        deleteInput.run(id)
      }
      deleted += actions.length || Number(whole)
    }
    // 'all' 是 best-effort 清扫（在跑/暂停/审查中的指令保留），空结果不算错误。
    if (!deleted && request.scope !== 'failed' && request.scope !== 'all') {
      throw new OrchestrationError(
        'lifecycle_conflict',
        'This instruction is no longer eligible for deletion.'
      )
    }
    return { deleted }
  })
}
