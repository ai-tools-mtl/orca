import { OrchestrationError } from '../orchestration-error'
import type { OrchestrationDb } from '../db/orchestration-db'
import type {
  RoutingSubActionRow,
  RoutingSubActionState,
  RoutingSupplementAttemptRow
} from '../db/routing-records'

const SUB_ACTION_STATE_TRANSITIONS: Record<string, readonly string[]> = {
  registered: ['delivered', 'pending_verification'],
  delivered: ['processed', 'violated', 'pending_verification'],
  pending_verification: ['processed', 'violated'],
  processed: [],
  violated: []
}

/** Card state per §5.3. Idempotent for the same state; terminal states (processed/violated)
 *  never move — late evidence only refreshes their attempt rows. */
export function setSubActionState(
  this: OrchestrationDb,
  subActionId: string,
  state: RoutingSubActionState
): RoutingSubActionRow {
  const current = this.getSubAction(subActionId)
  if (!current) {
    throw new OrchestrationError(
      'lifecycle_not_found',
      `Sub-action ${subActionId} was not found.`,
      { subActionId }
    )
  }
  if (current.state === state) {
    return current
  }
  if (!SUB_ACTION_STATE_TRANSITIONS[current.state]?.includes(state)) {
    throw new OrchestrationError(
      'lifecycle_conflict',
      `Sub-action ${subActionId} cannot move from ${current.state} to ${state}.`,
      { subActionId, from: current.state, to: state }
    )
  }
  this.db
    .prepare('UPDATE routing_sub_actions SET state = ? WHERE sub_action_id = ?')
    .run(state, subActionId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetch reads back exactly the row just updated.
  return this.getSubAction(subActionId) as RoutingSubActionRow
}

/** Record the §5.3 consumption verdict: first-action evidence on the attempt plus the card
 *  state transition (complied → processed, violated → violated, unverifiable → 待核对). */
export function recordSupplementFirstActionEvidence(
  this: OrchestrationDb,
  input: {
    attemptId: string
    subActionId: string
    verdict: { verdict: string; reason?: string; firstAction?: unknown }
  }
): { attempt: RoutingSupplementAttemptRow; subAction: RoutingSubActionRow } {
  const attempt = this.getSupplementAttempt(input.attemptId)
  if (!attempt) {
    throw new OrchestrationError(
      'lifecycle_not_found',
      `Attempt ${input.attemptId} was not found.`,
      { attemptId: input.attemptId }
    )
  }
  const state =
    input.verdict.verdict === 'complied'
      ? 'processed'
      : input.verdict.verdict === 'violated'
        ? 'violated'
        : 'pending_verification'
  const subAction = this.setSubActionState(input.subActionId, state)
  this.db
    .prepare('UPDATE routing_supplement_attempts SET first_action_json = ? WHERE attempt_id = ?')
    .run(JSON.stringify(input.verdict), input.attemptId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetch reads back exactly the row just updated.
  const updated = this.getSupplementAttempt(input.attemptId) as RoutingSupplementAttemptRow
  return { attempt: updated, subAction }
}

export function pauseRoutingRun(this: OrchestrationDb, runId: string): void {
  this.requireRun(runId)
  this.db
    .prepare(
      `INSERT INTO routing_controls (run_id, paused_at) VALUES (?, datetime('now'))
       ON CONFLICT(run_id) DO UPDATE SET paused_at = excluded.paused_at
       WHERE routing_controls.paused_at IS NULL`
    )
    .run(runId)
}

export function resumeRoutingRun(this: OrchestrationDb, runId: string): void {
  this.requireRun(runId)
  this.db.prepare('UPDATE routing_controls SET paused_at = NULL WHERE run_id = ?').run(runId)
}

/** Per-card pause (§5.5): holds deliveries and write approvals for this sub-action only; the
 *  run-level watchdog pause stays independent. */
export function pauseRoutingSubAction(
  this: OrchestrationDb,
  subActionId: string
): RoutingSubActionRow {
  this.db
    .prepare(
      "UPDATE routing_sub_actions SET paused_at = datetime('now') WHERE sub_action_id = ? AND paused_at IS NULL"
    )
    .run(subActionId)
  return requireSubAction.call(this, subActionId)
}

export function resumeRoutingSubAction(
  this: OrchestrationDb,
  subActionId: string
): RoutingSubActionRow {
  this.db
    .prepare('UPDATE routing_sub_actions SET paused_at = NULL WHERE sub_action_id = ?')
    .run(subActionId)
  return requireSubAction.call(this, subActionId)
}

export function isRoutingSubActionPaused(this: OrchestrationDb, subActionId: string): boolean {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetch reads back exactly the row just updated.
  const row = this.db
    .prepare('SELECT paused_at FROM routing_sub_actions WHERE sub_action_id = ?')
    .get(subActionId) as { paused_at: string | null } | undefined
  return row?.paused_at != null
}

/** Same-folder serialization (§5.6): the folder guard defers the sub-action and the entry pump
 *  dispatches the earliest waiter once the folder frees. */
export function queueRoutingSubAction(this: OrchestrationDb, subActionId: string): void {
  this.db
    .prepare(
      "UPDATE routing_sub_actions SET queued_at = datetime('now'), entry_error = NULL WHERE sub_action_id = ? AND queued_at IS NULL AND entry_deleted_at IS NULL"
    )
    .run(subActionId)
}

export function dequeueRoutingSubAction(this: OrchestrationDb, subActionId: string): void {
  this.db
    .prepare('UPDATE routing_sub_actions SET queued_at = NULL WHERE sub_action_id = ?')
    .run(subActionId)
}

export function listQueuedSubActions(this: OrchestrationDb, runId: string): RoutingSubActionRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db
    .prepare(
      'SELECT * FROM routing_sub_actions WHERE run_id = ? AND queued_at IS NOT NULL AND entry_deleted_at IS NULL ORDER BY queued_at, seq'
    )
    .all(runId) as RoutingSubActionRow[]
}

function requireSubAction(this: OrchestrationDb, subActionId: string): RoutingSubActionRow {
  const current = this.getSubAction(subActionId)
  if (!current) {
    throw new OrchestrationError(
      'lifecycle_not_found',
      `Sub-action ${subActionId} was not found.`,
      { subActionId }
    )
  }
  return current
}

export function isRoutingRunPaused(this: OrchestrationDb, runId: string): boolean {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controls projection is exactly { paused_at }.
  const row = this.db
    .prepare('SELECT paused_at FROM routing_controls WHERE run_id = ?')
    .get(runId) as { paused_at: string | null } | undefined
  return row?.paused_at != null
}

export function settleSupplementAttempt(
  this: OrchestrationDb,
  attemptId: string,
  result:
    | { outcome: 'delivered'; turnId: string }
    | { outcome: 'refused'; refusalKind: string; detail: string | null }
): RoutingSupplementAttemptRow {
  this.db
    .prepare(
      `UPDATE routing_supplement_attempts SET outcome = ?, refusal_kind = ?, detail = ?, turn_id = ?
     WHERE attempt_id = ? AND outcome = 'unverified'`
    )
    .run(
      result.outcome,
      result.outcome === 'refused' ? result.refusalKind : null,
      result.outcome === 'refused' ? result.detail : null,
      result.outcome === 'delivered' ? result.turnId : null,
      attemptId
    )
  const attempt = this.getSupplementAttempt(attemptId)
  if (!attempt) {
    throw new OrchestrationError(
      'lifecycle_not_found',
      `Supplement attempt ${attemptId} was not found.`
    )
  }
  return attempt
}

export type RoutingWatchdogFacts = {
  paused: boolean
  /** In-flight or delivered attempts whose consumption has not been verified. */
  awaitingVerification: {
    inputId: string
    subActionId: string
    supplementId: string
    attemptId: string
    dispatchId: string
    expectedTurnId: string | null
  }[]
  /** Continuations registered but not yet sent (§5.3 row 3 registered-not-sent). */
  pendingContinuations: { subActionId: string; sourceDispatchId: string; requestId: string }[]
}

/** Deterministic §8 watchdog facts: stalled deliveries, pending continuations, pause state.
 *  No judgment beyond the recorded ledger facts. */
export function routingWatchdogFacts(this: OrchestrationDb, runId: string): RoutingWatchdogFacts {
  const awaitingVerification: RoutingWatchdogFacts['awaitingVerification'] = []
  const pendingContinuations: RoutingWatchdogFacts['pendingContinuations'] = []
  for (const input of this.listRunRoutingInputs(runId)) {
    for (const subAction of this.listSubActions(input.input_id)) {
      for (const supplement of this.listSupplements(subAction.sub_action_id)) {
        for (const attempt of this.listSupplementAttempts(supplement.supplement_id)) {
          if (
            attempt.outcome === 'unverified' ||
            (attempt.outcome === 'delivered' && attempt.first_action_json === null)
          ) {
            awaitingVerification.push({
              inputId: input.input_id,
              subActionId: subAction.sub_action_id,
              supplementId: supplement.supplement_id,
              attemptId: attempt.attempt_id,
              dispatchId: attempt.target_dispatch_id,
              expectedTurnId: attempt.expected_turn_id
            })
          }
        }
      }
      const continuation = this.getRoutingContinuation(subAction.sub_action_id)
      if (continuation && continuation.follow_up_dispatch_id === null) {
        pendingContinuations.push({
          subActionId: subAction.sub_action_id,
          sourceDispatchId: continuation.source_dispatch_id,
          requestId: continuation.request_id
        })
      }
    }
  }
  return { paused: this.isRoutingRunPaused(runId), awaitingVerification, pendingContinuations }
}
