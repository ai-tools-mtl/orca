import { OrchestrationError } from '../orchestration-error'
import { generateId } from '../db/generated-id'
import type { OrchestrationDb } from '../db/orchestration-db'

// Plan §7 write-review pilot: the writer/reviewer loop as a deterministic runtime state
// machine. The writer submits revisions; the reviewer's blocking opinions drive rework; only
// the user's acceptance closes the cycle. Opinion ids are stable (R{n}-{seq}) so evidence and
// rework stays attributable across revisions.

export type ReviewCycleRow = {
  cycle_id: string
  task_id: string
  writer_dispatch_id: string
  reviewer_dispatch_id: string
  current_revision: number
  state: 'reviewing' | 'rework' | 'accepted'
  /** The loop driver's live dispatches: rework turns on the writer's thread and re-reviews
   *  on the reviewer's thread swap these while writer_dispatch_id/reviewer_dispatch_id keep
   *  the original pairing (§7 identity). */
  active_writer_dispatch_id: string | null
  active_reviewer_dispatch_id: string | null
  /** The reviewer Dispatch whose report has already been recorded as opinions. */
  reviewed_dispatch_id: string | null
  reviewed_workspace_revision: string | null
  created_at: string
}

export type ReviewOpinionRow = {
  opinion_id: string
  cycle_id: string
  revision: number
  seq: number
  body: string
  state: 'blocked' | 'resolved'
  created_at: string
  resolved_at: string | null
}

function cycleOf(this: OrchestrationDb, cycleId: string): ReviewCycleRow {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  const row = this.db.prepare('SELECT * FROM review_cycles WHERE cycle_id = ?').get(cycleId) as
    | ReviewCycleRow
    | undefined
  if (!row) {
    throw new OrchestrationError('lifecycle_not_found', `Review cycle ${cycleId} was not found.`, {
      cycleId
    })
  }
  return row
}

/** Start a cycle for a delegated dev task: the writer and reviewer Dispatches are fixed at
 *  start (§7: 保留 writer/reviewer 原生线程). */
export function startReviewCycle(
  this: OrchestrationDb,
  input: { taskId: string; writerDispatchId: string; reviewerDispatchId: string }
): ReviewCycleRow {
  if (input.writerDispatchId === input.reviewerDispatchId) {
    throw new OrchestrationError(
      'lifecycle_conflict',
      'The writer and the reviewer must be different Dispatches.'
    )
  }
  const id = generateId('rcyc')
  this.db
    .prepare(
      `INSERT INTO review_cycles (
         cycle_id, task_id, writer_dispatch_id, reviewer_dispatch_id,
         active_writer_dispatch_id, active_reviewer_dispatch_id, current_revision, state
       )
       VALUES (?, ?, ?, ?, ?, ?, 1, 'reviewing')`
    )
    .run(
      id,
      input.taskId,
      input.writerDispatchId,
      input.reviewerDispatchId,
      input.writerDispatchId,
      input.reviewerDispatchId
    )
  return cycleOf.call(this, id)
}

export function getReviewCycle(this: OrchestrationDb, cycleId: string): ReviewCycleRow {
  return cycleOf.call(this, cycleId)
}

/** The task's latest cycle, newest first — the entry renders review state per delegated task. */
export function getLatestReviewCycleForTask(
  this: OrchestrationDb,
  taskId: string
): ReviewCycleRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  const row = this.db
    .prepare(
      'SELECT * FROM review_cycles WHERE task_id = ? ORDER BY created_at DESC, cycle_id DESC LIMIT 1'
    )
    .get(taskId) as ReviewCycleRow | undefined
  return row
}

/** The writer submits revision n (first submission is R1 by start). Moves reviewing → nothing
 *  (stays reviewing until the reviewer answers) and rework → reviewing. Blocking opinions of
 *  the previous revision stay recorded — history, not debts. */
export function submitReviewRevision(this: OrchestrationDb, cycleId: string): ReviewCycleRow {
  const cycle = cycleOf.call(this, cycleId)
  if (cycle.state === 'accepted') {
    throw new OrchestrationError(
      'lifecycle_conflict',
      `Review cycle ${cycleId} is already accepted.`
    )
  }
  const next = cycle.current_revision + (cycle.state === 'rework' ? 1 : 0)
  this.db
    .prepare(
      'UPDATE review_cycles SET current_revision = ?, state = ?, reviewed_dispatch_id = NULL, reviewed_workspace_revision = NULL WHERE cycle_id = ?'
    )
    .run(cycle.state === 'rework' ? next : cycle.current_revision, 'reviewing', cycleId)
  return cycleOf.call(this, cycleId)
}

