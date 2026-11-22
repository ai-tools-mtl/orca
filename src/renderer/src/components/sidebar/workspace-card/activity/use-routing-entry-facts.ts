import { useCallback, useRef, useState } from 'react'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { entryWorkers, routeViaModel, type EntryRoutingResult } from './entry-facts-rpc'
import { useEntryGateActions } from './entry-gate-actions'
import { useEntrySnapshot } from './use-entry-snapshot'
import type { EntryDeleteRequest } from '../../../../../../shared/rpc-contract/orchestration/orchestration-routing-params'
import type { DecisionModelSettings } from '../../../../../../shared/settings/decision-model-settings'

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
  const [busy, setBusy] = useState(false)
  const [routingInputs, setRoutingInputs] = useState<ReadonlySet<string>>(() => new Set())
  // 未确认提交：请求 ID 在服务端确认（登记成功）前保持不变，同一次提交的重试（重发原草稿）
  // 沿用它，账本只登记一条；确认成功后清除，再次提交相同文本是新提交、新 ID。
  const pendingSubmission = useRef<{
    requestId: string
    text: string
    loop: boolean
  } | null>(null)
  const { inputs, hasSnapshot, paused, error, reviews, approvals, refresh } = useEntrySnapshot(
    target,
    group
  )

  const submit = useCallback(
    (
      text: string,
      options?: {
        loop?: boolean
        decisionModel?: DecisionModelSettings
        /** 一次逻辑提交一个 ID：传输失败后的重试复用它，提交重放不会登记第二份输入。 */
        requestId?: string
      }
    ) => {
      if (!target) {
        return Promise.resolve(undefined)
      }
      return runWithBusy(setBusy, async () => {
        const model = options?.decisionModel
        const loop = options?.loop === true
        const pending = pendingSubmission.current
        const requestId =
          options?.requestId ??
          (pending && pending.text === text && pending.loop === loop
            ? pending.requestId
            : createBrowserUuid())
        pendingSubmission.current = { requestId, text, loop }
        const receipt = await callRuntimeRpc<{ input: { input_id: string } }>(
          target,
          'orchestration.entrySubmit',
          {
            group,
            text,
            ...(loop ? { loop: true } : {}),
            // 一次逻辑提交一个稳定请求 ID：客户端重试复用同一个，提交重放不登记第二份输入。
            requestId,
            ...(model ? { decisionModel: { source: model.source, agent: model.agent } } : {})
          }
        ).catch((submitError: unknown) => ({ submitError }))
        if ('submitError' in receipt) {
          // 登记未确认：保留 pending，重发原草稿（同文本同选项）复用同一请求 ID。
          throw receipt.submitError
        }
        pendingSubmission.current = null
        await refresh()
        return receipt.input.input_id
      })
    },
    [target, group, refresh]
  )

  const deleteInstructions = useCallback(
    (request: EntryDeleteRequest) =>
      target
        ? runWithBusy(setBusy, () =>
            callRuntimeRpc(target, 'orchestration.entryDelete', request).finally(refresh)
          )
        : Promise.resolve(),
    [target, refresh]
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
    (input: string, dispatch: boolean): Promise<EntryRoutingResult> => {
      if (!target) {
        return Promise.resolve({ routed: true as const })
      }
      setRoutingInputs((current) => new Set(current).add(input))
      return runWithBusy(setBusy, () =>
        routeViaModel(target, group, input, dispatch).then((result) => refresh().then(() => result))
      ).finally(() => {
        setRoutingInputs((current) => new Set([...current].filter((id) => id !== input)))
      })
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
        ).finally(refresh)
      )
    },
    [target, group, refresh]
  )

  const fetchWorkers = useCallback(
    () => (target ? entryWorkers(target, group) : Promise.resolve([])),
    [target, group]
  )

  const transfer = useCallback(
    (
      inputId: string,
      subActionId: string,
      fromDispatch: string | null,
      dispatch: string,
      text: string
    ) => {
      if (!target) {
        return Promise.resolve()
      }
      return runWithBusy(setBusy, () =>
        callRuntimeRpc(target, 'orchestration.entryTransfer', {
          group,
          input: inputId,
          subAction: subActionId,
          fromDispatch,
          dispatch,
          text
        }).then(refresh)
      )
    },
    [target, group, refresh]
  )

  const setPausedState = useCallback(
    (pausedNext: boolean, subActionId?: string) => {
      if (!target) {
        return Promise.resolve()
      }
      return runWithBusy(setBusy, () =>
        callRuntimeRpc(
          target,
          pausedNext ? 'orchestration.entryPause' : 'orchestration.entryResume',
          { group, ...(subActionId ? { subAction: subActionId } : {}) }
        ).then(refresh)
      )
    },
    [target, group, refresh]
  )

  const answerApproval = useCallback(
    (dispatchId: string, approvalId: string, decision: 'allow' | 'deny', renew?: true) => {
      if (!target) {
        return Promise.resolve()
      }
      return runWithBusy(setBusy, () =>
        callRuntimeRpc(target, 'orchestration.approvalAnswer', {
          dispatch: dispatchId,
          prompt: approvalId,
          decision,
          ...(renew ? { renew } : {})
        }).then(refresh)
      )
    },
    [target, refresh]
  )

  const acceptReview = useCallback(
    (taskId: string, cycleId: string, revision: number) => {
      if (!target) {
        return Promise.resolve()
      }
      return runWithBusy(setBusy, () =>
        callRuntimeRpc(target, 'orchestration.entryReviewAccept', {
          group,
          task: taskId,
          cycle: cycleId,
          revision
        }).finally(refresh)
      )
    },
    [target, group, refresh]
  )

  const { gateGrant, gateReject } = useEntryGateActions(target, group, refresh, setBusy)

  const answerAsk = useCallback(
    (messageId: string, body: string) => {
      if (!target) {
        return Promise.resolve()
      }
      return runWithBusy(setBusy, () =>
        callRuntimeRpc(target, 'orchestration.entryAnswerAsk', {
          group,
          message: messageId,
          body
        }).then(refresh)
      )
    },
    [target, group, refresh]
  )

  return {
    inputs,
    hasSnapshot,
    paused,
    busy,
    routingInputs,
    error,
    reviews,
    approvals,
    refresh,
    submit,
    deleteInstructions,
    autoRoute,
    savePlan,
    fetchAgents,
    assign,
    handback,
    transfer,
    fetchWorkers,
    sendSupplement,
    setPaused: setPausedState,
    answerApproval,
    acceptReview,
    gateGrant,
    gateReject,
    answerAsk
  }
}
