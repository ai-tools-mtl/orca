import { entryDeletionCandidates } from './entry-request-deletion'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import {
  savedOrcaPlanParseError,
  savedOrcaPlanStages
} from '../../../orchestration/routing/orca-plan-parse'
import { stagePlanUnusable } from '../../../orchestration/routing/routing-stage-gates'
import {
  workerStartOptionsAgent,
  workerStartOptionsReadOnly
} from '../../../orchestration/workers/launch/worker-launch-observation'
import { routingInputsPayload } from './routing-supplements'

export function entryInputsWithResults(db: OrchestrationDb, runId: string) {
  const tasks = new Map(db.listTasks({ runId }).map((task) => [task.id, task]))
  const { inputs } = routingInputsPayload(db, runId)
  const deletions = new Map(
    entryDeletionCandidates(db, runId).map((entry) => [entry.input.input_id, entry])
  )
  type Entry = (typeof inputs)[number]['subActions'][number]
  const deliveriesByTask = new Map<string, { original: string; deliveries: Entry['deliveries'] }>()
  for (const { subActions } of inputs) {
    for (const { subAction, deliveries } of subActions) {
      if (!subAction.task_id) {
        continue
      }
      const taskHistory = deliveriesByTask.get(subAction.task_id)
      if (taskHistory) {
        taskHistory.deliveries.push(...deliveries)
      } else {
        deliveriesByTask.set(subAction.task_id, {
          original: subAction.sub_action_id,
          deliveries: [...deliveries]
        })
      }
    }
  }
  const errors = new Map<string, { text: string; at: string }>()
  for (const message of db.getAllMessagesForHandle(`run:${runId}`, 100, ['escalation'], runId)) {
    const report = parseEntryJson(message.payload)
    if (
      report &&
      'dispatchId' in report &&
      typeof report.dispatchId === 'string' &&
      'error' in report &&
      typeof report.error === 'string' &&
      !errors.has(report.dispatchId)
    ) {
      errors.set(report.dispatchId, { text: report.error, at: message.created_at })
    }
  }
  const pendingAsks = new Map<
    string,
    { messageId: string; body: string; createdAt: string; dispatchId: string }[]
  >()
  for (const { taskId, question, ...ask } of db.listPendingQuestions(runId)) {
    const questions = pendingAsks.get(taskId) ?? []
    questions.push({ ...ask, body: question })
    pendingAsks.set(taskId, questions)
  }
  const answeredAsks = new Map<
    string,
    Omit<ReturnType<OrchestrationDb['listAnsweredQuestions']>[number], 'taskId'>[]
  >()
  for (const { taskId, ...ask } of db.listAnsweredQuestions(runId).toReversed()) {
    const questions = answeredAsks.get(taskId) ?? []
    questions.push(ask)
    answeredAsks.set(taskId, questions)
  }
  return {
    inputs: inputs.map((input) => {
      const deletion = deletions.get(input.input.input_id)
      return {
        ...input,
        canDelete: deletion?.canDelete ?? false,
        canDeleteFailed: Boolean(
          deletion?.deleteFailedRequest || deletion?.states.some((state) => state.canDeleteFailed)
        ),
        subActions: input.subActions.map((entry) => {
          const actionDeletion = deletion?.states.find(
            (state) => state.id === entry.subAction.sub_action_id
          )
          const taskId = entry.subAction.task_id
          const task = taskId ? tasks.get(taskId) : undefined
          const taskHistory = taskId ? deliveriesByTask.get(taskId) : undefined
          const ownsTaskHistory = taskHistory?.original === entry.subAction.sub_action_id
          const dispatch = task && db.getDispatchContext(task.id)
          const launch = dispatch && db.getWorkerDispatch(dispatch.id)
          const active = dispatch?.status === 'pending' || dispatch?.status === 'dispatched'
          const reportedError = dispatch && active ? errors.get(dispatch.id) : undefined
          const questions = taskId && ownsTaskHistory ? pendingAsks.get(taskId) : undefined
          return {
            ...entry,
            canDelete: actionDeletion?.canDelete ?? false,
            assignmentFailed: actionDeletion?.failed ?? false,
            planUnusable: stagePlanUnusable(entry.subAction),
            planParseError: savedOrcaPlanParseError(entry.subAction.plan_json),
            planStages: savedOrcaPlanStages(entry.subAction.plan_json),
            mergedAt: entry.subAction.merged_at,
            mergeReceipt: entryChainMergeReceipt(entry.subAction.merge_receipt_json),
            deliveries: ownsTaskHistory && taskHistory ? taskHistory.deliveries : entry.deliveries,
            pendingAsk: questions?.at(-1) ?? null,
            pendingAsks: questions ?? [],
            answeredAsks: taskId && ownsTaskHistory ? (answeredAsks.get(taskId) ?? null) : null,
            execution:
              task && dispatch
                ? {
                    agent: launch ? workerStartOptionsAgent(launch.start_options) : null,
                    dispatchId: dispatch.id,
                    worktreeId: launch?.worktree_id ?? null,
                    readOnly: launch ? workerStartOptionsReadOnly(launch.start_options) : false,
                    terminalHandle: launch?.agent_terminal_handle ?? null,
                    sessionId: dispatch.assignee_orca_session_id ?? null,
                    completedAt: task.completed_at ?? null,
                    status: reportedError ? ('attention' as const) : dispatch.status,
                    result: entryResultText(task.result),
                    failure: reportedError?.text ?? launch?.last_error ?? dispatch.last_failure,
                    failureAt:
                      reportedError?.at ??
                      (dispatch.status === 'failed' || dispatch.status === 'circuit_broken'
                        ? (dispatch.completed_at ?? dispatch.capability_revoked_at)
                        : null)
                  }
                : null
          }
        })
      }
    })
  }
}

