import { useEffect, useMemo, useState } from 'react'
import { entryDateOf } from './entry-task-view'
import type { RoutingEntryInput } from '../workspace-card/activity/routing-entry-model'

/** The 澄清回复 composer mode (§2): armed while a worker's ask awaits — the main composer's
 *  text IS the answer (entryAnswerAsk wakes the worker), not a new request. The user can turn
 *  it off to send new work; a fresh ask id re-arms it automatically. */
export function useEntryAskMode(inputs: RoutingEntryInput[]) {
  const pendingAsks = useMemo(
    () =>
      inputs
        .flatMap((input) =>
          input.subActions.flatMap((action) => (action.resumed ? [] : (action.pendingAsks ?? [])))
        )
        .sort(
          (a, b) =>
            (entryDateOf(a.createdAt)?.getTime() ?? 0) - (entryDateOf(b.createdAt)?.getTime() ?? 0)
        ),
    [inputs]
  )
  const latestAsk = pendingAsks.at(-1)
  const [dismissedId, setDismissedId] = useState<string | null>(null)
  useEffect(() => {
    setDismissedId(null)
  }, [latestAsk?.messageId])
  return {
    askCount: pendingAsks.length,
    latestAsk,
    askMode: latestAsk != null && latestAsk.messageId !== dismissedId,
    toggle: (next: boolean) => setDismissedId(next ? null : (latestAsk?.messageId ?? ''))
  }
}
