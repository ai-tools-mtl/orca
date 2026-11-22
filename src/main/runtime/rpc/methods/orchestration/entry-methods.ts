import { defineOrchestrationMethod } from './access/orchestration-method-access'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { createBoundRun } from './runs/runs'
import { exposeRun } from './runs/run-receipt'
import {
  desktopEntryCaller,
  desktopEntryAddress
} from '../../../orchestration/addressing/desktop-entry-identity'
import {
  deliverRecordedSupplement,
  deliverTargetedSupplement
} from '../../../orchestration/routing/targeted-supplement-delivery'
import { runLifecycleWriteTransaction } from '../../../orchestration/db/lifecycle-write-transaction-runner'
import { resumeEntrySupplements, resumeEntrySupplementsForSubAction } from './entry-supplements'
import { ORCHESTRATION_ENTRY_REVIEW_METHODS } from './entry-review-methods'
import { ORCHESTRATION_ENTRY_STAGE_METHODS } from './entry-stage-methods'
import { ORCHESTRATION_ENTRY_AUDIT_METHODS } from './entry-audit-methods'
import { ORCHESTRATION_ENTRY_BYPASS_METHODS } from './entry-bypass-methods'
import { pumpEntryAutomations } from './entry-automation-pump'
import { exposeRoutingInput, supplementReceipt } from './routing-supplements'
import { coordinatedEntryRun, entryRunOfInput } from './entry-run-scope'
import { entryInputsWithResults } from './entry-results'
import { ORCHESTRATION_ENTRY_ROUTING_METHODS } from './entry-routing-methods'
import {
  EntryHandbackParams,
  EntryPauseParams,
  EntryShowParams,
  EntrySubmitParams,
  EntrySupplementParams,
  EntryTransferParams
} from '../../../../../shared/rpc-contract/orchestration/orchestration-routing-params'
import { normalizeDecisionModelSettings } from '../../../../../shared/settings/decision-model-settings'

// The desktop 统一任务入口 (plan §1/§9-A) is its own coordinator: one identity per project,
// so each project's entry records requests and drives supplements without borrowing a
// terminal's or a session's authority. These methods construct that identity server-side from
// the project group id; the coordinated routing methods stay untouched for CLI and sessions.

