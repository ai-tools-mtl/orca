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
      "INSERT OR IGNORE INTO routing_controls (run_id, paused_at) VALUES (?, datetime('now'))"
    )
    .run(runId)
}

export function resumeRoutingRun(this: OrchestrationDb, runId: string): void {
  this.requireRun(runId)
  this.db.prepare('UPDATE routing_controls SET paused_at = NULL WHERE run_id = ?').run(runId)
}

export function isRoutingRunPaused(this: OrchestrationDb, runId: string): boolean {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controls projection is exactly { paused_at }.
  const row = this.db
    .prepare('SELECT paused_at FROM routing_controls WHERE run_id = ?')
    .get(runId) as { paused_at: string | null } | undefined
  return row?.paused_at != null
}
