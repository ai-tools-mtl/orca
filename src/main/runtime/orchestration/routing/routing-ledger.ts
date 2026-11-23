import type {
  RoutingInputRow,
  RoutingSubActionRow,
  RoutingSupplementAttemptRow,
  RoutingSupplementOrigin,
  RoutingSupplementOutcome,
  RoutingSupplementRow
} from '../db/routing-records'
import { OrchestrationError } from '../orchestration-error'
import { generateId } from '../db/generated-id'
import type { OrchestrationDb } from '../db/orchestration-db'
import {
  bindRoutingContinuationFollowUp,
  getRoutingContinuation,
  recordRoutingContinuation
} from './routing-continuations'
import {
  getRoutingInput,
  registerRoutingDecision,
  registerRoutingInput
} from './routing-input-decisions'
import type { DispatchAuthorizationMethods } from './dispatch-authorization-attach'
import {
  claimSubActionForDispatch,
  handbackSubAction,
  listSubActionHandbacks
} from './routing-claims'
import {
  dequeueRoutingSubAction,
  isRoutingRunPaused,
  routingWatchdogFacts,
  isRoutingSubActionPaused,
  listQueuedSubActions,
  pauseRoutingRun,
  pauseRoutingSubAction,
  queueRoutingSubAction,
  recordSupplementFirstActionEvidence,
  resumeRoutingRun,
  resumeRoutingSubAction,
  setSubActionState,
  settleSupplementAttempt
} from './routing-card-state'
import {
  grantRoutingStageGate,
  promoteRoutingMergeCheckpoint,
  recordRoutingMergeOutcome,
  saveRoutingPlanParse
} from './routing-stage-gates'
import { listDecisionModelAudits, recordDecisionModelAudit } from './decision-audit-store'

/** Routing ledger (optional-decision-routing plan §6): the input→sub-action→supplement→attempt
 *  linkage only. Execution state stays in tasks/dispatch_contexts/worker_dispatches. */

export function recordRoutingSupplement(
  this: OrchestrationDb,
  supplement: {
    inputId: string
    subActionId: string
    targetDispatchId: string
    text: string
    /** 来源身份（§按动作核对受理）：'route' = 路由续接路径（显式派发/恢复推进登记）；
     *  'user'（默认）= 用户主动补充/转派。 */
    origin?: RoutingSupplementOrigin
  }
): RoutingSupplementRow {
  const subAction = this.getSubAction(supplement.subActionId)
  if (!subAction || subAction.input_id !== supplement.inputId) {
    throw new OrchestrationError(
      'lifecycle_not_found',
      `Sub-action ${supplement.subActionId} does not belong to input ${supplement.inputId}.`,
      { subActionId: supplement.subActionId, inputId: supplement.inputId }
    )
  }
  const dispatch = this.getDispatchContextById(supplement.targetDispatchId)
  if (!dispatch) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Dispatch ${supplement.targetDispatchId} was not found while recording a supplement.`,
      { dispatchId: supplement.targetDispatchId }
    )
  }
  this.db.exec('SAVEPOINT record_routing_supplement')
  try {
    const id = generateId('supp')
    this.db
      .prepare(
        `INSERT INTO routing_supplements (supplement_id, input_id, sub_action_id, run_id, target_dispatch_id, raw_text, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        supplement.inputId,
        supplement.subActionId,
        subAction.run_id,
        supplement.targetDispatchId,
        supplement.text,
        supplement.origin ?? 'user'
      )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetch reads back exactly the row just inserted.
    const row = this.getSupplement(id) as RoutingSupplementRow
    this.db.exec('RELEASE record_routing_supplement')
    return row
  } catch (error) {
    this.db.exec('ROLLBACK TO record_routing_supplement')
    this.db.exec('RELEASE record_routing_supplement')
    throw error
  }
}

