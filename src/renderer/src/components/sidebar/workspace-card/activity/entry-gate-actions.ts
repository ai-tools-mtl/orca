import { useCallback } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

// Module-level so hooks stay React-Compiler compatible (no in-hook try/finally).
async function runWithBusy<T>(
  setBusy: (busy: boolean) => void,
  action: () => Promise<T>
): Promise<T> {
  setBusy(true)
  try {
    return await action()
  } finally {
    setBusy(false)
  }
}

/** The stage gate's two person actions (§7): confirm & release, or reject with a modification
 *  request mailed back to the stage worker (same worktree continuation; the gate stays ungranted). */
export function useEntryGateActions(
  target: RuntimeClientTarget | null,
  group: string,
  refresh: () => void,
  setBusy: (busy: boolean) => void
) {
  const gateGrant = useCallback(
    (subActionId: string) => {
      if (!target) {
        return Promise.resolve()
      }
      return runWithBusy(setBusy, () =>
        callRuntimeRpc(target, 'orchestration.entryGateGrant', {
          group,
          subAction: subActionId
        }).then(refresh)
      )
    },
    [target, group, refresh, setBusy]
  )

  const gateReject = useCallback(
    (subActionId: string, text: string) => {
      if (!target) {
        return Promise.resolve()
      }
      return runWithBusy(setBusy, () =>
        callRuntimeRpc(target, 'orchestration.entryGateReject', {
          group,
          subAction: subActionId,
          text
        }).then(refresh)
      )
    },
    [target, group, refresh, setBusy]
  )

  return { gateGrant, gateReject }
}