/** Typed read-back of a merge checkpoint's receipt ({"commitSha":…,"baseBranch":…}). */
function entryChainMergeReceipt(text: string | null): {
  commitSha: string | null
  baseBranch: string
} | null {
  const value = parseEntryJson(text)
  return value &&
    'commitSha' in value &&
    'baseBranch' in value &&
    (value.commitSha === null || typeof value.commitSha === 'string') &&
    typeof value.baseBranch === 'string'
    ? { commitSha: value.commitSha, baseBranch: value.baseBranch }
    : null
}

function entryResultText(result: string | null): string | null {
  const value = parseEntryJson(result)
  if (value && 'provenance' in value && value.provenance === 'worker_report') {
    return (
      ('body' in value && typeof value.body === 'string' && value.body.trim()) ||
      ('subject' in value && typeof value.subject === 'string' && value.subject) ||
      null
    )
  }
  return result
}

/** 确定性进展摘要（§5.1：统一展示用 Worker 结果与确定性模板，不再过模型）：状态查询类
 *  消息的"回答"就是这份快照，注册决策时作为 no-op 原因上卡。 */
export function entryStatusDigest(db: OrchestrationDb, runId: string): string | undefined {
  const lines = entryStatusLines(db, runId)
  if (lines.length === 0) {
    return undefined
  }
  // 近期项目摘要显式限幅（设计 §动作协议与上下文）：与候选窗口一同约束路由上下文大小。
  return lines.join('；').slice(0, 400)
}

function entryStatusLines(db: OrchestrationDb, runId: string): string[] {
  const { inputs } = entryInputsWithResults(db, runId)
  const lines: string[] = []
  for (const input of inputs) {
    for (const entry of input.subActions) {
      const label = entryStatusLabel(entry.subAction, entry.execution)
      if (label) {
        lines.push(`${entry.subAction.text}：${label}`)
      }
    }
  }
  return lines
}

/** 单任务的账本状态行（混合策略直通分支）：意图分类点名候选任务时，答案从这份运行时事实
 *  生成——模型不代答。 */
export function entryTaskStatusAnswer(
  db: OrchestrationDb,
  runId: string,
  taskId: string
): string | undefined {
  const entry = entryInputsWithResults(db, runId)
    .inputs.flatMap((input) => input.subActions)
    .find((candidate) => candidate.subAction.task_id === taskId)
  if (!entry) {
    return undefined
  }
  const label = entryStatusLabel(entry.subAction, entry.execution)
  return label ? `${entry.subAction.text}：${label}` : undefined
}

function entryStatusLabel(
  subAction: {
    text: string
    task_id: string | null
    gate: string | null
    gate_granted_at: string | null
    paused_at: string | null
  },
  execution: { status: string; completedAt: string | null } | null
): string | undefined {
  if (!subAction.task_id) {
    if (subAction.paused_at) {
      return '已暂停'
    }
    if (subAction.gate === 'user_confirm' && !subAction.gate_granted_at) {
      return '等待你确认'
    }
    return '待派发'
  }
  if (!execution) {
    return '待派发'
  }
  if (execution.completedAt) {
    return execution.status === 'failed' ? '失败' : '已完成'
  }
  if (execution.status === 'failed') {
    return '失败'
  }
  return '进行中'
}

function parseEntryJson(text: string | null): object | undefined {
  if (!text?.startsWith('{')) {
    return
  }
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}
