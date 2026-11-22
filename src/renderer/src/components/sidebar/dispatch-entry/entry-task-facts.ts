import type {
  RoutingEntryApproval,
  RoutingEntryInput,
  RoutingEntrySubAction,
  RoutingReviewState
} from '../workspace-card/activity/routing-entry-model'
import {
  bucketOfCardState,
  displayNameOf,
  entryCardStateOf,
  type EntryCardState
} from './entry-task-view'

/** One dispatched task as the 看板 lane card and the 任务列表 row both render it. */
export type EntryTaskFact = {
  subActionId: string
  title: string
  /** 'queued' 只属于未派发的阶段行（entryCardStateOf 永不产出它）。 */
  state: EntryCardState | 'queued'
  bucket: 'attention' | 'working' | 'queued' | 'done' | 'idle'
  agent?: string
  worktreeName?: string
  preview?: string
  isQuestion: boolean
}

export function entryTaskFactsOf(
  inputs: readonly RoutingEntryInput[],
  pendingApprovalDispatches: ReadonlyMap<string, RoutingEntryApproval>,
  reviews: ReadonlyMap<string, RoutingReviewState>,
  worktreeNameOf: (worktreeId: string | null | undefined) => string | undefined
): EntryTaskFact[] {
  const facts: EntryTaskFact[] = []
  for (const input of inputs) {
    for (const action of input.subActions) {
      // Continuations (续接) merge into their task's first sub-action — one board card per task.
      if (action.resumed) {
        continue
      }
      // 排队中的阶段（原型 BUCKETS）：派发前的阶段行没有任务卡，但看板要有排队态——
      // 否则链在"上游未完成→下游未派发"的窗口在板上完全隐形。
      if (!action.taskId && !action.execution) {
        if (action.stageKind) {
          facts.push({
            subActionId: action.subActionId,
            title: action.text,
            state: 'queued',
            bucket: 'queued',
            agent: action.agentHint ?? undefined,
            isQuestion: false
          })
        }
        continue
      }
      const approval = action.execution
        ? pendingApprovalDispatches.get(action.execution.dispatchId)
        : undefined
      const review = action.taskId ? reviews.get(action.taskId) : undefined
      const blocked = review
        ? review.opinions.some((opinion) => opinion.state === 'blocked')
        : false
      const state = entryCardStateOf(action, Boolean(approval))
      facts.push({
        subActionId: action.subActionId,
        title: action.text,
        state,
        bucket: bucketOfCardState(state),
        agent: action.execution?.agent ?? undefined,
        worktreeName: worktreeNameOf(action.execution?.worktreeId),
        preview:
          approval?.title ?? action.execution?.result ?? action.execution?.failure ?? undefined,
        isQuestion: Boolean(approval) || blocked
      })
    }
  }
  return facts
}

export function entryFactAgentLabel(fact: EntryTaskFact): string {
  return fact.agent ? displayNameOf(fact.agent) : ''
}

/** A result is unseen until its marker (completion + content size) has been marked seen —
 *  the dispatch-entry's unread badge compares this against the seen-results setting. */
export function executionMarkerOf(action: RoutingEntrySubAction): string {
  const execution = action.execution
  if (!execution) {
    return action.mergedAt
      ? `merged|${action.mergedAt}`
      : action.stageKind === 'merge' && action.assignmentError
        ? `merge-failed|${action.gateGrantedAt ?? ''}|${action.assignmentError}`
        : ''
  }
  return `${execution.completedAt ?? ''}|${execution.result?.length ?? 0}|${execution.failure?.length ?? 0}`
}
