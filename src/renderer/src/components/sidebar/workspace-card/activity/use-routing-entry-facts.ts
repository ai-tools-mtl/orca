import { useCallback, useEffect, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { RoutingEntryInput, RoutingEntrySubAction } from './RoutingEntryCard'

type RoutingInputsShowResult = {
  inputs: {
    input: { input_id: string; received_seq: number; decision_status: string; raw_text: string }
    subActions: {
      subAction: { sub_action_id: string; text: string; task_id: string | null }
      deliveries: {
        supplement: { supplement_id: string; target_dispatch_id: string }
        attempts: {
          outcome: string
          refusal_kind: string | null
          first_action_json: string | null
        }[]
      }[]
    }[]
  }[]
}

type RoutingWatchdogResult = {
  watchdog: { paused: boolean }
}

function toEntryInputs(result: RoutingInputsShowResult): RoutingEntryInput[] {
  return result.inputs.map((entry) => ({
    inputId: entry.input.input_id,
    text: entry.input.raw_text,
    decisionStatus:
      entry.input.decision_status === 'decided' ? ('decided' as const) : ('received' as const),
    subActions: entry.subActions.map((subAction) => {
      const attempts = subAction.deliveries.flatMap((delivery) => delivery.attempts)
      const last = attempts.at(-1)
      const evidence = attempts.find((attempt) => attempt.first_action_json !== null)
      const state: RoutingEntrySubAction['state'] =
        (subAction.subAction as { state?: RoutingEntrySubAction['state'] }).state ?? 'registered'
      let firstActionSummary: string | undefined
      if (evidence?.first_action_json) {
        try {
          const parsed = JSON.parse(evidence.first_action_json) as {
            firstAction?: { name?: string; path?: string }
            reason?: string
          }
          firstActionSummary =
            parsed.reason ??
            (parsed.firstAction
              ? `首个动作 ${parsed.firstAction.name ?? ''} ${parsed.firstAction.path ?? ''}`.trim()
              : undefined)
        } catch {
          firstActionSummary = undefined
        }
      }
      return {
        subActionId: subAction.subAction.sub_action_id,
        text: subAction.subAction.text,
        state: state ?? 'registered',
        claimedBy:
          (subAction.subAction as { claimed_dispatch_id?: string }).claimed_dispatch_id ??
          undefined,
        lastOutcome: last?.outcome as RoutingEntryInput['subActions'][number]['lastOutcome'],
        refusalKind: last?.refusal_kind ?? undefined,
        firstActionSummary
      }
    })
  }))
}

/** The §9-A entry facts over the runtime's own RPCs — the renderer keeps no second flow state
 *  (§10): every read goes to orchestration.routingInputsShow / routingWatchdogShow. */
export function useRoutingEntryFacts(target: RuntimeClientTarget | null, run?: string) {
  const [inputs, setInputs] = useState<RoutingEntryInput[]>([])
  const [paused, setPaused] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!target) {
      return
    }
    setBusy(true)
    try {
      const show = await callRuntimeRpc<RoutingInputsShowResult>(
        target,
        'orchestration.routingInputsShow',
        {
          ...(run ? { run } : {}),
          from: undefined
        }
      )
      setInputs(toEntryInputs(show as RoutingInputsShowResult))
      const watchdog = await callRuntimeRpc<RoutingWatchdogResult>(
        target,
        'orchestration.routingWatchdogShow',
        { ...(run ? { run } : {}), from: undefined }
      )
      setPaused((watchdog as RoutingWatchdogResult).watchdog.paused)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [target, run])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const claim = useCallback(
    async (subActionId: string, dispatchId: string) => {
      if (!target) {
        return
      }
      setBusy(true)
      try {
        await callRuntimeRpc(target, 'orchestration.routingSubActionClaim', {
          subAction: subActionId,
          dispatch: dispatchId,
          ...(run ? { run } : {}),
          from: undefined
        })
        await refresh()
      } finally {
        setBusy(false)
      }
    },
    [target, run, refresh]
  )

  const handback = useCallback(
    async (subActionId: string, dispatchId: string) => {
      if (!target) {
        return
      }
      setBusy(true)
      try {
        await callRuntimeRpc(target, 'orchestration.routingSubActionHandback', {
          subAction: subActionId,
          dispatch: dispatchId,
          ...(run ? { run } : {}),
          from: undefined
        })
        await refresh()
      } finally {
        setBusy(false)
      }
    },
    [target, run, refresh]
  )

  return { inputs, paused, busy, error, refresh, claim, handback }
}
