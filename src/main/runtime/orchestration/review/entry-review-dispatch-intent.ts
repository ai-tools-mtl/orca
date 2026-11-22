import type { OrchestrationDb } from '../db/orchestration-db'
import { OrchestrationError } from '../orchestration-error'

export type EntryReviewDispatchSpec = {
  spec: string
  taskTitle: string
  agent: string
  worktreeId: string
  readOnly: boolean
  workspaceRevision?: string
}

export type EntryReviewDispatchIntent = {
  intent_id: string
  sub_action_id: string
  spec_json: string
  dispatch_id: string | null
}

export function getEntryReviewDispatchIntent(db: OrchestrationDb, intentId: string) {
  return db.db
    .prepare('SELECT * FROM entry_review_dispatch_intents WHERE intent_id = ?')
    .get(intentId) as EntryReviewDispatchIntent | undefined
}

export function reserveEntryReviewDispatch(
  db: OrchestrationDb,
  intentId: string,
  subActionId: string,
  spec: EntryReviewDispatchSpec
): void {
  db.db
    .prepare(
      `INSERT INTO entry_review_dispatch_intents (intent_id, sub_action_id, spec_json)
       VALUES (?, ?, ?) ON CONFLICT(intent_id) DO NOTHING`
    )
    .run(intentId, subActionId, JSON.stringify(spec))
}

export function bindEntryReviewDispatch(
  db: OrchestrationDb,
  intentId: string,
  runId: string,
  dispatchId: string
): void {
  const intent = getEntryReviewDispatchIntent(db, intentId)
  const action = intent && db.getSubAction(intent.sub_action_id)
  if (!action || action.run_id !== runId) {
    throw new OrchestrationError('lifecycle_not_found', 'The review dispatch intent was removed.')
  }
  if (db.isRoutingRunPaused(runId) || db.isRoutingSubActionPaused(action.sub_action_id)) {
    throw new OrchestrationError('paused', 'The project task entry or task card is paused.')
  }
  const bound = db.db
    .prepare(
      'UPDATE entry_review_dispatch_intents SET dispatch_id = ? WHERE intent_id = ? AND dispatch_id IS NULL'
    )
    .run(dispatchId, intentId)
  if (bound.changes !== 1) {
    throw new OrchestrationError('lifecycle_conflict', 'The review dispatch was already accepted.')
  }
}

export function reviewIntentId(taskId: string, revision: number): string {
  return `${taskId}:review:${revision}`
}

export async function dispatchReviewIntent(
  db: OrchestrationDb,
  intentId: string,
  spawn: EntryLoopSpawn
): Promise<string> {
  const intent = getEntryReviewDispatchIntent(db, intentId)
  if (!intent) {
    throw new Error('The review dispatch intent was removed.')
  }
  if (intent.dispatch_id) {
    return intent.dispatch_id
  }
  const spec = JSON.parse(intent.spec_json) as EntryReviewDispatchSpec
  try {
    await spawn({ ...spec, intentId })
    const accepted = getEntryReviewDispatchIntent(db, intentId)?.dispatch_id
    if (accepted) {
      return accepted
    }
    throw new OrchestrationError('lifecycle_conflict', 'The review launch has no durable dispatch.')
  } catch (error) {
    const accepted = getEntryReviewDispatchIntent(db, intentId)?.dispatch_id
    if (accepted) {
      return accepted
    }
    throw error
  }
}

export type EntryLoopSpawn = (
  spawn: EntryReviewDispatchSpec & { intentId: string }
) => Promise<unknown>
