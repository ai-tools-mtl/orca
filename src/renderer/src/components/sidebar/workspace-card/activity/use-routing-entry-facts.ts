import { useCallback, useEffect, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { RoutingEntryInput } from './RoutingEntryCard'
import {
  entryReview,
  entryReviewResultSchema,
  entryShowResultSchema,
  toEntryInputs
} from './routing-entry-model'
import type { RoutingReviewState } from './routing-entry-model'

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
  group: string,
  setInputs: (inputs: RoutingEntryInput[]) => void,
  setPaused: (paused: boolean) => void,
  setError: (error: string | null) => void,
  setReviews: (reviews: ReadonlyMap<string, RoutingReviewState>) => void
): Promise<void> {
  try {
    const show = entryShowResultSchema.parse(
      await callRuntimeRpc<unknown>(target, 'orchestration.entryShow', { group })
    )
    setInputs(toEntryInputs(show))
    setPaused(show.watchdog.paused)
    setError(null)
    // Review state per delegated task (§7): fetched alongside so cards render it inline.
    const taskIds = [
      ...new Set(
        show.inputs
          .flatMap((entry) => entry.subActions)
          .map((subAction) => subAction.subAction.task_id)
          .filter((taskId): taskId is string => taskId != null)
      )
    ]
    const reviews = new Map<string, RoutingReviewState>()
    await Promise.all(
      taskIds.map(async (taskId) => {
        try {
          reviews.set(
            taskId,
            entryReviewResultSchema.parse(await entryReview(target, group, taskId))
          )
        } catch {
          // A task without a cycle shows no review state; read failures stay silent.
        }
      })
    )
    setReviews(reviews)
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : String(cause))
  }
}

async function callEntryAction(
  target: RuntimeClientTarget,
  method: string,
  params: Record<string, unknown>
): Promise<void> {
  await callRuntimeRpc(target, method, params)
}

/** The §9-A entry facts over the desktop entry's own methods — the renderer keeps no second
 *  flow state (§10): every read goes to orchestration.entryShow for this project's group. */
export function useRoutingEntryFacts(target: RuntimeClientTarget | null, group: string) {
  const [inputs, setInputs] = useState<RoutingEntryInput[]>([])
  const [paused, setPaused] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reviews, setReviews] = useState<ReadonlyMap<string, RoutingReviewState>>(new Map())

  const refresh = useCallback(async () => {
    if (!target) {
      return
    }
    await readEntryFacts(target, group, setInputs, setPaused, setError, setReviews)
  }, [target, group])

  useEffect(() => {
    void runWithBusy(setBusy, refresh)
  }, [refresh])

  const submit = useCallback(
    (text: string) => {
      if (!target) {
        return Promise.resolve()
      }
      return runWithBusy(setBusy, () =>
        callEntryAction(target, 'orchestration.entrySubmit', { group, text }).then(refresh)
      )
    },
    [target, group, refresh]
  )

  const handback = useCallback(
    (subActionId: string, dispatchId: string) => {
      if (!target) {
        return Promise.resolve()
      }
      return runWithBusy(setBusy, () =>
        callEntryAction(target, 'orchestration.entryHandback', {
          group,
          subAction: subActionId,
          dispatch: dispatchId
        }).then(refresh)
      )
    },
    [target, group, refresh]
  )

  const sendSupplement = useCallback(
    (inputId: string, subActionId: string, dispatchId: string, text: string) => {
      if (!target) {
        return Promise.resolve()
      }
      return runWithBusy(setBusy, () =>
        callEntryAction(target, 'orchestration.entrySupplement', {
          group,
          input: inputId,
          subAction: subActionId,
          dispatch: dispatchId,
          text
        }).then(refresh)
      )
    },
    [target, group, refresh]
  )

  const setPausedState = useCallback(
    (pausedNext: boolean) => {
      if (!target) {
        return Promise.resolve()
      }
      return runWithBusy(setBusy, () =>
        callEntryAction(
          target,
          pausedNext ? 'orchestration.entryPause' : 'orchestration.entryResume',
          {
            group
          }
        ).then(refresh)
      )
    },
    [target, group, refresh]
  )

  const acceptReview = useCallback(
    (taskId: string) => {
      if (!target) {
        return Promise.resolve()
      }
      return runWithBusy(setBusy, () =>
        callEntryAction(target, 'orchestration.entryReviewAccept', { group, task: taskId }).then(
          refresh
        )
      )
    },
    [target, group, refresh]
  )

  return {
    inputs,
    paused,
    busy,
    error,
    reviews,
    refresh,
    submit,
    handback,
    sendSupplement,
    setPaused: setPausedState,
    acceptReview
  }
}
