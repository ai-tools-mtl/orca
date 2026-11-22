import type {
  RoutingEntryAnsweredAsk,
  RoutingEntryPendingAsk
} from '../workspace-card/activity/entry-question-records'
import type {
  RoutingEntryApproval,
  RoutingEntryExecution,
  RoutingEntryInput,
  RoutingEntrySubAction
} from '../workspace-card/activity/routing-entry-model'
import { entryTimelineTaskStatus, type EntryTimelineStatusCounts } from './entry-timeline-status'
import { entryDateOf } from './entry-task-view'

type TaskContext = { input: RoutingEntryInput; action: RoutingEntrySubAction }
type CheckpointState = 'waiting' | 'confirmed' | 'plan-invalid' | 'merged' | 'merge-failed'

export type EntryTimelineEvent = { id: string; at?: Date } & (
  | { kind: 'request'; input: RoutingEntryInput }
  | ({ kind: 'ask'; ask: RoutingEntryPendingAsk | RoutingEntryAnsweredAsk } & TaskContext)
  | ({ kind: 'result'; execution: RoutingEntryExecution; failed: boolean } & TaskContext)
  | ({ kind: 'checkpoint'; state: CheckpointState } & TaskContext)
  | { kind: 'approval'; approval: RoutingEntryApproval; owner?: TaskContext }
)

export function entryResultId(action: RoutingEntrySubAction): string {
  return `entry-result-${action.subActionId}`
}

export function entryResultActionOf(event: EntryTimelineEvent): RoutingEntrySubAction | undefined {
  return event.kind === 'result' ||
    (event.kind === 'checkpoint' && (event.state === 'merged' || event.state === 'merge-failed'))
    ? event.action
    : undefined
}

export function hasEntryResult(
  execution: RoutingEntryExecution | undefined
): execution is RoutingEntryExecution {
  return Boolean(
    execution &&
    (execution.result ||
      execution.failure ||
      execution.status === 'completed' ||
      execution.status === 'failed' ||
      execution.status === 'circuit_broken')
  )
}

export function entryTimelineEventsOf(
  inputs: readonly RoutingEntryInput[],
  approvals: readonly RoutingEntryApproval[]
): EntryTimelineEvent[] {
  const events: EntryTimelineEvent[] = []
  const owners = new Map<string, TaskContext>()
  for (const input of inputs) {
    events.push({
      kind: 'request',
      id: `entry-request-${input.inputId}`,
      input,
      at: entryDateOf(input.receivedAt)
    })
    for (const action of input.subActions) {
      if (action.resumed) {
        continue
      }
      const context = { input, action }
      const execution = action.execution
      if (execution && !owners.has(execution.dispatchId)) {
        owners.set(execution.dispatchId, context)
      }
      for (const ask of [...(action.answeredAsks ?? []), ...(action.pendingAsks ?? [])]) {
        events.push({
          ...context,
          kind: 'ask',
          id: `entry-ask-${ask.messageId}`,
          ask,
          at: entryDateOf(ask.createdAt)
        })
      }
      if (hasEntryResult(execution)) {
        const failed =
          execution.status === 'failed' ||
          execution.status === 'circuit_broken' ||
          (execution.status !== 'completed' && Boolean(execution.failure) && !execution.result)
        events.push({
          ...context,
          kind: 'result',
          id: entryResultId(action),
          execution,
          failed,
          at: entryDateOf(
            (failed ? (execution.failureAt ?? execution.completedAt) : execution.completedAt) ??
              undefined
          )
        })
      }
      const merge = action.stageKind === 'merge'
      const gateAt = merge ? action.createdAt : (execution?.completedAt ?? undefined)
      if (
        action.stageKind &&
        action.gate === 'user_confirm' &&
        (merge || execution?.status === 'completed' || action.gateGrantedAt)
      ) {
        events.push({
          ...context,
          kind: 'checkpoint',
          id: `entry-gate-${action.subActionId}`,
          at: entryDateOf(gateAt),
          state: action.gateGrantedAt
            ? 'confirmed'
            : action.planUnusable
              ? 'plan-invalid'
              : 'waiting'
        })
      }
      if (merge && (action.mergedAt || (action.gateGrantedAt && action.assignmentError))) {
        events.push({
          ...context,
          kind: 'checkpoint',
          id: entryResultId(action),
          at: entryDateOf(action.mergedAt),
          state: action.mergedAt ? 'merged' : 'merge-failed'
        })
      }
    }
  }
  for (const approval of approvals) {
    events.push({
      kind: 'approval',
      id: `entry-approval-${approval.dispatchId}-${approval.approvalId}`,
      approval,
      owner: owners.get(approval.dispatchId),
      at: entryDateOf(approval.createdAt)
    })
  }
  return events.sort((a, b) => (a.at?.getTime() ?? -Infinity) - (b.at?.getTime() ?? -Infinity))
}

export type EntryTimelineDay = {
  day: number | null
  label?: string
  isToday: boolean
  isArchived: boolean
  rows: EntryTimelineEvent[]
  statusCounts: EntryTimelineStatusCounts
}

export function startOfEntryDay(date: Date): number {
  const day = new Date(date)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

function entryStatusCountsOf(
  rows: readonly EntryTimelineEvent[],
  awaitingApproval: ReadonlySet<string>
): EntryTimelineStatusCounts {
  const counts = { running: 0, queued: 0, reply: 0 }
  for (const event of rows) {
    if (event.kind === 'ask' && !('answer' in event.ask)) {
      counts.reply++
    }
    if (event.kind === 'request') {
      for (const action of event.input.subActions) {
        const dispatchId = action.execution?.dispatchId
        const status = entryTimelineTaskStatus(
          action,
          dispatchId !== undefined && awaitingApproval.has(dispatchId)
        )
        if (status) {
          counts[status]++
        }
      }
    }
  }
  return counts
}

export function entryTimelineDaysOf(
  events: readonly EntryTimelineEvent[],
  today: number,
  locale: string
): EntryTimelineDay[] {
  const format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })
  const recentStart = new Date(today)
  recentStart.setDate(recentStart.getDate() - 2)
  const awaitingApproval = new Set(
    events.flatMap((event) => (event.kind === 'approval' ? [event.approval.dispatchId] : []))
  )
  const groups = new Map<number | null, EntryTimelineEvent[]>([[today, []]])
  for (const event of events) {
    const day = event.at ? startOfEntryDay(event.at) : null
    const rows = groups.get(day) ?? []
    rows.push(event)
    groups.set(day, rows)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a ?? -Infinity) - (b ?? -Infinity))
    .map(([day, rows]) => ({
      day,
      rows,
      statusCounts: entryStatusCountsOf(rows, awaitingApproval),
      label: day === null ? undefined : format.format(day),
      isToday: day === today,
      isArchived: day === null || day < recentStart.getTime()
    }))
}
