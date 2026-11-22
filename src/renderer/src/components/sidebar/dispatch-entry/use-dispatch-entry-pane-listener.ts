import { useCallback, useEffect, useState } from 'react'
import {
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import {
  CLOSE_DISPATCH_ENTRY_EVENT,
  OPEN_DISPATCH_ENTRY_EVENT
} from '../worktree-list/rows/project-routing-entry-line'
import { useAppStore } from '@/store'
import { useEntryAutoCloseOnWorkspaceSwitch } from './use-entry-auto-close-on-workspace-switch'

export type DispatchEntryPaneTarget = {
  repoId: string
  hostId: ExecutionHostId
}

export function useDispatchEntryPaneListener(): {
  target: DispatchEntryPaneTarget | null
  close: () => void
} {
  const [target, setTarget] = useState<DispatchEntryPaneTarget | null>(null)

  const close = useCallback((): void => {
    setTarget((current) => (current === target ? null : current))
  }, [target])

  useEntryAutoCloseOnWorkspaceSwitch(target !== null, close)

  useEffect(() => {
    window.addEventListener(CLOSE_DISPATCH_ENTRY_EVENT, close)
    return () => window.removeEventListener(CLOSE_DISPATCH_ENTRY_EVENT, close)
  }, [close])

  useEffect(() => {
    if (!target) {
      return
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        close()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [close, target])

  useEffect(() => {
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
      useAppStore.getState().setActiveView('terminal')
      setTarget((current) =>
        current?.repoId === repoId && current.hostId === hostId ? current : { repoId, hostId }
      )
    }
    window.addEventListener(OPEN_DISPATCH_ENTRY_EVENT, handleOpen)
    return () => window.removeEventListener(OPEN_DISPATCH_ENTRY_EVENT, handleOpen)
  }, [])

  return { target, close }
}
