import { useCallback, useEffect, useState } from 'react'
import { z } from 'zod'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { RoutingEntryInput } from './RoutingEntryCard'

const attemptSchema = z.object({
  // The ledger CHECK constrains outcomes to exactly these three (migrate-v49's outcome enum).
  outcome: z.enum(['delivered', 'refused', 'unverified']),
  refusal_kind: z.string().nullable(),
  first_action_json: z.string().nullable()
})

const routingInputsShowResultSchema = z.object({
  inputs: z.array(
    z.object({
      input: z.object({
        input_id: z.string(),
        received_seq: z.number(),
        decision_status: z.string(),
        raw_text: z.string()
      }),
      subActions: z.array(
        z.object({
          subAction: z.object({
            sub_action_id: z.string(),
            text: z.string(),
            task_id: z.string().nullable(),
            state: z.enum([
              'registered',
              'delivered',
              'processed',
              'violated',
              'pending_verification'
            ]),
            claimed_dispatch_id: z.string().nullable()
          }),
          deliveries: z.array(
            z.object({
              supplement: z.object({
                supplement_id: z.string(),
                target_dispatch_id: z.string()
              }),
              attempts: z.array(attemptSchema)
            })
          )
        })
      )
    })
  )
})

type RoutingInputsShowResult = z.infer<typeof routingInputsShowResultSchema>

const firstActionEvidenceSchema = z.object({
  verdict: z.string(),
  reason: z.string().optional(),
  firstAction: z
    .object({ name: z.string().optional(), path: z.string().optional() })
    .partial()
    .optional()
})

function firstActionSummaryOf(rawEvidence: string | null): string | undefined {
  if (!rawEvidence) {
    return undefined
  }
  const parsed = firstActionEvidenceSchema.safeParse(JSON.parse(rawEvidence))
  if (!parsed.success) {
    return undefined
  }
  if (parsed.data.reason !== undefined) {
    return parsed.data.reason
  }
  const action = parsed.data.firstAction
  if (!action) {
    return undefined
  }
  return translate(
    'auto.components.sidebar.RoutingEntryCard.firstAction',
    'First action {{name}} {{path}}',
    { name: action.name ?? '', path: action.path ?? '' }
  ).trim()
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
      const evidence = attempts.findLast((attempt) => attempt.first_action_json !== null)
      return {
        subActionId: subAction.subAction.sub_action_id,
        text: subAction.subAction.text,
        state: subAction.subAction.state,
        claimedBy: subAction.subAction.claimed_dispatch_id ?? undefined,
        lastOutcome: last?.outcome,
        refusalKind: last?.refusal_kind ?? undefined,
        firstActionSummary: firstActionSummaryOf(evidence?.first_action_json ?? null)
      }
    })
  }))
}

const routingWatchdogResultSchema = z.object({
  watchdog: z.object({ paused: z.boolean() })
})

// Module-level so hooks stay React-Compiler compatible (no in-hook try/finally).
async function runWithBusy(
  setBusy: (busy: boolean) => void,
  action: () => Promise<void>
): Promise<void> {
  setBusy(true)
  try {
    await action()
  } finally {
    setBusy(false)
  }
}

async function readEntryFacts(
  target: RuntimeClientTarget,
  run: string | undefined,
  setInputs: (inputs: RoutingEntryInput[]) => void,
  setPaused: (paused: boolean) => void,
  setError: (error: string | null) => void
): Promise<void> {
  try {
    const show = routingInputsShowResultSchema.parse(
      await callRuntimeRpc<unknown>(target, 'orchestration.routingInputsShow', {
        ...(run ? { run } : {}),
        from: undefined
      })
    )
    setInputs(toEntryInputs(show))
    const watchdog = routingWatchdogResultSchema.parse(
      await callRuntimeRpc<unknown>(target, 'orchestration.routingWatchdogShow', {
        ...(run ? { run } : {}),
        from: undefined
      })
    )
    setPaused(watchdog.watchdog.paused)
    setError(null)
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : String(cause))
  }
}

async function callEntryAction(
  target: RuntimeClientTarget,
  run: string | undefined,
  method: string,
  params: Record<string, unknown>
): Promise<void> {
  await callRuntimeRpc(target, method, { ...params, ...(run ? { run } : {}), from: undefined })
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
    await readEntryFacts(target, run, setInputs, setPaused, setError)
  }, [target, run])

  useEffect(() => {
    void runWithBusy(setBusy, refresh)
  }, [refresh])

  const claim = useCallback(
    (subActionId: string, dispatchId: string) => {
      if (!target) {
        return Promise.resolve()
      }
      return runWithBusy(setBusy, () =>
        callEntryAction(target, run, 'orchestration.routingSubActionClaim', {
          subAction: subActionId,
          dispatch: dispatchId
        }).then(refresh)
      )
    },
    [target, run, refresh]
  )

  const handback = useCallback(
    (subActionId: string, dispatchId: string) => {
      if (!target) {
        return Promise.resolve()
      }
      return runWithBusy(setBusy, () =>
        callEntryAction(target, run, 'orchestration.routingSubActionHandback', {
          subAction: subActionId,
          dispatch: dispatchId
        }).then(refresh)
      )
    },
    [target, run, refresh]
  )

  const sendSupplement = useCallback(
    (inputId: string, subActionId: string, dispatchId: string, text: string) => {
      if (!target) {
        return Promise.resolve()
      }
      return runWithBusy(setBusy, () =>
        callEntryAction(target, run, 'orchestration.routingSupplementSend', {
          input: inputId,
          subAction: subActionId,
          dispatch: dispatchId,
          text
        }).then(refresh)
      )
    },
    [target, run, refresh]
  )

  return { inputs, paused, busy, error, refresh, claim, handback, sendSupplement }
}
