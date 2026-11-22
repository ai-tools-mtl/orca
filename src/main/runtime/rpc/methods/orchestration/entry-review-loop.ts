import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import type { TaskRow } from '../../../orchestration/db/orchestration-records'
import type { RoutingSubActionRow } from '../../../orchestration/db/routing-records'
import { workerStartOptionsAgent } from '../../../orchestration/workers/launch/worker-launch-observation'
import type { ReviewCycleRow } from '../../../orchestration/review/review-cycle-store'
import type { RunRow } from '../../../orchestration/db/orchestration-records'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { entrySubActionNeedsReadOnly } from '../../../orchestration/routing/entry-write-policy'
import { runLifecycleWriteTransaction } from '../../../orchestration/db/lifecycle-write-transaction-runner'
import {
  dispatchReviewIntent,
  getEntryReviewDispatchIntent,
  reserveEntryReviewDispatch,
  reviewIntentId,
  type EntryLoopSpawn,
  type EntryReviewDispatchSpec
} from '../../../orchestration/review/entry-review-dispatch-intent'
import { readEntryReviewWorkspaceRevision } from './entry-review-workspace-revision'
import { entryPlacement } from './entry-placement'
import { parseReviewOpinions } from './entry-reviewer-pick'
import {
  REVIEW_SPEC_MARKER_NOTE,
  startReviewRound,
  type ReviewRoundArgs
} from './entry-first-review'

export type { EntryLoopSpawn }

// The §7 循环开发 driver: the entry pump walks every loop-dev sub-action and advances the
// writer→reviewer state machine one deterministic step per pass. Spawns start in the writer's
// own workspace (same-tree review/rework); native-thread continuation is a later refinement.

const activeReviewPumps = new WeakMap<OrchestrationDb, Set<string>>()

export async function pumpReviewLoops(
  args: { runtime: OrcaRuntimeService; run: RunRow; group: string },
  spawnWorker: EntryLoopSpawn
): Promise<void> {
  const { runtime, run, group } = args
  const db = runtime.getOrchestrationDb()

  if (db.isRoutingRunPaused(run.id)) {
    return
  }

  // Collect the pending loop work from the ledger first — the placement probe only runs when
  // there is something to advance (the store may have no repo registered at all).
  const work: { action: RoutingSubActionRow; task: TaskRow }[] = []
  for (const input of db.listRunRoutingInputs(run.id)) {
    if (input.loop_dev !== 1) {
      continue
    }
    for (const action of db.listSubActions(input.input_id)) {
      if (!action.task_id || action.paused_at) {
        continue
      }
      // 可审查产出：实施阶段与原型（对照需求）；纯规划文档/合并由用户门把关（pipeline §7）。
      if (
        action.stage_kind === 'clarification' ||
        action.stage_kind === 'plan' ||
        action.stage_kind === 'merge'
      ) {
        continue
      }
      if (entrySubActionNeedsReadOnly(db, action)) {
        // 调查只读任务不进循环：只有写任务才有可审查的产出（§7）。
        continue
      }
      const task = db.getTask(action.task_id)
      if (!task) {
        continue
      }
      if (db.getSubAction(action.sub_action_id)?.task_id !== task.id) {
        continue
      }
      const cycle = db.getLatestReviewCycleForTask(task.id)
      if (!cycle) {
        if (task.status !== 'completed') {
          continue
        }
        work.push({ action, task })
        continue
      }
      if (cycle.state === 'accepted') {
        continue
      }
      work.push({ action, task })
    }
  }
  if (work.length === 0) {
    return
  }
  const placement = await entryPlacement(runtime, group).catch(() => undefined)
  if (!placement) {
    return
  }
  const active = activeReviewPumps.get(db) ?? new Set<string>()
  activeReviewPumps.set(db, active)
  for (const { action, task } of work) {
    if (active.has(task.id) || db.isRoutingSubActionPaused(action.sub_action_id)) {
      continue
    }
    active.add(task.id)
    try {
      const cycle = db.getLatestReviewCycleForTask(task.id)
      if (!cycle) {
        await startReviewRound({ runtime, db, placement, action, task, spawnWorker })
      } else if (cycle.state !== 'accepted') {
        await advanceReviewCycle({ runtime, db, action, cycle, spawnWorker })
      }
      setReviewError(db, action, null)
    } catch (error) {
      setReviewError(db, action, error instanceof Error ? error.message : String(error))
    } finally {
      active.delete(task.id)
    }
  }
}

function setReviewError(db: OrchestrationDb, action: RoutingSubActionRow, error: string | null) {
  db.db
    .prepare(
      'UPDATE routing_sub_actions SET entry_error = ? WHERE sub_action_id = ? AND entry_error IS NOT ?'
    )
    .run(error, action.sub_action_id, error)
}

