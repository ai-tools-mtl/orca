import { defineOrchestrationMethod } from './access/orchestration-method-access'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { createBoundRun } from './runs/runs'
import { exposeRun } from './runs/run-receipt'
import {
  desktopEntryCaller,
  desktopEntryAddress
} from '../../../orchestration/addressing/desktop-entry-identity'
import { deliverTargetedSupplement } from '../../../orchestration/routing/targeted-supplement-delivery'
import { routingInputsPayload, supplementReceipt } from './routing-supplements'
import {
  EntryHandbackParams,
  EntryShowParams,
  EntrySubmitParams,
  EntrySupplementParams
} from '../../../../../shared/rpc-contract/orchestration/orchestration-routing-params'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'

// The desktop 统一任务入口 (plan §1/§9-A) is its own coordinator: one identity per project,
// so each project's entry records requests and drives supplements without borrowing a
// terminal's or a session's authority. These methods construct that identity server-side from
// the project group id; the coordinated routing methods stay untouched for CLI and sessions.

function coordinatedEntryRun(db: OrchestrationDb, group: string) {
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

function entryRunOfInput(db: OrchestrationDb, group: string, inputId: string) {
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

export const ORCHESTRATION_ENTRY_METHODS = [
  // The standing entry read: the project's current Run (or none), its inputs with sub-actions
  // and delivery attempts, and the watchdog pause — the four-state facts the card renders.
  defineOrchestrationMethod({
    name: 'orchestration.entryShow',
    permission: 'workspace',
    params: EntryShowParams,
    access: { kind: 'localOnly', targets: {} },
    handler: ({ group }, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const caller = desktopEntryCaller(group)
      const run = db.getCurrentRunForCoordinator(caller)
      return {
        run: run ? exposeRun(run) : null,
        ...(run ? routingInputsPayload(db, run.id) : { inputs: [] }),
        // With no Run yet the entry is trivially unpaused; the facts read only this Run's ledger.
        watchdog: db.routingWatchdogFacts(run?.id ?? '')
      }
    }
  }),
  // Record a request: the entry's Run is created on first use and every request appends as an
  // input of it (registerRoutingInput dedups re-sends by idempotent reuse).
  defineOrchestrationMethod({
    name: 'orchestration.entrySubmit',
    permission: 'workspace',
    params: EntrySubmitParams,
    access: { kind: 'writes', targets: {} },
    handler: ({ group, text }, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const caller = desktopEntryCaller(group)
      const run =
        db.getCurrentRunForCoordinator(caller) ??
        createBoundRun(runtime, caller, desktopEntryAddress(group), text)
      const input = db.registerRoutingInput({ runId: run.id, text })
      return { run: exposeRun(run), input }
    }
  }),
  // Deliver one sub-action's supplement exactly like routingSupplementSend, addressed by the
  // entry's own authority instead of a terminal handle.
  defineOrchestrationMethod({
    name: 'orchestration.entrySupplement',
    permission: 'workspace',
    params: EntrySupplementParams,
    access: { kind: 'writes', targets: {} },
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const run = entryRunOfInput(db, params.group, params.input)
      if (db.isRoutingRunPaused(run.id)) {
        throw new OrchestrationError('paused', `The entry for ${params.group} is paused.`, {
          runId: run.id
        })
      }
      const { supplement, attempt, session } = await deliverTargetedSupplement({
        db,
        inputId: params.input,
        subActionId: params.subAction,
        targetDispatchId: params.dispatch,
        text: params.text,
        expectedTurnId: params.expectedTurn
      })
      return { ...supplementReceipt(supplement, attempt, session), runId: run.id }
    }
  }),
  // Release a claimed sub-action back for reassignment; the same guarded handback the
  // coordinated method performs, scoped to the entry's Run.
  defineOrchestrationMethod({
    name: 'orchestration.entryHandback',
    permission: 'workspace',
    params: EntryHandbackParams,
    access: { kind: 'writes', targets: {} },
    handler: ({ group, subAction, dispatch }, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const subActionRow = db.getSubAction(subAction)
      if (!subActionRow) {
        throw new OrchestrationError(
          'lifecycle_not_found',
          `Sub-action ${subAction} was not found.`,
          {
            subActionId: subAction
          }
        )
      }
      entryRunOfInput(db, group, subActionRow.input_id)
      const result = db.handbackSubAction({
        subActionId: subAction,
        fromDispatchId: dispatch,
        reason: 'desktop-entry'
      })
      return {
        released: result.released,
        subAction: result.subAction,
        handback: result.handback ?? null
      }
    }
  })
]
