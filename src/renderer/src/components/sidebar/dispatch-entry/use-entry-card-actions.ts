import { useRef } from 'react'
import { toast } from 'sonner'
import { activateWorktreeFromSidebar } from '@/lib/workspace/activation/sidebar-worktree-activation'
import type { ipcOrRuntimeTargetForHostId } from '@/runtime/rpc/targets/runtime-client-target'
import { useAppStore } from '@/store'
import { entryResultId, hasEntryResult } from './entry-timeline-events'
import { openEntrySession } from './open-entry-session'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { RoutingEntrySubAction } from '../workspace-card/activity/routing-entry-model'
import type { useRoutingEntryFacts } from '../workspace-card/activity/use-routing-entry-facts'

type RoutingEntryFacts = ReturnType<typeof useRoutingEntryFacts>

/** Timeline card actions; the opened-session dedupe ref outlives single renders. */
export function useEntryCardActions({
  facts,
  target,
  worktrees,
  hostId,
  isUnread,
  markSeen,
  locateEvent,
  onWorkspaceOpened,
  onActionError
}: {
  facts: RoutingEntryFacts
  target: ReturnType<typeof ipcOrRuntimeTargetForHostId>
  worktrees: Worktree[] | undefined
  hostId: ExecutionHostId
  isUnread: (action: RoutingEntrySubAction) => boolean
  markSeen: (action: RoutingEntrySubAction) => void
  locateEvent: (id: string, read?: RoutingEntrySubAction) => void
  onWorkspaceOpened: () => void
  onActionError: (message: string) => void
}): (action: RoutingEntrySubAction) => {
  unread: boolean
  onOpenResult: (() => void) | undefined
  onTogglePause: ((paused: boolean) => void) | undefined
  onOpenSession: (() => void) | undefined
  onOpenDiff: (() => void) | undefined
} {
  const openingSession = useRef(false)
  return (action) => {
    const execution = action.execution
    const { claimedBy } = action
    const transferred = claimedBy && claimedBy !== execution?.dispatchId
    const session = transferred ? { dispatchId: claimedBy } : execution
    const hasResult = hasEntryResult(execution)
    return {
      unread: hasResult && isUnread(action),
      onOpenResult: hasResult ? () => locateEvent(entryResultId(action), action) : undefined,
      onTogglePause:
        action.taskId || action.execution
          ? (paused: boolean) => {
              void facts
                .setPaused(paused, action.subActionId)
                .catch((error: unknown) => onActionError(String(error)))
            }
          : undefined,
      onOpenSession:
        target && session && (transferred || execution?.terminalHandle || execution?.sessionId)
          ? () => {
              if (openingSession.current) {
                return
              }
              openingSession.current = true
              void openEntrySession(target, session)
                .then((opened) => {
                  if (opened) {
                    if (hasResult) {
                      markSeen(action)
                    }
                    onWorkspaceOpened()
                  }
                })
                .catch((error: unknown) => toast.error(String(error)))
                .finally(() => {
                  openingSession.current = false
                })
            }
          : undefined,
      onOpenDiff: action.execution?.worktreeId
        ? () => {
            const worktree = worktrees?.find((row) => row.id === action.execution?.worktreeId)
            if (!worktree) {
              return
            }
            void activateWorktreeFromSidebar(worktree.id, hostId)
              .then(() => {
                onWorkspaceOpened()
                const store = useAppStore.getState()
                store.openAllDiffs(worktree.id, worktree.path)
                store.setRightSidebarTab('source-control')
                store.setRightSidebarOpen(true)
              })
              .catch((error: unknown) => onActionError(String(error)))
          }
        : undefined
    }
  }
}
