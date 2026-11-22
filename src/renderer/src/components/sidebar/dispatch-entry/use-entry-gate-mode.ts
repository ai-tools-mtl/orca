import { useEffect, useMemo, useState } from 'react'
import type {
  RoutingEntryInput,
  RoutingEntrySubAction
} from '../workspace-card/activity/routing-entry-model'

/** The 驳回修改 composer mode (§7): armed while a stage gate awaits the user — the main
 *  composer's text IS the rejection's modification request (entryGateReject mails it back to
 *  the stage worker; the gate stays ungranted). Toggling off sends new work instead; a fresh
 *  waiting gate re-arms it automatically. */
export function useEntryGateMode(inputs: RoutingEntryInput[]) {
  const gates = useMemo(() => waitingGates(inputs), [inputs])
  const latestGate = gates.at(-1)
  const [dismissedId, setDismissedId] = useState<string | null>(null)
  useEffect(() => {
    setDismissedId(null)
  }, [latestGate?.subActionId])
  return {
    gateCount: gates.length,
    latestGate,
    gateMode: latestGate != null && latestGate.subActionId !== dismissedId,
    toggle: (next: boolean) => setDismissedId(next ? null : (latestGate?.subActionId ?? ''))
  }
}

function waitingGates(inputs: RoutingEntryInput[]): RoutingEntrySubAction[] {
  return inputs
    .flatMap((input) => input.subActions)
    .filter(
      (action) =>
        action.stageKind !== 'merge' && action.gate === 'user_confirm' && !action.gateGrantedAt
    )
}
