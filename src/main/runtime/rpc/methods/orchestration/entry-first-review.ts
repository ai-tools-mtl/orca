import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import type { TaskRow } from '../../../orchestration/db/orchestration-records'
import type { RoutingSubActionRow } from '../../../orchestration/db/routing-records'
import { runLifecycleWriteTransaction } from '../../../orchestration/db/lifecycle-write-transaction-runner'
import {
  dispatchReviewIntent,
  getEntryReviewDispatchIntent,
  reserveEntryReviewDispatch,
  reviewIntentId,
  type EntryLoopSpawn
} from '../../../orchestration/review/entry-review-dispatch-intent'
import { workerStartOptionsAgent } from '../../../orchestration/workers/launch/worker-launch-observation'
import { resolveStageUpstream } from '../../../orchestration/routing/routing-stage-gates'
import type { EntryPlacement } from './entry-placement'
import { readEntryReviewWorkspaceRevision } from './entry-review-workspace-revision'
import { parseWorkerReport, pickReviewerAgent } from './entry-reviewer-pick'

export const REVIEW_SPEC_MARKER_NOTE =
  '只读审查：不要修改任何文件；先用只读命令核对工作区改动，再输出意见。'

export type ReviewRoundArgs = {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  action: RoutingSubActionRow
  spawnWorker: EntryLoopSpawn
}

export async function startReviewRound(
  args: ReviewRoundArgs & {
    placement: EntryPlacement
    task: TaskRow
  }
): Promise<void> {
  const { runtime, db, placement, action, task, spawnWorker } = args
  const writerDispatch = db.getDispatchContext(task.id)
  if (!writerDispatch) {
    return
  }
  const writerLaunch = db.getWorkerDispatch(writerDispatch.id)
  const worktreeId = writerLaunch?.worktree_id
  if (!worktreeId) {
    return
  }
  const intentId = reviewIntentId(task.id, 1)
  const existing = getEntryReviewDispatchIntent(db, intentId)
  if (existing) {
    const reviewer = await dispatchReviewIntent(db, intentId, spawnWorker)
    startCycleOnce(db, task.id, writerDispatch.id, reviewer)
    return
  }
  const writerAgent = writerLaunch
    ? workerStartOptionsAgent(writerLaunch.start_options ?? '')
    : null
  const reviewModelJson = db.getRoutingInput(action.input_id)?.review_model_json
  // 原型审查固定优先 claude 对照需求（用户设计）；其余走决策模型挑选 + 静态链。
  const reviewerAgent =
    action.stage_kind === 'prototype' &&
    writerAgent !== 'claude' &&
    placement.agents.includes('claude')
      ? 'claude'
      : await pickReviewerAgent(reviewModelJson, placement.agents, writerAgent)
  if (!reviewerAgent) {
    throw new Error('No independent reviewer is available for this task.')
  }
  const report = parseWorkerReport(task.result)
  const writerDispatchId = writerDispatch.id
  // 原型审查的对照物是需求本身：原始需求原文 + 上游需求说明报告一起进审查 spec。
  const upstream = resolveStageUpstream(db, action)
  const requirementContext =
    action.stage_kind === 'prototype'
      ? [
          `原始需求：\n${db.getRoutingInput(action.input_id)?.raw_text ?? ''}`,
          ...(upstream?.rows.map((row) => {
            const upstreamTask = row.task_id ? db.getTask(row.task_id) : undefined
            const upstreamReport = parseWorkerReport(upstreamTask?.result ?? null)
            return upstreamReport?.body ? `需求说明：${upstreamReport.body}` : undefined
          }) ?? [])
        ].filter(Boolean)
      : []
  reserveEntryReviewDispatch(db, intentId, action.sub_action_id, {
    spec: [
      ...requirementContext,
      `审查任务「${action.text}」的第一版改动（R1）：逐项核对是否与上述需求对应。`,
      `写手工作区：${worktreePathOf(worktreeId)}（只读核对，不修改任何文件）。${REVIEW_SPEC_MARKER_NOTE}`,
      report?.subject ? `写手报告标题：${report.subject}` : undefined,
      report?.body ? `写手报告：\n${report.body}` : undefined,
      report?.filesModified?.length
        ? `改动文件：\n${report.filesModified.map((file) => `- ${file}`).join('\n')}`
        : undefined,
      '输出格式（严格逐行）：',
      '[R1-01] blocking: <阻塞意见，必须修复才能验收>',
      '[R1-02] note: <非阻塞建议>',
      '没有问题则单独输出一行：无阻塞意见。'
    ]
      .filter(Boolean)
      .join('\n'),
    taskTitle: `审查 · ${action.text}`,
    agent: reviewerAgent,
    worktreeId,
    readOnly: true,
    workspaceRevision: await readEntryReviewWorkspaceRevision(runtime, worktreeId)
  })
  const reviewer = await dispatchReviewIntent(db, intentId, spawnWorker)
  startCycleOnce(db, task.id, writerDispatchId, reviewer)
}

function startCycleOnce(db: OrchestrationDb, taskId: string, writer: string, reviewer: string) {
  runLifecycleWriteTransaction(db.db, 'start_entry_review', () => {
    if (!db.getLatestReviewCycleForTask(taskId)) {
      db.startReviewCycle({ taskId, writerDispatchId: writer, reviewerDispatchId: reviewer })
    }
  })
}

function worktreePathOf(worktreeId: string): string {
  const index = worktreeId.indexOf('::')
  return index === -1 ? worktreeId : worktreeId.slice(index + 2)
}