export const ORCHESTRATION_ENTRY_METHODS = [
  ...ORCHESTRATION_ENTRY_ROUTING_METHODS,
  ...ORCHESTRATION_ENTRY_REVIEW_METHODS,
  ...ORCHESTRATION_ENTRY_STAGE_METHODS,
  ...ORCHESTRATION_ENTRY_AUDIT_METHODS,
  ...ORCHESTRATION_ENTRY_BYPASS_METHODS,
  defineOrchestrationMethod({
    name: 'orchestration.entryPeek',
    permission: 'workspace',
    params: EntryShowParams,
    access: { kind: 'localOnly', targets: {} },
    handler: ({ group }, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const run = db.getCurrentRunForCoordinator(desktopEntryCaller(group))
      return run ? entryInputsWithResults(db, run.id) : { inputs: [] }
    }
  }),
  // The standing entry read: the project's current Run (or none), its inputs with sub-actions
  // and delivery attempts, and the watchdog pause — the four-state facts the card renders.
  defineOrchestrationMethod({
    name: 'orchestration.entryShow',
    permission: 'workspace',
    params: EntryShowParams,
    access: { kind: 'localOnly', targets: {} },
    handler: async ({ group }, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const caller = desktopEntryCaller(group)
      const run = db.getCurrentRunForCoordinator(caller)
      if (run) {
        // The pane polls entryShow every 2s — the pump's bookkeeping advances here (§5.6/§7).
        await pumpEntryAutomations({ runtime, run, group })
      }
      return {
        run: run ? exposeRun(run) : null,
        ...(run ? entryInputsWithResults(db, run.id) : { inputs: [] }),
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
    handler: async ({ group, text, loop, decisionModel, requestId }, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const caller = desktopEntryCaller(group)
      const run =
        db.getCurrentRunForCoordinator(caller) ??
        createBoundRun(runtime, caller, desktopEntryAddress(group), text)
      const input = db.registerRoutingInput({
        runId: run.id,
        text,
        ...(loop ? { loop: true } : {}),
        ...(requestId ? { requestId } : {}),
        ...(decisionModel
          ? {
              reviewModel:
                // 旧 wire 形状归一化：审查模型只取 Agent 块的来源与执行者。
                normalizeDecisionModelSettings(decisionModel)
            }
          : {})
      })
      await pumpEntryAutomations({ runtime, run, group })
      return { run: exposeRun(run), input: exposeRoutingInput(input) }
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
      const dispatch = db.getDispatchContextById(params.dispatch)
      const action = db.getSubAction(params.subAction)
      if (
        dispatch?.run_id !== run.id ||
        action?.input_id !== params.input ||
        (action.task_id !== null &&
          action.task_id !== dispatch.task_id &&
          action.claimed_dispatch_id !== dispatch.id)
      ) {
        throw new OrchestrationError(
          'lifecycle_not_found',
          'The supplement target is not part of this task entry.'
        )
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
  defineOrchestrationMethod({
    name: 'orchestration.entryTransfer',
    permission: 'workspace',
    params: EntryTransferParams,
    access: { kind: 'writes', targets: {} },
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const run = entryRunOfInput(db, params.group, params.input)
      const supplement = runLifecycleWriteTransaction(db.db, 'entry_transfer', () => {
        const action = db.getSubAction(params.subAction)
        const destination = db.getDispatchContextById(params.dispatch)
        if (action?.input_id !== params.input || destination?.run_id !== run.id) {
          throw new OrchestrationError(
            'lifecycle_not_found',
            'The sub-action and destination must belong to this project entry.'
          )
        }
        if (
          action.claimed_dispatch_id !== params.fromDispatch ||
          destination.status !== 'dispatched' ||
          destination.id === params.fromDispatch
        ) {
          throw new OrchestrationError(
            'lifecycle_conflict',
            'The assignment changed or the selected agent can no longer accept the sub-action.'
          )
        }
        if (params.fromDispatch) {
          db.handbackSubAction({
            subActionId: params.subAction,
            fromDispatchId: params.fromDispatch,
            reason: 'desktop-entry-transfer'
          })
        }
        db.claimSubActionForDispatch(params.subAction, destination.id)
        return db.recordRoutingSupplement({
          inputId: params.input,
          subActionId: params.subAction,
          targetDispatchId: destination.id,
          text: params.text
        })
      })
      const { attempt, session } = await deliverRecordedSupplement(db, supplement)
      return supplementReceipt(supplement, attempt, session)
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
  }),
  defineOrchestrationMethod({
    name: 'orchestration.entryPause',
    permission: 'workspace',
    params: EntryPauseParams,
    access: { kind: 'writes', targets: {} },
    handler: ({ group, subAction }, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const { run } = coordinatedEntryRun(db, group)
      if (subAction) {
        const row = db.getSubAction(subAction)
        if (!row || row.run_id !== run.id) {
          throw new OrchestrationError(
            'lifecycle_not_found',
            `Sub-action ${subAction} does not belong to the entry Run of ${group}.`,
            { subActionId: subAction }
          )
        }
        return { subAction: db.pauseRoutingSubAction(subAction) }
      }
      db.pauseRoutingRun(run.id)
      return { watchdog: db.routingWatchdogFacts(run.id) }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.entryResume',
    permission: 'workspace',
    params: EntryPauseParams,
    access: { kind: 'writes', targets: {} },
    handler: async ({ group, subAction }, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const { run } = coordinatedEntryRun(db, group)
      if (subAction) {
        const row = db.getSubAction(subAction)
        if (!row || row.run_id !== run.id) {
          throw new OrchestrationError(
            'lifecycle_not_found',
            `Sub-action ${subAction} does not belong to the entry Run of ${group}.`,
            { subActionId: subAction }
          )
        }
        const resumed = db.resumeRoutingSubAction(subAction)
        await resumeEntrySupplementsForSubAction(db, subAction)
        return { subAction: resumed }
      }
      db.resumeRoutingRun(run.id)
      await resumeEntrySupplements(db, run.id)
      await pumpEntryAutomations({ runtime, run, group })
      return { watchdog: db.routingWatchdogFacts(run.id) }
    }
  })
]
