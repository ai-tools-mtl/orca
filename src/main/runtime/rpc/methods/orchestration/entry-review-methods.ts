import { requireEntryPerson } from './access/entry-person-access'
import { canAcceptEntryReview } from '../../../orchestration/review/review-cycle-store'
import { readEntryReviewWorkspaceRevision } from './entry-review-workspace-revision'
import { defineOrchestrationMethod } from './access/orchestration-method-access'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { desktopEntryCaller } from '../../../orchestration/addressing/desktop-entry-identity'
import {
  EntryApprovalsParams,
  EntryClaimParams,
  EntryReviewAcceptParams,
  EntryReviewParams,
  EntryWorkersParams
} from '../../../../../shared/rpc-contract/orchestration/orchestration-routing-params'
import { coordinatedEntryRun, entryRunOfInput, entryRunOfTask } from './entry-run-scope'
import { pumpEntryAutomations } from './entry-automation-pump'
import {
  approvalReportId,
  recentOpenApprovalReports
} from '../../../orchestration/workers/approvals/worker-approval-report'
import { recoveredEntryApprovals } from '../../../orchestration/workers/approvals/entry-write-approval'
import { workerStartOptionsAgent } from '../../../orchestration/workers/launch/worker-launch-observation'

// The entry's review-cycle reads and worker bookkeeping methods (§7 验收 + §5.2 换人): these
// complete the entry surface without weighing down the core request/delivery methods.

export const ORCHESTRATION_ENTRY_REVIEW_METHODS = [
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
        canAccept: cycle ? canAcceptEntryReview(cycle) : false,
        issue: db.getRoutingSubActionByTask(task)?.entry_error ?? null,
        ...(cycle ? { opinions: db.listReviewOpinions(cycle.cycle_id) } : { opinions: [] })
      }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.entryReviewAccept',
    permission: 'workspace',
    params: EntryReviewAcceptParams,
    access: { kind: 'writes', targets: {} },
    handler: async ({ group, task, cycle: cycleId, revision }, ctx) => {
      requireEntryPerson(ctx)
      const { runtime } = ctx
      const db = runtime.getOrchestrationDb()
      const run = entryRunOfTask(db, group, task)
      await pumpEntryAutomations({ runtime, run, group })
      const cycle = db.getLatestReviewCycleForTask(task)
      if (!cycle) {
        throw new OrchestrationError('lifecycle_not_found', `Task ${task} has no review cycle.`, {
          taskId: task
        })
      }
      if (cycle.cycle_id !== cycleId || cycle.current_revision !== revision) {
        throw new OrchestrationError(
          'lifecycle_conflict',
          'The review changed. Read the current revision before accepting.'
        )
      }
      if (cycle.state === 'accepted') {
        return { cycle }
      }
      const worktree = cycle.active_reviewer_dispatch_id
        ? db.getWorkerDispatch(cycle.active_reviewer_dispatch_id)?.worktree_id
        : undefined
      if (!canAcceptEntryReview(cycle) || !worktree) {
        throw new OrchestrationError(
          'lifecycle_conflict',
          'The current revision has no verified review.'
        )
      }
      const workspaceRevision = await readEntryReviewWorkspaceRevision(runtime, worktree)
      if (workspaceRevision !== cycle.reviewed_workspace_revision) {
        db.db
          .prepare(
            `UPDATE review_cycles SET reviewed_workspace_revision = NULL
           WHERE cycle_id = ? AND state = 'reviewing' AND current_revision = ? AND reviewed_dispatch_id = ?`
          )
          .run(cycle.cycle_id, cycle.current_revision, cycle.reviewed_dispatch_id)
        throw new OrchestrationError(
          'lifecycle_conflict',
          'The workspace changed after review. Review the new revision before accepting.'
        )
      }
      return {
        cycle: db.acceptReviewCycle(cycle.cycle_id, {
          revision: cycle.current_revision,
          reviewer: cycle.active_reviewer_dispatch_id,
          workspaceRevision
        })
      }
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
          worktreeId: row.worktreeId,
          agent: workerStartOptionsAgent(
            db.getWorkerDispatch(row.dispatchId)?.start_options ?? '{}'
          ),
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
      const run = db.getCurrentRunForCoordinator(desktopEntryCaller(group))
      if (!run) {
        return { approvals: [] }
      }
      const recovered = recoveredEntryApprovals(db, run.id)
      const live = recentOpenApprovalReports(db)
        .filter((report) => report.dispatch.run_id === run.id)
        .map(({ approval }) => {
          recovered.delete(approval.worker.dispatchId)
          return { approval, interrupted: false }
        })
      return {
        approvals: [
          ...live,
          ...Array.from(recovered.values(), (approval) => ({
            approval,
            interrupted: true
          }))
        ].map(({ approval, interrupted }) => ({
          approvalId: approval.approvalId,
          createdAt: db.getMessageById(
            approvalReportId(approval.worker.dispatchId, approval.approvalId, 'open')
          )?.created_at,
          dispatchId: approval.worker.dispatchId,
          workerHandle: approval.worker.handle,
          title: approval.summary.title,
          detail: approval.summary.detail,
          reason: approval.summary.reason,
          personOnly: approval.personOnly === true,
          interrupted
        }))
      }
    }
  })
]