/** Record one reviewer opinion against the current revision. Stable id R{n}-{seq}; a blocking
 *  opinion moves the cycle to rework (§7: 审查不通过就回到原 writer 返工). */
export function recordReviewOpinion(
  this: OrchestrationDb,
  input: { cycleId: string; body: string; blocking?: boolean }
): ReviewOpinionRow {
  const cycle = cycleOf.call(this, input.cycleId)
  if (cycle.state === 'accepted') {
    throw new OrchestrationError(
      'lifecycle_conflict',
      `Review cycle ${input.cycleId} is already accepted.`
    )
  }
  const blocking = input.blocking ?? true
  const revision = cycle.current_revision
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the COUNT projection is exactly { seq: number }.
  const seqRow = this.db
    .prepare('SELECT COUNT(*) AS seq FROM review_opinions WHERE cycle_id = ? AND revision = ?')
    .get(input.cycleId, revision) as { seq: number } | undefined
  const seq = (seqRow?.seq ?? 0) + 1
  const id = `R${revision}-${String(seq).padStart(2, '0')}`
  this.db
    .prepare(
      `INSERT INTO review_opinions (opinion_id, cycle_id, revision, seq, body, state)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, input.cycleId, revision, seq, input.body, blocking ? 'blocked' : 'resolved')
  if (blocking) {
    this.db
      .prepare('UPDATE review_cycles SET state = ? WHERE cycle_id = ?')
      .run('rework', input.cycleId)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db
    .prepare('SELECT * FROM review_opinions WHERE opinion_id = ?')
    .get(id) as ReviewOpinionRow
}

export function listReviewOpinions(this: OrchestrationDb, cycleId: string): ReviewOpinionRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db
    .prepare('SELECT * FROM review_opinions WHERE cycle_id = ? ORDER BY revision, seq')
    .all(cycleId) as ReviewOpinionRow[]
}

export function resolveReviewOpinion(
  this: OrchestrationDb,
  cycleId: string,
  opinionId: string
): ReviewOpinionRow {
  cycleOf.call(this, cycleId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  const opinion = this.db
    .prepare('SELECT * FROM review_opinions WHERE opinion_id = ? AND cycle_id = ?')
    .get(opinionId, cycleId) as ReviewOpinionRow | undefined
  if (!opinion) {
    throw new OrchestrationError('lifecycle_not_found', `Opinion ${opinionId} was not found.`, {
      opinionId
    })
  }
  this.db
    .prepare(
      `UPDATE review_opinions SET state = 'resolved', resolved_at = datetime('now')
       WHERE opinion_id = ? AND state = 'blocked'`
    )
    .run(opinionId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db
    .prepare('SELECT * FROM review_opinions WHERE opinion_id = ?')
    .get(opinionId) as ReviewOpinionRow
}

/** The loop driver's bookkeeping: swap the active dispatches after a rework/re-review spawn
 *  and mark a reviewer report as recorded so the pump never parses it twice. */
export function setReviewCycleAutomation(
  this: OrchestrationDb,
  input: {
    cycleId: string
    activeWriterDispatchId?: string | null
    activeReviewerDispatchId?: string | null
    reviewedDispatchId?: string
    reviewedWorkspaceRevision?: string
  }
): ReviewCycleRow {
  cycleOf.call(this, input.cycleId)
  this.db
    .prepare(
      `UPDATE review_cycles SET
         active_writer_dispatch_id = COALESCE(?, active_writer_dispatch_id),
         active_reviewer_dispatch_id = COALESCE(?, active_reviewer_dispatch_id),
         reviewed_dispatch_id = COALESCE(?, reviewed_dispatch_id),
         reviewed_workspace_revision = COALESCE(?, reviewed_workspace_revision)
       WHERE cycle_id = ?`
    )
    .run(
      input.activeWriterDispatchId ?? null,
      input.activeReviewerDispatchId ?? null,
      input.reviewedDispatchId ?? null,
      input.reviewedWorkspaceRevision ?? null,
      input.cycleId
    )
  return cycleOf.call(this, input.cycleId)
}

export function advanceEntryReviewRevision(
  this: OrchestrationDb,
  cycleId: string,
  expectedRevision: number,
  reviewer: string
): void {
  this.db
    .prepare(
      `UPDATE review_cycles
       SET current_revision = current_revision + 1, state = 'reviewing',
           active_reviewer_dispatch_id = ?, reviewed_dispatch_id = NULL,
           reviewed_workspace_revision = NULL
       WHERE cycle_id = ? AND current_revision = ? AND state <> 'accepted'`
    )
    .run(reviewer, cycleId, expectedRevision)
}

export function canAcceptEntryReview(cycle: ReviewCycleRow): boolean {
  return (
    cycle.state === 'reviewing' &&
    cycle.active_reviewer_dispatch_id !== null &&
    cycle.reviewed_dispatch_id === cycle.active_reviewer_dispatch_id &&
    cycle.reviewed_workspace_revision !== null
  )
}

/** User acceptance (§7: 严格写审首版由用户验收) closes the cycle only when the current
 *  revision has no blocking opinions left. */
export function acceptReviewCycle(
  this: OrchestrationDb,
  cycleId: string,
  evidence?: { revision: number; reviewer: string | null; workspaceRevision: string }
): ReviewCycleRow {
  const cycle = cycleOf.call(this, cycleId)
  if (cycle.state === 'accepted') {
    return cycle
  }
  const action = this.getRoutingSubActionByTask(cycle.task_id)
  if (action || evidence) {
    const reviewer = cycle.active_reviewer_dispatch_id
      ? this.getDispatchContextById(cycle.active_reviewer_dispatch_id)
      : undefined
    if (
      !evidence ||
      !canAcceptEntryReview(cycle) ||
      evidence.revision !== cycle.current_revision ||
      evidence.reviewer !== cycle.active_reviewer_dispatch_id ||
      evidence.workspaceRevision !== cycle.reviewed_workspace_revision ||
      reviewer?.run_id !== action?.run_id ||
      reviewer === undefined ||
      this.getTask(reviewer.task_id)?.status !== 'completed'
    ) {
      throw new OrchestrationError(
        'lifecycle_conflict',
        'The current revision has no verified review.'
      )
    }
    if (
      this.isRoutingRunPaused(reviewer.run_id) ||
      (action && this.isRoutingSubActionPaused(action.sub_action_id))
    ) {
      throw new OrchestrationError(
        'paused',
        'Resume the project task entry and card before accepting.'
      )
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the COUNT projection is exactly { blocked: number }.
  const blocked = this.db
    .prepare(
      "SELECT COUNT(*) AS blocked FROM review_opinions WHERE cycle_id = ? AND revision = ? AND state = 'blocked'"
    )
    .get(cycleId, cycle.current_revision) as { blocked: number } | undefined
  if ((blocked?.blocked ?? 0) > 0) {
    throw new OrchestrationError(
      'lifecycle_conflict',
      `Review cycle ${cycleId} still has blocking opinions on revision R${cycle.current_revision}.`,
      { cycleId, revision: cycle.current_revision }
    )
  }
  this.db.prepare("UPDATE review_cycles SET state = 'accepted' WHERE cycle_id = ?").run(cycleId)
  return cycleOf.call(this, cycleId)
}

export type ReviewCycleMethods = {
  startReviewCycle: typeof startReviewCycle
  getReviewCycle: typeof getReviewCycle
  getLatestReviewCycleForTask: typeof getLatestReviewCycleForTask
  submitReviewRevision: typeof submitReviewRevision
  recordReviewOpinion: typeof recordReviewOpinion
  listReviewOpinions: typeof listReviewOpinions
  resolveReviewOpinion: typeof resolveReviewOpinion
  acceptReviewCycle: typeof acceptReviewCycle
  setReviewCycleAutomation: typeof setReviewCycleAutomation
  advanceEntryReviewRevision: typeof advanceEntryReviewRevision
}

export function attachReviewCycleStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    startReviewCycle,
    getReviewCycle,
    getLatestReviewCycleForTask,
    submitReviewRevision,
    recordReviewOpinion,
    listReviewOpinions,
    resolveReviewOpinion,
    acceptReviewCycle,
    setReviewCycleAutomation,
    advanceEntryReviewRevision
  })
}
