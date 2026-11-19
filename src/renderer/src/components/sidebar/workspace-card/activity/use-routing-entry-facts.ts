import { useCallback, useEffect, useRef, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { entryWorkers, readEntrySnapshot, routeViaModel } from './routing-entry-model'
import type {
  EntryRoutingResult,
  RoutingEntryApproval,
  RoutingEntryInput,
  RoutingEntryWorker,
  RoutingReviewState
} from './routing-entry-model'

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

/** The §9-A entry facts over the desktop entry's own methods — the renderer keeps no second
 *  flow state (§10): every read goes to orchestration.entryShow for this project's group. */
export function useRoutingEntryFacts(target: RuntimeClientTarget | null, group: string) {
  const [inputs, setInputs] = useState<RoutingEntryInput[]>([])
  const [paused, setPaused] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reviews, setReviews] = useState<ReadonlyMap<string, RoutingReviewState>>(new Map())
  const [approvals, setApprovals] = useState<RoutingEntryApproval[]>([])

  const refreshVersion = useRef(0)
  const refresh = useCallback(async () => {
    if (!target) {
      return
    }
    const version = ++refreshVersion.current
    await readEntrySnapshot(target, group).then(
      (snapshot) => {
        if (version !== refreshVersion.current) {
          return
        }
        setInputs(snapshot.inputs)
        setPaused(snapshot.paused)
        setReviews(snapshot.reviews)
        setApprovals(snapshot.approvals)
        setError(null)
      },
      (cause: unknown) => {
        if (version === refreshVersion.current) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }
    )
  }, [target, group])

  useEffect(() => {
    void runWithBusy(setBusy, refresh)
  }, [refresh])

  useEffect(() => {
    if (
      !busy &&
      !inputs.some((input) =>
        input.subActions.some(
          (action) =>
            action.execution?.status === 'pending' ||
            action.execution?.status === 'dispatched' ||
            action.execution?.status === 'attention'
        )
      )
    ) {
      return
    }
    let disposed = false
    let timer = window.setTimeout(poll, 2000)
    function poll(): void {
      void refresh().then(() => {
        if (!disposed) {
          timer = window.setTimeout(poll, 2000)
        }
      })
    }
    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [inputs, refresh, busy])

  const submit = useCallback(
    (text: string) => {
      if (!target) {
        return Promise.resolve(undefined)
      }
      return runWithBusy(setBusy, async () => {
        const { input } = await callRuntimeRpc<{ input: { input_id: string } }>(
          target,
          'orchestration.entrySubmit',
          { group, text }
        )
        await refresh()
        return input.input_id
      })
    },
    [target, group, refresh]
  )

  const handback = useCallback(
    (subActionId: string, dispatchId: string) => {
      if (!target) {
        return Promise.resolve()
      }
      return runWithBusy(setBusy, () =>
        callRuntimeRpc(target, 'orchestration.entryHandback', {
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
        callRuntimeRpc(target, 'orchestration.entrySupplement', {
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

  const autoRoute = useCallback(
    (inputId: string, dispatch: boolean): Promise<EntryRoutingResult> => {
      if (!target) {
        return Promise.resolve({ routed: true as const })
      }
      return runWithBusy(setBusy, () =>
        routeViaModel(target, group, inputId, dispatch).then((result) =>
          refresh().then(() => result)
        )
      )
    },
    [target, group, refresh]
  )

  const savePlan = useCallback(
    (inputId: string, subActions: string[]) => {
      if (!target) {
        return Promise.resolve()
      }
      return runWithBusy(setBusy, () =>
        callRuntimeRpc(target, 'orchestration.entryPlan', {
          group,
          input: inputId,
          subActions
        }).then(refresh)
      )
    },
    [target, group, refresh]
  )

  const fetchAgents = useCallback(async () => {
    if (!target) {
      return []
    }
    const { agents } = await callRuntimeRpc<{ agents: TuiAgent[] }>(
      target,
      'orchestration.entryAgents',
      { group }
    )
    return agents
  }, [target, group])

  const assign = useCallback(
    (inputId: string, subActionId: string, agent: TuiAgent) => {
      if (!target) {
        return Promise.resolve()
      }
      return runWithBusy(setBusy, () =>
        callRuntimeRpc(
          target,
          'orchestration.entryAssign',
          { group, input: inputId, subAction: subActionId, agent },
          { timeoutMs: 120_000 }
        ).then(refresh)
      )
    },
    [target, group, refresh]
  )

  const fetchWorkers = useCallback(async () => {
    if (!target) {
      return [] satisfies RoutingEntryWorker[]
    }
    return entryWorkers(target, group)
  }, [target, group])

  const claim = useCallback(
    (subActionId: string, dispatchId: string) => {
      if (!target) {
        return Promise.resolve()
      }
      return runWithBusy(setBusy, () =>
        callRuntimeRpc(target, 'orchestration.entryClaim', {
          group,
          subAction: subActionId,
          dispatch: dispatchId
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
        callRuntimeRpc(
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

  const answerApproval = useCallback(
    (dispatchId: string, approvalId: string, decision: 'allow' | 'deny') => {
      if (!target) {
        return Promise.resolve()
      }
      return runWithBusy(setBusy, () =>
        callRuntimeRpc(target, 'orchestration.approvalAnswer', {
          dispatch: dispatchId,
          prompt: approvalId,
          decision
        }).then(refresh)
      )
    },
    [target, refresh]
  )

  const acceptReview = useCallback(
    (taskId: string) => {
      if (!target) {
        return Promise.resolve()
      }
      return runWithBusy(setBusy, () =>
        callRuntimeRpc(target, 'orchestration.entryReviewAccept', { group, task: taskId }).then(
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
    approvals,
    refresh,
    submit,
    autoRoute,
    savePlan,
    fetchAgents,
    assign,
    handback,
    claim,
    fetchWorkers,
    sendSupplement,
    setPaused: setPausedState,
    answerApproval,
    acceptReview
  }
}
