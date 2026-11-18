import type {
  RoutingInputRow,
  RoutingSubActionRow,
  RoutingSupplementAttemptRow,
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

/** Routing ledger (optional-decision-routing plan §6): the input→sub-action→supplement→attempt
 *  linkage only. Execution state stays in tasks/dispatch_contexts/worker_dispatches. */

export function registerRoutingInput(
  this: OrchestrationDb,
  input: { runId: string; text: string; decision?: unknown }
): RoutingInputRow {
  this.requireRun(input.runId)
  this.db.exec('SAVEPOINT register_routing_input')
  try {
    const id = generateId('rinp')
    this.db
      .prepare(
        `INSERT INTO routing_inputs (input_id, run_id, raw_text, received_seq, decision_status, decision_json)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(received_seq), 0) + 1 FROM routing_inputs WHERE run_id = ?), 'received', NULL)`
      )
      .run(id, input.runId, input.text, input.runId)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetch reads back exactly the row just inserted.
    const row = this.getRoutingInput(id) as RoutingInputRow
    this.db.exec('RELEASE register_routing_input')
    return row
  } catch (error) {
    this.db.exec('ROLLBACK TO register_routing_input')
    this.db.exec('RELEASE register_routing_input')
    throw error
  }
}

export function registerRoutingDecision(
  this: OrchestrationDb,
  input: {
    inputId: string
    /** One entry per sub-action, in input order; each becomes sa-{input num}-{ordinal}. */
    subActions: { text: string; constraints?: string[]; taskId?: string | null }[]
    decision?: unknown
  }
): { subActions: RoutingSubActionRow[]; reused: boolean } {
  const source = this.getRoutingInput(input.inputId)
  if (!source) {
    throw new OrchestrationError(
      'lifecycle_not_found',
      `Routing input ${input.inputId} was not found.`,
      { inputId: input.inputId }
    )
  }
  this.db.exec('SAVEPOINT register_routing_decision')
  try {
    // §5.1: one decision per input version. A re-registration after a restart reuses the
    // recorded sub-actions (same stable ids) instead of minting a second set.
    if (source.decision_status === 'decided') {
      const existing = this.listSubActions(input.inputId)
      this.db.exec('RELEASE register_routing_decision')
      return { subActions: existing, reused: true }
    }
    // The stable id's num comes from the input row's ordinal, so `sa-{num}-{k}` is globally unique.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the COUNT(*) projection is exactly { seq: number }.
    const num = this.db
      .prepare(
        'SELECT COUNT(*) AS seq FROM routing_inputs WHERE rowid <= (SELECT rowid FROM routing_inputs WHERE input_id = ?)'
      )
      .get(input.inputId) as { seq: number } | undefined
    if (!num) {
      throw new OrchestrationError(
        'lifecycle_not_found',
        `Routing input ${input.inputId} was not found while numbering sub-actions.`,
        { inputId: input.inputId }
      )
    }
    this.db
      .prepare(
        `UPDATE routing_inputs SET decision_status = 'decided', decision_json = ? WHERE input_id = ?`
      )
      .run(input.decision === undefined ? null : JSON.stringify(input.decision), input.inputId)
    const rows = input.subActions.map((subAction, index) => {
      const id = `sa-${num.seq}-${index + 1}`
      this.db
        .prepare(
          `INSERT INTO routing_sub_actions (sub_action_id, input_id, run_id, seq, text, constraints_json, task_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.inputId,
          source.run_id,
          index + 1,
          subAction.text,
          JSON.stringify(subAction.constraints ?? []),
          subAction.taskId ?? null
        )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetch reads back exactly the row just inserted.
      return this.getSubAction(id) as RoutingSubActionRow
    })
    this.db.exec('RELEASE register_routing_decision')
    return { subActions: rows, reused: false }
  } catch (error) {
    this.db.exec('ROLLBACK TO register_routing_decision')
    this.db.exec('RELEASE register_routing_decision')
    throw error
  }
}

export function recordRoutingSupplement(
  this: OrchestrationDb,
  supplement: {
    inputId: string
    subActionId: string
    targetDispatchId: string
    text: string
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
        `INSERT INTO routing_supplements (supplement_id, input_id, sub_action_id, run_id, target_dispatch_id, raw_text)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        supplement.inputId,
        supplement.subActionId,
        subAction.run_id,
        supplement.targetDispatchId,
        supplement.text
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

export function getRoutingInput(
  this: OrchestrationDb,
  inputId: string
): RoutingInputRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db.prepare('SELECT * FROM routing_inputs WHERE input_id = ?').get(inputId) as
    | RoutingInputRow
    | undefined
}

export function getSubAction(
  this: OrchestrationDb,
  subActionId: string
): RoutingSubActionRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db
    .prepare('SELECT * FROM routing_sub_actions WHERE sub_action_id = ?')
    .get(subActionId) as RoutingSubActionRow | undefined
}

export function listSubActions(this: OrchestrationDb, inputId: string): RoutingSubActionRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db
    .prepare('SELECT * FROM routing_sub_actions WHERE input_id = ? ORDER BY seq')
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
    .prepare('SELECT * FROM routing_inputs WHERE run_id = ? ORDER BY received_seq, rowid')
    .all(runId) as RoutingInputRow[]
}

export type RoutingLedgerMethods = {
  registerRoutingInput: typeof registerRoutingInput
  registerRoutingDecision: typeof registerRoutingDecision
  recordRoutingSupplement: typeof recordRoutingSupplement
  recordSupplementAttempt: typeof recordSupplementAttempt
  getRoutingInput: typeof getRoutingInput
  getSubAction: typeof getSubAction
  listSubActions: typeof listSubActions
  getSupplement: typeof getSupplement
  listSupplements: typeof listSupplements
  getSupplementAttempt: typeof getSupplementAttempt
  listSupplementAttempts: typeof listSupplementAttempts
  listRunRoutingInputs: typeof listRunRoutingInputs
  recordRoutingContinuation: typeof recordRoutingContinuation
  getRoutingContinuation: typeof getRoutingContinuation
  bindRoutingContinuationFollowUp: typeof bindRoutingContinuationFollowUp
}

export function attachRoutingLedger(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    registerRoutingInput,
    registerRoutingDecision,
    recordRoutingSupplement,
    recordSupplementAttempt,
    getRoutingInput,
    getSubAction,
    listSubActions,
    getSupplement,
    listSupplements,
    getSupplementAttempt,
    listSupplementAttempts,
    listRunRoutingInputs,
    recordRoutingContinuation,
    getRoutingContinuation,
    bindRoutingContinuationFollowUp
  })
}
