import type { Translate } from '@/i18n/use-translate'
import type { RoutingEntrySubAction } from '../workspace-card/activity/routing-entry-model'
import { displayNameOf, entryCardStateOf, isEntryStageWaitingForDispatch } from './entry-task-view'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

export type EntryTimelineStatus = 'running' | 'queued' | 'reply'
export type EntryTimelineStatusCounts = Record<EntryTimelineStatus, number>

export function entryTaskPresentation(
  action: RoutingEntrySubAction,
  awaitingApproval: boolean,
  t: Translate
) {
  const state = action.pausedAt
    ? 'paused'
    : action.queuedAt && !action.execution
      ? 'queued'
      : entryCardStateOf(action, awaitingApproval || Boolean(action.pendingAsks?.length))
  const statusByState = {
    paused: [t(`${ENTRY}.paused`, 'Paused'), 'neutral'],
    queued: [t(`${ENTRY}.boardQueued`, 'Queued'), 'neutral'],
    idle: [t(`${ENTRY}.stageWaiting`, 'Awaiting auto-dispatch'), 'neutral'],
    working: [t(`${ENTRY}.workerRunning`, 'Running'), 'warning'],
    attention: [t(`${ENTRY}.workerAttention`, 'Needs attention'), 'warning'],
    done: [t(`${ENTRY}.workerCompleted`, 'Completed'), 'success'],
    failed: [t(`${ENTRY}.workerFailed`, 'Failed'), 'error']
  } as const
  const [status, tone] = statusByState[state]
  const agent = action.execution?.agent ?? action.agentHint
  return {
    state,
    status,
    tone,
    sender: agent ? displayNameOf(agent) : undefined,
    activity: entryTimelineTaskStatus(action, awaitingApproval)
  }
}

export function entryTimelineTaskStatus(
  action: RoutingEntrySubAction,
  awaitingApproval: boolean
): 'running' | 'queued' | undefined {
  if (action.resumed || action.pausedAt || action.pendingAsks?.length || awaitingApproval) {
    return undefined
  }
  if (entryCardStateOf(action, false) === 'working') {
    return 'running'
  }
  if ((action.queuedAt && !action.execution) || isEntryStageWaitingForDispatch(action)) {
    return 'queued'
  }
  return undefined
}