export function recordSupplementAttempt(
  this: OrchestrationDb,
  attempt: {
    supplementId: string
    requestId: string
    targetDispatchId: string
    /** Null only on refusals recorded before any expected turn was established. */
    expectedTurnId: string | null
    outcome: RoutingSupplementOutcome
    refusalKind?: string | null
    detail?: string | null
    turnId?: string | null
  }
): RoutingSupplementAttemptRow {
  if (!this.getSupplement(attempt.supplementId)) {
    throw new OrchestrationError(
      'lifecycle_not_found',
      `Supplement ${attempt.supplementId} was not found while recording its delivery attempt.`,
      { supplementId: attempt.supplementId }
    )
  }
  this.db.exec('SAVEPOINT record_supplement_attempt')
  try {
    const id = generateId('rsat')
    this.db
      .prepare(
        `INSERT INTO routing_supplement_attempts
           (attempt_id, supplement_id, request_id, target_dispatch_id, expected_turn_id, outcome, refusal_kind, detail, turn_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        attempt.supplementId,
        attempt.requestId,
        attempt.targetDispatchId,
        attempt.expectedTurnId,
        attempt.outcome,
        attempt.refusalKind ?? null,
        attempt.detail ?? null,
        attempt.turnId ?? null
      )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetch reads back exactly the row just inserted.
    const row = this.getSupplementAttempt(id) as RoutingSupplementAttemptRow
    this.db.exec('RELEASE record_supplement_attempt')
    return row
  } catch (error) {
    this.db.exec('ROLLBACK TO record_supplement_attempt')
    this.db.exec('RELEASE record_supplement_attempt')
    throw error
  }
}

export function getSubAction(
  this: OrchestrationDb,
  subActionId: string
): RoutingSubActionRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db
    .prepare(
      'SELECT * FROM routing_sub_actions WHERE sub_action_id = ? AND entry_deleted_at IS NULL'
    )
    .get(subActionId) as RoutingSubActionRow | undefined
}

export function getRoutingSubActionByTask(
  this: OrchestrationDb,
  taskId: string
): RoutingSubActionRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db
    .prepare(
      'SELECT * FROM routing_sub_actions WHERE task_id = ? AND entry_deleted_at IS NULL ORDER BY seq LIMIT 1'
    )
    .get(taskId) as RoutingSubActionRow | undefined
}

export function listSubActions(this: OrchestrationDb, inputId: string): RoutingSubActionRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db
    .prepare(
      'SELECT * FROM routing_sub_actions WHERE input_id = ? AND entry_deleted_at IS NULL ORDER BY seq'
    )
    .all(inputId) as RoutingSubActionRow[]
}

export function getSupplement(
  this: OrchestrationDb,
  supplementId: string
): RoutingSupplementRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db
    .prepare('SELECT * FROM routing_supplements WHERE supplement_id = ?')
    .get(supplementId) as RoutingSupplementRow | undefined
}

export function listSupplements(
  this: OrchestrationDb,
  subActionId: string
): RoutingSupplementRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db
    .prepare('SELECT * FROM routing_supplements WHERE sub_action_id = ? ORDER BY created_at, rowid')
    .all(subActionId) as RoutingSupplementRow[]
}

export function getSupplementAttempt(
  this: OrchestrationDb,
  attemptId: string
): RoutingSupplementAttemptRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db
    .prepare('SELECT * FROM routing_supplement_attempts WHERE attempt_id = ?')
    .get(attemptId) as RoutingSupplementAttemptRow | undefined
}

export function listSupplementAttempts(
  this: OrchestrationDb,
  supplementId: string
): RoutingSupplementAttemptRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db
    .prepare(
      'SELECT * FROM routing_supplement_attempts WHERE supplement_id = ? ORDER BY created_at, rowid'
    )
    .all(supplementId) as RoutingSupplementAttemptRow[]
}

export function listRunRoutingInputs(this: OrchestrationDb, runId: string): RoutingInputRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db
    .prepare(
      'SELECT * FROM routing_inputs WHERE run_id = ? AND entry_deleted_at IS NULL ORDER BY received_seq, rowid'
    )
    .all(runId) as RoutingInputRow[]
}

export type RoutingLedgerMethods = DispatchAuthorizationMethods & {
  registerRoutingInput: typeof registerRoutingInput
  registerRoutingDecision: typeof registerRoutingDecision
  recordRoutingSupplement: typeof recordRoutingSupplement
  settleSupplementAttempt: typeof settleSupplementAttempt
  recordSupplementAttempt: typeof recordSupplementAttempt
  getRoutingInput: typeof getRoutingInput
  getSubAction: typeof getSubAction
  getRoutingSubActionByTask: typeof getRoutingSubActionByTask
  listSubActions: typeof listSubActions
  getSupplement: typeof getSupplement
  listSupplements: typeof listSupplements
  getSupplementAttempt: typeof getSupplementAttempt
  listSupplementAttempts: typeof listSupplementAttempts
  listRunRoutingInputs: typeof listRunRoutingInputs
  recordRoutingContinuation: typeof recordRoutingContinuation
  getRoutingContinuation: typeof getRoutingContinuation
  bindRoutingContinuationFollowUp: typeof bindRoutingContinuationFollowUp
  setSubActionState: typeof setSubActionState
  recordSupplementFirstActionEvidence: typeof recordSupplementFirstActionEvidence
  pauseRoutingRun: typeof pauseRoutingRun
  resumeRoutingRun: typeof resumeRoutingRun
  isRoutingRunPaused: typeof isRoutingRunPaused
  pauseRoutingSubAction: typeof pauseRoutingSubAction
  resumeRoutingSubAction: typeof resumeRoutingSubAction
  isRoutingSubActionPaused: typeof isRoutingSubActionPaused
  queueRoutingSubAction: typeof queueRoutingSubAction
  dequeueRoutingSubAction: typeof dequeueRoutingSubAction
  listQueuedSubActions: typeof listQueuedSubActions
  claimSubActionForDispatch: typeof claimSubActionForDispatch
  handbackSubAction: typeof handbackSubAction
  listSubActionHandbacks: typeof listSubActionHandbacks
  grantRoutingStageGate: typeof grantRoutingStageGate
  saveRoutingPlanParse: typeof saveRoutingPlanParse
  recordRoutingMergeOutcome: typeof recordRoutingMergeOutcome
  promoteRoutingMergeCheckpoint: typeof promoteRoutingMergeCheckpoint
  recordDecisionModelAudit: typeof recordDecisionModelAudit
  listDecisionModelAudits: typeof listDecisionModelAudits
  routingWatchdogFacts: typeof routingWatchdogFacts
}

export function attachRoutingLedger(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    registerRoutingInput,
    registerRoutingDecision,
    recordRoutingSupplement,
    settleSupplementAttempt,
    recordSupplementAttempt,
    getRoutingInput,
    getSubAction,
    getRoutingSubActionByTask,
    listSubActions,
    getSupplement,
    listSupplements,
    getSupplementAttempt,
    listSupplementAttempts,
    listRunRoutingInputs,
    recordRoutingContinuation,
    getRoutingContinuation,
    bindRoutingContinuationFollowUp,
    setSubActionState,
    recordSupplementFirstActionEvidence,
    pauseRoutingRun,
    resumeRoutingRun,
    isRoutingRunPaused,
    pauseRoutingSubAction,
    resumeRoutingSubAction,
    isRoutingSubActionPaused,
    queueRoutingSubAction,
    dequeueRoutingSubAction,
    listQueuedSubActions,
    routingWatchdogFacts,
    claimSubActionForDispatch,
    handbackSubAction,
    listSubActionHandbacks,
    grantRoutingStageGate,
    saveRoutingPlanParse,
    recordRoutingMergeOutcome,
    promoteRoutingMergeCheckpoint,
    recordDecisionModelAudit,
    listDecisionModelAudits
  })
}
