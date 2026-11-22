import { useAppStore } from '@/store'
import type { RoutingEntrySubAction } from '../workspace-card/activity/routing-entry-model'
import { executionMarkerOf } from './entry-task-facts'

let readQueue = Promise.resolve()

export function useEntrySeenResults(projectKey: string) {
  return useAppStore((state) => state.settings?.dispatchEntrySeenResults?.[projectKey])
}

export function isEntryResultUnread(
  action: RoutingEntrySubAction,
  seenResults: Readonly<Record<string, string>> | undefined
): boolean {
  const marker = executionMarkerOf(action)
  return Boolean(marker && seenResults?.[action.subActionId] !== marker)
}

export function useEntryResultReadState(projectKey: string, onError: (message: string) => void) {
  const seenResults = useEntrySeenResults(projectKey)

  function markSeen(action: RoutingEntrySubAction): void {
    const marker = executionMarkerOf(action)
    if (!marker) {
      return
    }
    readQueue = readQueue
      .then(async () => {
        const state = useAppStore.getState()
        const current = state.settings?.dispatchEntrySeenResults?.[projectKey] ?? {}
        if (current[action.subActionId] === marker) {
          return
        }
        await state.updateSettingsOrThrow({
          dispatchEntrySeenResults: {
            ...state.settings?.dispatchEntrySeenResults,
            [projectKey]: { ...current, [action.subActionId]: marker }
          }
        })
      })
      .catch((error: unknown) => onError(String(error)))
  }

  return {
    isUnread: (action: RoutingEntrySubAction) => isEntryResultUnread(action, seenResults),
    markSeen
  }
}
