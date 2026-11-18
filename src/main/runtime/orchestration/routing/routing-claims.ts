import { OrchestrationError } from '../orchestration-error'
import type { OrchestrationDb } from '../db/orchestration-db'
import type { RoutingHandbackRow, RoutingSubActionRow } from '../db/routing-records'

// Plan §5.2 (phase B): a sub-action has one valid execution target at a time. Claiming is a
// conditional update — a stale claim (wrong dispatch or already released) fails instead of
// stealing. Handbacks release the claim in the same statement that records them.

/** Claim a sub-action for a Dispatch. First claim wins; re-claiming the same Dispatch is
 *  idempotent; a different live claim is a lifecycle conflict. */
export function claimSubActionForDispatch(
  this: OrchestrationDb,
  subActionId: string,
  dispatchId: string
): RoutingSubActionRow {
  const current = this.getSubAction(subActionId)
  if (!current) {
    throw new OrchestrationError(
      'lifecycle_not_found',
      `Sub-action ${subActionId} was not found.`,
      {
        subActionId
      }
    )
  }
  if (current.claimed_dispatch_id === dispatchId) {
    return current
  }
  if (current.claimed_dispatch_id !== null) {
    throw new OrchestrationError(
      'lifecycle_conflict',
      `Sub-action ${subActionId} is claimed by ${current.claimed_dispatch_id}; hand it back before re-targeting.`,
      { subActionId, claimedBy: current.claimed_dispatch_id }
    )
  }
  this.db
    .prepare(
      `UPDATE routing_sub_actions
       SET claimed_dispatch_id = ?, claim_version = claim_version + 1
       WHERE sub_action_id = ? AND claimed_dispatch_id IS NULL`
    )
    .run(dispatchId, subActionId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetch reads back exactly the row just updated.
  return this.getSubAction(subActionId) as RoutingSubActionRow
}

/** Release a claim and record the handback in the same guarded update. The guard enforces the
 *  plan's claim-version semantics: a stale releaser (the Dispatch no longer holds the claim)
 *  changes nothing. */
export function handbackSubAction(
  this: OrchestrationDb,
  input: { subActionId: string; fromDispatchId: string; reason?: string | null }
): { released: boolean; handback?: RoutingHandbackRow; subAction: RoutingSubActionRow } {
  const current = this.getSubAction(input.subActionId)
  if (!current) {
    throw new OrchestrationError(
      'lifecycle_not_found',
      `Sub-action ${input.subActionId} was not found.`,
      { subActionId: input.subActionId }
    )
  }
  const released = this.db
    .prepare(
      `UPDATE routing_sub_actions
       SET claimed_dispatch_id = NULL, claim_version = claim_version + 1
       WHERE sub_action_id = ? AND claimed_dispatch_id = ?`
    )
    .run(input.subActionId, input.fromDispatchId)
  if (released.changes === 0) {
    return { released: false, subAction: this.getSubAction(input.subActionId)! }
  }
  this.db
    .prepare(
      `INSERT INTO routing_sub_action_handbacks (sub_action_id, claim_version, handed_back_from, reason)
       VALUES (?, ?, ?, ?)`
    )
    .run(input.subActionId, current.claim_version, input.fromDispatchId, input.reason ?? null)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  const handback = this.db
    .prepare(
      'SELECT * FROM routing_sub_action_handbacks WHERE sub_action_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
    )
    .get(input.subActionId) as RoutingHandbackRow | undefined
  return {
    released: true,
    ...(handback ? { handback } : {}),
    subAction: this.getSubAction(input.subActionId)!
  }
}

export function listSubActionHandbacks(
  this: OrchestrationDb,
  subActionId: string
): RoutingHandbackRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db
    .prepare(
      'SELECT * FROM routing_sub_action_handbacks WHERE sub_action_id = ? ORDER BY created_at, rowid'
    )
    .all(subActionId) as RoutingHandbackRow[]
}
