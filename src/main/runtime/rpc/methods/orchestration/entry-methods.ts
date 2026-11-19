import { defineOrchestrationMethod } from './access/orchestration-method-access'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { createBoundRun } from './runs/runs'
import { exposeRun } from './runs/run-receipt'
import {
  desktopEntryCaller,
  desktopEntryAddress
} from '../../../orchestration/addressing/desktop-entry-identity'
import { deliverTargetedSupplement } from '../../../orchestration/routing/targeted-supplement-delivery'
import { autoRouteWithModelProvider } from '../../../orchestration/routing/model-decision-provider'
import { readZcodeV2PlanCredential } from '../../../../zcode/zcode-v2-plan-credentials'
import { recentOpenApprovalReports } from '../../../orchestration/workers/approvals/worker-approval-report'
import { routingInputsPayload, supplementReceipt } from './routing-supplements'
import {
  EntryApprovalsParams,
  EntryAutoRouteParams,
  EntryClaimParams,
  EntryHandbackParams,
  EntryPauseParams,
  EntryReviewParams,
  EntryShowParams,
  EntrySubmitParams,
  EntrySupplementParams,
  EntryWorkersParams
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

function entryRunOfTask(db: OrchestrationDb, group: string, taskId: string) {
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
  }),
  // §5.5 as the prototype's card-level 暂停: a user-applied wait on the entry's Run. While
  // paused, supplement deliveries refuse (deliveries stay recorded, re-driven on resume).
  defineOrchestrationMethod({
    name: 'orchestration.entryPause',
    permission: 'workspace',
    params: EntryPauseParams,
    access: { kind: 'writes', targets: {} },
    handler: ({ group }, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const { run } = coordinatedEntryRun(db, group)
      db.pauseRoutingRun(run.id)
      return { watchdog: db.routingWatchdogFacts(run.id) }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.entryResume',
    permission: 'workspace',
    params: EntryPauseParams,
    access: { kind: 'writes', targets: {} },
    handler: ({ group }, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const { run } = coordinatedEntryRun(db, group)
      db.resumeRoutingRun(run.id)
      return { watchdog: db.routingWatchdogFacts(run.id) }
    }
  }),
  // §7 review state for a delegated task of the entry's Run: the latest cycle with its
  // opinions, plus the user's acceptance (严格首版由用户验收 closes only without blocking
  // opinions — acceptReviewCycle enforces that).
  defineOrchestrationMethod({
    name: 'orchestration.entryReviewShow',
    permission: 'workspace',
    params: EntryReviewParams,
    access: { kind: 'reads', targets: {} },
    handler: ({ group, task }, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      entryRunOfTask(db, group, task)
      const cycle = db.getLatestReviewCycleForTask(task)
      return {
        cycle: cycle ?? null,
        ...(cycle ? { opinions: db.listReviewOpinions(cycle.cycle_id) } : { opinions: [] })
      }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.entryReviewAccept',
    permission: 'workspace',
    params: EntryReviewParams,
    access: { kind: 'writes', targets: {} },
    handler: ({ group, task }, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      entryRunOfTask(db, group, task)
      const cycle = db.getLatestReviewCycleForTask(task)
      if (!cycle) {
        throw new OrchestrationError('lifecycle_not_found', `Task ${task} has no review cycle.`, {
          taskId: task
        })
      }
      return { cycle: db.acceptReviewCycle(cycle.cycle_id) }
    }
  }),
  // §5.2 换人: the entry Run's workers (id, handle, state) a sub-action can be re-assigned to.
  defineOrchestrationMethod({
    name: 'orchestration.entryWorkers',
    permission: 'workspace',
    params: EntryWorkersParams,
    access: { kind: 'reads', targets: {} },
    handler: ({ group }, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const { run } = coordinatedEntryRun(db, group)
      return {
        workers: db.listWorkerTerminalResources({ runId: run.id }).map((row) => ({
          dispatchId: row.dispatchId,
          handle: row.agentTerminalHandle ?? row.dispatchId,
          workerState: row.workerState,
          dispatchStatus: row.dispatchStatus,
          pendingApproval: row.pendingApproval
        }))
      }
    }
  }),
  // Claim a sub-action for one of the entry Run's workers (the claim step of 换人: handback
  // releases, claim re-points, the supplement form re-delivers).
  defineOrchestrationMethod({
    name: 'orchestration.entryClaim',
    permission: 'workspace',
    params: EntryClaimParams,
    access: { kind: 'writes', targets: {} },
    handler: ({ group, subAction, dispatch }, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const subActionRow = db.getSubAction(subAction)
      if (!subActionRow) {
        throw new OrchestrationError(
          'lifecycle_not_found',
          `Sub-action ${subAction} was not found.`,
          { subActionId: subAction }
        )
      }
      entryRunOfInput(db, group, subActionRow.input_id)
      if (!db.getDispatchContextById(dispatch)) {
        throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatch} was not found.`, {
          dispatchId: dispatch
        })
      }
      const claimed = db.claimSubActionForDispatch(subAction, dispatch)
      return { subAction: claimed, claimVersion: claimed.claim_version }
    }
  }),
  // §5.1's model-backed routing, on the entry's own authority. Two credential sources: the
  // settings-configured custom provider (any OpenAI-compatible endpoint), or — the default —
  // the desktop's own ZCode coding plan credential with the v2 selection's model. Without a
  // serving credential this resolves to the manual reason; the input stays received.
  defineOrchestrationMethod({
    name: 'orchestration.entryAutoRoute',
    permission: 'workspace',
    params: EntryAutoRouteParams,
    access: { kind: 'writes', targets: {} },
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      entryRunOfInput(db, params.group, params.input)
      const credential =
        params.decisionModel?.provider === 'custom'
          ? {
              status: 'ok' as const,
              apiKey: params.decisionModel.apiKey ?? '',
              baseUrl: params.decisionModel.baseUrl ?? '',
              modelId: params.decisionModel.modelId ?? ''
            }
          : await readZcodeV2PlanCredential()
      return autoRouteWithModelProvider(db, { inputId: params.input }, credential)
    }
  }),
  // The prototype's 授权追问卡: approvals Orca reported open for this Run's workers, from the
  // persisted escalation reports. Answering goes through orchestration.approvalAnswer, where the
  // desktop transport already proves the person.
  defineOrchestrationMethod({
    name: 'orchestration.entryApprovals',
    permission: 'workspace',
    params: EntryApprovalsParams,
    access: { kind: 'reads', targets: {} },
    handler: ({ group }, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const { run } = coordinatedEntryRun(db, group)
      return {
        approvals: recentOpenApprovalReports(db)
          .filter((report) => report.dispatch.run_id === run.id)
          .map((report) => ({
            approvalId: report.approval.approvalId,
            dispatchId: report.approval.worker.dispatchId,
            workerHandle: report.approval.worker.handle,
            title: report.approval.summary.title,
            detail: report.approval.summary.detail,
            reason: report.approval.summary.reason,
            personOnly: report.approval.personOnly === true
          }))
      }
    }
  })
]