async function advanceReviewCycle(
  args: ReviewRoundArgs & { cycle: ReviewCycleRow }
): Promise<void> {
  const { runtime, db, action, cycle, spawnWorker } = args
  const reviewer = cycle.active_reviewer_dispatch_id ?? cycle.reviewer_dispatch_id
  const revision = cycle.current_revision
  if (cycle.state === 'rework') {
    const intentId = `${cycle.task_id}:rework:${revision}`
    const currentWriter = cycle.active_writer_dispatch_id ?? cycle.writer_dispatch_id
    const previous = getEntryReviewDispatchIntent(db, intentId)
    if (!previous) {
      if (cycle.reviewed_dispatch_id !== reviewer) {
        throw new Error('The prior rework dispatch must be verified before it can be retried.')
      }
      const blocked = db
        .listReviewOpinions(cycle.cycle_id)
        .filter((finding) => finding.revision === revision && finding.state === 'blocked')
      const launch = db.getWorkerDispatch(currentWriter)
      if (!launch?.worktree_id || blocked.length === 0) {
        throw new Error('The rework has no verified writer workspace or blocking opinions.')
      }
      reserveEntryReviewDispatch(db, intentId, action.sub_action_id, {
        spec: [
          `返工 R${revision}：复审提出以下阻塞意见，请在原工作区修复后重新提交。`,
          ...blocked.map((finding) => `[${finding.opinion_id}] ${finding.body}`)
        ].join('\n'),
        taskTitle: `返工 R${revision} · ${actionTitleOf(db, cycle.task_id)}`,
        agent: workerStartOptionsAgent(launch.start_options ?? '') ?? 'codex',
        worktreeId: launch.worktree_id,
        readOnly: false
      })
    }
    const writer = await dispatchReviewIntent(db, intentId, spawnWorker)
    if (currentWriter !== writer) {
      db.setReviewCycleAutomation({ cycleId: cycle.cycle_id, activeWriterDispatchId: writer })
      return
    }
    if (workerCompleted(db, writer)) {
      await startNextReview(args)
    }
    return
  }

  if (!workerCompleted(db, reviewer)) {
    return
  }
  const launch = db.getWorkerDispatch(reviewer)
  if (!launch?.worktree_id) {
    throw new Error('The reviewer workspace is unavailable.')
  }
  const intent = getEntryReviewDispatchIntent(db, reviewIntentId(cycle.task_id, revision))
  const spec = intent && (JSON.parse(intent.spec_json) as EntryReviewDispatchSpec)
  if (!spec?.workspaceRevision || intent?.dispatch_id !== reviewer) {
    await startNextReview(args)
    return
  }
  if (cycle.reviewed_dispatch_id === reviewer) {
    if (!cycle.reviewed_workspace_revision) {
      await startNextReview(args)
    }
    return
  }
  if (
    (await readEntryReviewWorkspaceRevision(runtime, launch.worktree_id)) !== spec.workspaceRevision
  ) {
    await startNextReview(args)
    return
  }
  const findings = parseReviewOpinions(taskOfDispatch(db, reviewer)?.result ?? null, revision)
  if (!findings) {
    throw new Error('The reviewer did not return a valid verdict for this revision.')
  }
  runLifecycleWriteTransaction(db.db, 'record_entry_review', () => {
    const current = db.getReviewCycle(cycle.cycle_id)
    if (current.current_revision !== revision || current.reviewed_dispatch_id === reviewer) {
      return
    }
    for (const finding of findings) {
      db.recordReviewOpinion({ cycleId: cycle.cycle_id, ...finding })
    }
    db.setReviewCycleAutomation({
      cycleId: cycle.cycle_id,
      reviewedDispatchId: reviewer,
      reviewedWorkspaceRevision: spec.workspaceRevision
    })
  })
  if (findings.some((finding) => finding.blocking)) {
    await advanceReviewCycle({ ...args, cycle: db.getReviewCycle(cycle.cycle_id) })
  }
}

async function startNextReview(args: ReviewRoundArgs & { cycle: ReviewCycleRow }): Promise<void> {
  const { runtime, db, action, cycle, spawnWorker } = args
  const reviewer = cycle.active_reviewer_dispatch_id ?? cycle.reviewer_dispatch_id
  const launch = db.getWorkerDispatch(reviewer)
  if (!launch?.worktree_id) {
    throw new Error('The reviewer workspace is unavailable.')
  }
  const revision = cycle.current_revision + 1
  const intentId = reviewIntentId(cycle.task_id, revision)
  if (!getEntryReviewDispatchIntent(db, intentId)) {
    reserveEntryReviewDispatch(db, intentId, action.sub_action_id, {
      spec: [
        `复审 R${revision}：核对当前工作区与需求，并逐条检查上一轮阻塞意见。`,
        REVIEW_SPEC_MARKER_NOTE,
        action.text,
        ...db
          .listReviewOpinions(cycle.cycle_id)
          .filter((opinion) => opinion.revision === cycle.current_revision)
          .map((opinion) => `[${opinion.opinion_id}] ${opinion.body}`),
        '输出格式（严格逐行）：[R{n}-XX] blocking|note: …。无阻塞时单独输出：无阻塞意见。'
      ].join('\n'),
      taskTitle: `复审 R${revision} · ${actionTitleOf(db, cycle.task_id)}`,
      agent: workerStartOptionsAgent(launch.start_options ?? '') ?? 'codex',
      worktreeId: launch.worktree_id,
      readOnly: true,
      workspaceRevision: await readEntryReviewWorkspaceRevision(runtime, launch.worktree_id)
    })
  }
  const next = await dispatchReviewIntent(db, intentId, spawnWorker)
  db.advanceEntryReviewRevision(cycle.cycle_id, cycle.current_revision, next)
}

function workerCompleted(db: OrchestrationDb, dispatchId: string): boolean {
  const task = taskOfDispatch(db, dispatchId)
  if (!task || task.status === 'failed' || task.status === 'blocked') {
    throw new Error(
      `Review worker ${dispatchId} did not complete. Check its recorded execution before retrying.`
    )
  }
  return task.status === 'completed'
}

function taskOfDispatch(db: OrchestrationDb, dispatchId: string): TaskRow | undefined {
  const dispatch = db.getDispatchContextById(dispatchId)
  return dispatch ? db.getTask(dispatch.task_id) : undefined
}

function actionTitleOf(db: OrchestrationDb, taskId: string): string {
  const subAction = db.getRoutingSubActionByTask(taskId)
  const text = subAction?.text ?? ''
  return text.length > 16 ? `${text.slice(0, 16)}…` : text
}
