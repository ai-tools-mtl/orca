import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import { desktopEntryCaller } from '../../../orchestration/addressing/desktop-entry-identity'
import { OrchestrationError } from '../../../orchestration/orchestration-error'

// The desktop entry's Run-scoping guards (plan §1/§9-A): every entry method resolves the
// per-project entry Run first and proves an input/task belongs to it before touching state.

export function coordinatedEntryRun(db: OrchestrationDb, group: string) {
  const caller = desktopEntryCaller(group)
  const run = db.getCurrentRunForCoordinator(caller)
  if (!run) {
    throw new OrchestrationError(
      'run_required',
      `The entry for ${group} has no Run yet; record a request first.`
    )
  }
  return { caller, run }
}

export function entryRunOfInput(db: OrchestrationDb, group: string, inputId: string) {
  const { run } = coordinatedEntryRun(db, group)
  const input = db.getRoutingInput(inputId)
  if (!input || input.run_id !== run.id) {
    throw new OrchestrationError(
      'lifecycle_not_found',
      `Input ${inputId} does not belong to the entry Run of ${group}.`,
      { inputId }
    )
  }
  return run
}

export function entryRunOfTask(db: OrchestrationDb, group: string, taskId: string) {
  const { run } = coordinatedEntryRun(db, group)
  const task = db.getTask(taskId)
  if (!task || task.run_id !== run.id) {
    throw new OrchestrationError(
      'lifecycle_not_found',
      `Task ${taskId} does not belong to the entry Run of ${group}.`,
      { taskId }
    )
  }
  return run
}
