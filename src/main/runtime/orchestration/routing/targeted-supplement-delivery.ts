import { entrySubActionRequiresWriteApproval, isEntryReadOnlyWorker } from './entry-write-policy'
import { generateId } from '../db/generated-id'
import type { OrchestrationDb } from '../db/orchestration-db'
import type { RoutingSupplementAttemptRow, RoutingSupplementRow } from '../db/routing-records'
import { recentOpenApprovalReports } from '../workers/approvals/worker-approval-report'
import { structuredMailboxCustody } from '../mailbox/routing/structured-session-mail-target'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { steerExpectedTurnViaAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-expected-steer'
import type { AgentSessionExpectedSteerOutcome } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'

/** Targeted supplement delivery (plan §5.3): save the text first, then deliver it to exactly one
 *  named active turn of the original Dispatch. A refusal is a recorded fact bound to the expected
 *  turn — never a re-target to another turn and never a new turn. */

export type TargetedSupplementRefusalReason =
  | 'dispatch-not-active'
  | 'claimed-elsewhere'
  | 'paused'
  | 'awaiting-answer'
  | 'not-structured-here'
  | 'host-unavailable'
  | 'session-unavailable'
  | 'no-active-turn'
  | 'admission-refused'
  | 'unsupported'
  | 'provider-refused'
  | 'turn-not-active'

export type TargetedSupplementResult = {
  supplement: RoutingSupplementRow
  attempt: RoutingSupplementAttemptRow
  session?: string
}

type DeliverParams = {
  db: OrchestrationDb
  inputId: string
  subActionId: string
  targetDispatchId: string
  text: string
  /** Omitted: resolve the Dispatch's active turn at send time. Given: steer exactly that turn. */
  expectedTurnId?: string
}

export async function deliverTargetedSupplement(
  params: DeliverParams
): Promise<TargetedSupplementResult> {
  const supplement = params.db.recordRoutingSupplement(params)
  return deliverRecordedSupplement(params.db, supplement, params.expectedTurnId)
}

export async function deliverRecordedSupplement(
  db: OrchestrationDb,
  supplement: RoutingSupplementRow,
  expectedTurn?: string
): Promise<TargetedSupplementResult> {
  const lastAttempt = db.listSupplementAttempts(supplement.supplement_id).at(-1)
  // 重指目标后的补充允许重投：lastAttempt 属于旧 dispatch，目标已换新（兜底跟随）。
  const retargeted = lastAttempt?.target_dispatch_id !== supplement.target_dispatch_id
  if (
    lastAttempt &&
    !retargeted &&
    (lastAttempt.outcome !== 'refused' || lastAttempt.refusal_kind !== 'paused')
  ) {
    return { supplement, attempt: lastAttempt }
  }
  // 兜底重派跟随（§执行失败兜底）：只对不可 steer 的目标生效（dispatch 已终局，或 usage-
  // limit 僵尸）——健康在跑的会话（含转派 handback）照常 steer。目标任务的原始行已被换人
  // 时，旧 dispatch 永远收不到 steer——续接改绑新任务并重投新 dispatch；新任务未落账时记
  // paused 拒收保持可重投（恢复推进在原行派发后跟随改指新 worker）。
  const targetTaskId = db.getSubAction(supplement.sub_action_id)?.task_id
  if (targetTaskId) {
    const steerable =
      db.getDispatchContext(targetTaskId)?.status === 'dispatched' &&
      !db.redispatchDirectiveApplies(targetTaskId)
    if (!steerable) {
      const followedTask = db.fallbackRedispatchTargetOfTask(targetTaskId)
      const followedDispatch = followedTask ? db.getDispatchContext(followedTask) : undefined
      if (followedTask && followedDispatch && followedDispatch.status === 'dispatched') {
        db.rebindRoutingTaskBindings(targetTaskId, followedTask)
        db.retargetRoutingSupplement(supplement.supplement_id, followedDispatch.id)
        return deliverRecordedSupplement(
          db,
          { ...supplement, target_dispatch_id: followedDispatch.id },
          expectedTurn
        )
      }
      if (db.hasRedispatchHandbackOfTask(targetTaskId)) {
        // 换人已裁决（新任务未落账）：保持 paused 可重投，绝不落入对终局会话的终结性拒收。
        if (lastAttempt?.refusal_kind === 'paused' && !retargeted) {
          return { supplement, attempt: lastAttempt }
        }
        return {
          supplement,
          attempt: db.recordSupplementAttempt({
            supplementId: supplement.supplement_id,
            requestId: lastAttempt?.request_id ?? generateId('rtsend'),
            targetDispatchId: supplement.target_dispatch_id,
            expectedTurnId: null,
            outcome: 'refused',
            refusalKind: 'paused',
            detail: 'Redispatch directive pending: awaiting the re-dispatched task.'
          })
        }
      }
    }
  }
  const dispatch = db.getDispatchContextById(supplement.target_dispatch_id)
  const requestId = lastAttempt?.request_id ?? generateId('rtsend')
  // 重指目标后不复用旧会话的 expected turn——旧 turn 属于已终局的 dispatch。
  let expectedTurnId = retargeted ? undefined : (lastAttempt?.expected_turn_id ?? expectedTurn)
  const newerAttempt = (): RoutingSupplementAttemptRow | undefined => {
    const latest = db.listSupplementAttempts(supplement.supplement_id).at(-1)
    return latest?.attempt_id === lastAttempt?.attempt_id ? undefined : latest
  }
  const recordRefusal = (
    reason: TargetedSupplementRefusalReason,
    expectedTurnId: string | null,
    session: string | undefined,
    detail?: string
  ): TargetedSupplementResult => ({
    supplement,
    ...(session ? { session } : {}),
    attempt:
      newerAttempt() ??
      db.recordSupplementAttempt({
        supplementId: supplement.supplement_id,
        requestId,
        targetDispatchId: supplement.target_dispatch_id,
        expectedTurnId,
        outcome: 'refused',
        refusalKind: reason,
        detail: detail ?? null
      })
  })
  const checkTarget = (): TargetedSupplementRefusalReason | undefined => {
    const action = db.getSubAction(supplement.sub_action_id)
    if (
      action?.claimed_dispatch_id &&
      action.claimed_dispatch_id !== supplement.target_dispatch_id
    ) {
      return 'claimed-elsewhere'
    }
    if (db.isRoutingRunPaused(supplement.run_id)) {
      return 'paused'
    }
    if (db.isRoutingSubActionPaused(supplement.sub_action_id)) {
      return 'paused'
    }
    if (
      action &&
      entrySubActionRequiresWriteApproval(db, action) &&
      !isEntryReadOnlyWorker(db, supplement.target_dispatch_id)
    ) {
      return 'admission-refused'
    }
    if (db.getDispatchContextById(supplement.target_dispatch_id)?.status !== 'dispatched') {
      return 'dispatch-not-active'
    }
    if (
      db.awaitsAnswerToLatestQuestion(supplement.target_dispatch_id) ||
      recentOpenApprovalReports(db).some(
        ({ dispatch }) => dispatch.id === supplement.target_dispatch_id
      )
    ) {
      return 'awaiting-answer'
    }
    return undefined
  }
  const refusal = checkTarget()
  if ((refusal && refusal !== 'paused') || !dispatch) {
    return recordRefusal(refusal ?? 'dispatch-not-active', expectedTurnId ?? null, undefined)
  }
  const custody = structuredMailboxCustody(`dispatch:${dispatch.id}`, db)
  if (typeof custody !== 'object' || custody.dispatchId !== dispatch.id) {
    return recordRefusal(
      refusal ?? 'not-structured-here',
      expectedTurnId ?? null,
      undefined,
      `Dispatch ${dispatch.id} mail is not held by a reachable structured session here.`
    )
  }
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return recordRefusal(refusal ?? 'host-unavailable', expectedTurnId ?? null, undefined)
  }
  const sessionId = custody.sessionId
  if (lastAttempt?.refusal_kind === 'paused' && !expectedTurnId && refusal !== 'paused') {
    return recordRefusal(
      'no-active-turn',
      null,
      sessionId,
      'The paused supplement had no verified original turn.'
    )
  }
  if (!expectedTurnId) {
    try {
      const work = await host.currentWorkAtRest(sessionId)
      expectedTurnId = work?.activeTurnId() ?? undefined
    } catch (error) {
      return recordRefusal(refusal ?? 'session-unavailable', null, sessionId, String(error))
    }
    if (!expectedTurnId) {
      return recordRefusal(
        checkTarget() ?? 'no-active-turn',
        null,
        sessionId,
        `Session ${sessionId} has no active turn; the supplement stays recorded with Dispatch ${dispatch.id}.`
      )
    }
  }
  const latest = newerAttempt()
  if (latest) {
    return { supplement, attempt: latest }
  }
  const sendRefusal = checkTarget()
  if (sendRefusal) {
    return recordRefusal(sendRefusal, expectedTurnId, sessionId)
  }
  // A crash or ambiguous transport failure after admission must never resend to a newer turn.
  const pending = db.recordSupplementAttempt({
    supplementId: supplement.supplement_id,
    requestId,
    targetDispatchId: supplement.target_dispatch_id,
    expectedTurnId,
    outcome: 'unverified'
  })
  let outcome: AgentSessionExpectedSteerOutcome
  try {
    outcome = await steerExpectedTurnViaAdapter(host.deps.adapter, {
      sessionId,
      clientMessageId: requestId,
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: supplement.raw_text }]
      },
      expectedTurnId
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'StructuredAgentSessionInputNotAdmitted') {
      return {
        supplement,
        session: sessionId,
        attempt: db.settleSupplementAttempt(pending.attempt_id, {
          outcome: 'refused',
          refusalKind: 'admission-refused',
          detail: error.message
        })
      }
    }
    return { supplement, session: sessionId, attempt: pending }
  }
  if (outcome.status === 'delivered') {
    db.setSubActionState(supplement.sub_action_id, 'delivered')
  }
  return {
    supplement,
    session: sessionId,
    attempt: db.settleSupplementAttempt(
      pending.attempt_id,
      outcome.status === 'delivered'
        ? { outcome: 'delivered', turnId: outcome.turnId }
        : {
            outcome: 'refused',
            refusalKind: outcome.kind,
            detail: outcome.detail ? JSON.stringify(outcome.detail) : null
          }
    )
  }
}
