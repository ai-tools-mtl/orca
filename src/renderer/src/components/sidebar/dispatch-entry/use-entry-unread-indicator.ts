import { useEffect, useState } from 'react'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/rpc/targets/runtime-client-target'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { peekEntryInputs } from '../workspace-card/activity/entry-facts-rpc'
import type { RoutingEntrySubAction } from '../workspace-card/activity/routing-entry-model'
import { entryResultActionOf, entryTimelineEventsOf } from './entry-timeline-events'
import { isEntryResultUnread, useEntrySeenResults } from './use-entry-result-read-state'

export function useEntryUnreadIndicator(repoId: string, hostId: ExecutionHostId): boolean {
  const projectKey = JSON.stringify([hostId, repoId])
  const seen = useEntrySeenResults(projectKey)
  const [snapshot, setSnapshot] = useState<{
    projectKey: string
    results: RoutingEntrySubAction[]
  }>()

  useEffect(() => {
    const target = ipcOrRuntimeTargetForHostId(hostId)
    if (!target) {
      return
    }
    let active = true
    let timer: number
    const poll = async (): Promise<void> => {
      const inputs = await peekEntryInputs(target, repoId).catch(() => undefined)
      if (!active) {
        return
      }
      if (inputs) {
        const results = entryTimelineEventsOf(inputs, [])
          .map(entryResultActionOf)
          .filter((action) => action !== undefined)
        setSnapshot({ projectKey, results })
      }
      timer = window.setTimeout(poll, 5000)
    }
    void poll()
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [hostId, projectKey, repoId])

  return (
    snapshot?.projectKey === projectKey &&
    snapshot.results.some((result) => isEntryResultUnread(result, seen))
  )
}
