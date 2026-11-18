import { generateId } from '../db/generated-id'
import type { OrchestrationDb } from '../db/orchestration-db'
import type { RoutingSupplementAttemptRow, RoutingSupplementRow } from '../db/routing-records'
import { structuredMailboxCustody } from '../mailbox/routing/structured-session-mail-target'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { steerExpectedTurnViaAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-expected-steer'
import type { AgentSessionExpectedSteerOutcome } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'

/** Targeted supplement delivery (plan §5.3): save the text first, then deliver it to exactly one
 *  named active turn of the original Dispatch. A refusal is a recorded fact bound to the expected
 *  turn — never a re-target to another turn and never a new turn. */

export type TargetedSupplementRefusalReason =
  | 'dispatch-not-active'
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
  const { db } = params
  const dispatch = db.getDispatchContextById(params.targetDispatchId)
  if (!dispatch) {
    // recordRoutingSupplement already refuses unknown Dispatches; nothing was delivered.
    throw new Error(`dispatch_not_found: ${params.targetDispatchId}`)
  }
  const supplement = db.recordRoutingSupplement({
    inputId: params.inputId,
    subActionId: params.subActionId,
    targetDispatchId: params.targetDispatchId,
    text: params.text
  })
  // Retrying the same delivery reuses the last attempt's request id (plan §6): retries and
  // re-sends of one supplement stay one logical call; only a re-target mints a new id.
  const requestId =
    db.listSupplementAttempts(supplement.supplement_id).at(-1)?.request_id ?? generateId('rtsend')
  const recordRefusal = (
    reason: TargetedSupplementRefusalReason,
    expectedTurnId: string | null,
    session: string | undefined,
    detail?: string
  ): TargetedSupplementResult => ({
    supplement,
    ...(session ? { session } : {}),
    attempt: db.recordSupplementAttempt({
      supplementId: supplement.supplement_id,
      requestId,
      targetDispatchId: dispatch.id,
      expectedTurnId: expectedTurnId ?? null,
      outcome: 'refused',
      refusalKind: reason,
      detail: detail ?? null
    })
  })
  if (dispatch.status !== 'dispatched') {
    return recordRefusal(
      'dispatch-not-active',
      params.expectedTurnId ?? null,
      undefined,
      `Dispatch ${dispatch.id} is ${dispatch.status}; the supplement stays recorded with it.`
    )
  }
  const custody = structuredMailboxCustody(`dispatch:${dispatch.id}`, db)
  if (typeof custody !== 'object' || custody.dispatchId !== dispatch.id) {
    return recordRefusal(
      'not-structured-here',
      params.expectedTurnId ?? null,
      undefined,
      `Dispatch ${dispatch.id} mail is not held by a reachable structured session here.`
    )
  }
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return recordRefusal('host-unavailable', params.expectedTurnId ?? null, undefined)
  }
  const sessionId = custody.sessionId
  let expectedTurnId = params.expectedTurnId
  if (!expectedTurnId) {
    const work = await host.currentWorkAtRest(sessionId)
    expectedTurnId = work?.activeTurnId() ?? undefined
    if (!expectedTurnId) {
      return recordRefusal(
        'no-active-turn',
        null,
        sessionId,
        `Session ${sessionId} has no active turn; the supplement stays recorded with Dispatch ${dispatch.id}.`
      )
    }
  }
  let outcome: AgentSessionExpectedSteerOutcome
  try {
    outcome = await steerExpectedTurnViaAdapter(host.deps.adapter, {
      sessionId,
      clientMessageId: requestId,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: params.text }] },
      expectedTurnId
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if ((error as Error)?.name === 'StructuredAgentSessionInputNotAdmitted') {
      return recordRefusal('admission-refused', expectedTurnId, sessionId, message)
    }
    return recordRefusal('session-unavailable', expectedTurnId, sessionId, message)
  }
  if (outcome.status === 'delivered') {
    return {
      supplement,
      session: sessionId,
      attempt: db.recordSupplementAttempt({
        supplementId: supplement.supplement_id,
        requestId,
        targetDispatchId: dispatch.id,
        expectedTurnId,
        outcome: 'delivered',
        turnId: outcome.turnId
      })
    }
  }
  return {
    supplement,
    session: sessionId,
    attempt: db.recordSupplementAttempt({
      supplementId: supplement.supplement_id,
      requestId,
      targetDispatchId: dispatch.id,
      expectedTurnId,
      outcome: 'refused',
      refusalKind: outcome.kind,
      detail: outcome.detail ? JSON.stringify(outcome.detail) : null
    })
  }
}
