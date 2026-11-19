import { useCallback, useEffect, useState } from 'react'
import {
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { OPEN_DISPATCH_ENTRY_EVENT } from '../worktree-list/rows/project-routing-entry-line'

// Listens for the entry row's open event on behalf of ONE workspace surface: only the visible
// surface responds (retained background surfaces stay dormant), and the layer fills its area.

export type DispatchEntryPaneTarget = {
  repoId: string
  hostId: ExecutionHostId
}

export function useDispatchEntryPaneListener(enabled: boolean): {
  target: DispatchEntryPaneTarget | null
  close: () => void
} {
  const [target, setTarget] = useState<DispatchEntryPaneTarget | null>(null)

  const close = useCallback((): void => {
    setTarget(null)
  }, [])

  useEffect(() => {
    if (!enabled) {
      return
    }
    const handleOpen = (event: Event): void => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the entry row dispatched this event with exactly this detail shape.
      const detail = (event as CustomEvent<{ repoId?: unknown; hostId?: unknown }>).detail
      if (typeof detail?.repoId !== 'string' || typeof detail?.hostId !== 'string') {
        return
      }
      const hostId = parseExecutionHostId(detail.hostId)?.id
      const repoId = detail.repoId
      if (!hostId || typeof repoId !== 'string') {
        return
      }
      // Clicking the same project's row again toggles the pane closed — the row is the door.
      setTarget((current) =>
        current?.repoId === repoId && current.hostId === hostId ? null : { repoId, hostId }
      )
    }
    window.addEventListener(OPEN_DISPATCH_ENTRY_EVENT, handleOpen)
    return () => window.removeEventListener(OPEN_DISPATCH_ENTRY_EVENT, handleOpen)
  }, [enabled])

  return { target, close }
}
