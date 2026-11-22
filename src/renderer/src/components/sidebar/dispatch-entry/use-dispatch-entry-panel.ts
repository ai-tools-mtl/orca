import { useCallback, useEffect, useState } from 'react'
import {
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import {
  CLOSE_DISPATCH_ENTRY_EVENT,
  OPEN_DISPATCH_ENTRY_EVENT
} from '../worktree-list/rows/project-routing-entry-line'
import { useEntryAutoCloseOnWorkspaceSwitch } from './use-entry-auto-close-on-workspace-switch'

// The per-project 统一任务入口 sheet. Component-local state like the workspace board panel;
// `repoId` names the project whose entry the sheet drives, `hostId` the runtime holding it.
export type DispatchEntryPanelState = {
  open: boolean
  repoId: string | null
  hostId: ExecutionHostId | null
  openDispatchEntry: (repoId: string, hostId: ExecutionHostId) => void
  closeDispatchEntry: () => void
}

export function useDispatchEntryPanel(): DispatchEntryPanelState {
  const [state, setState] = useState<{ repoId: string; hostId: ExecutionHostId } | null>(null)

  const close = useCallback((): void => {
    setState(null)
  }, [])

  useEntryAutoCloseOnWorkspaceSwitch(state !== null, close)

  useEffect(() => {
    window.addEventListener(CLOSE_DISPATCH_ENTRY_EVENT, close)
    return () => window.removeEventListener(CLOSE_DISPATCH_ENTRY_EVENT, close)
  }, [close])

  const open = useCallback((repoId: string, hostId: ExecutionHostId): void => {
    setState({ repoId, hostId })
  }, [])

  useEffect(() => {
    const handleOpen = (event: Event): void => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the panel dispatched this event with exactly this detail shape.
      const detail = (event as CustomEvent<{ repoId?: unknown; hostId?: unknown }>).detail
      if (typeof detail?.repoId !== 'string' || typeof detail?.hostId !== 'string') {
        return
      }
      const hostId = parseExecutionHostId(detail.hostId)?.id
      if (hostId) {
        open(detail.repoId, hostId)
      }
    }
    window.addEventListener(OPEN_DISPATCH_ENTRY_EVENT, handleOpen)
    return () => window.removeEventListener(OPEN_DISPATCH_ENTRY_EVENT, handleOpen)
  }, [open])

  useEffect(() => {
    if (!state) {
      return
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        close()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [close, state])

  return {
    open: state !== null,
    repoId: state?.repoId ?? null,
    hostId: state?.hostId ?? null,
    openDispatchEntry: open,
    closeDispatchEntry: close
  }
}
