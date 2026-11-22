import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'

// The entry renders as an opaque pane layer: a workspace switch underneath would stay hidden
// behind it, so the open entry closes when the active workspace identity moves.

export function useEntryAutoCloseOnWorkspaceSwitch(open: boolean, close: () => void): void {
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const activeHostId = useAppStore((state) => state.activeWorkspaceExecutionHostId)
  const identityAtOpenRef = useRef<string | null>(null)
  const identity = activeWorktreeId ? `${activeHostId ?? ''}:${activeWorktreeId}` : ''

  useEffect(() => {
    if (!open) {
      identityAtOpenRef.current = null
      return
    }
    // Snapshot once at open: same-tick activations from the opening click must not self-close.
    if (identityAtOpenRef.current === null) {
      identityAtOpenRef.current = identity
      return
    }
    if (identity !== identityAtOpenRef.current) {
      close()
    }
  }, [close, identity, open])
}
