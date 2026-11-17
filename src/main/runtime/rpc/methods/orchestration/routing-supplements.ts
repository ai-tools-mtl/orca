import { defineOrchestrationMethod } from './access/orchestration-method-access'
import {
  coordinatedRunAccess,
  inspectedRunAccess,
  routingSupplementSendAccess
} from './access/run-access-rules'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { structuredMailboxCustody } from '../../../orchestration/mailbox/routing/structured-session-mail-target'
import { deliverTargetedSupplement } from '../../../orchestration/routing/targeted-supplement-delivery'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import type {
  RoutingInputRow,
  RoutingSubActionRow,
  RoutingSupplementAttemptRow,
  RoutingSupplementRow
} from '../../../orchestration/db/orchestration-records'
import {
  RoutingDecisionRegisterParams,
  RoutingInputRegisterParams,
  RoutingSupplementSendParams,
  RoutingSupplementShowParams,
  RoutingTargetShowParams
} from '../../../../../shared/rpc-contract/orchestration/orchestration-routing-params'

type RoutingSubActionInput = {
  text: string
  constraints?: string[]
  task?: string | null
}

function parseSubActions(raw: string): RoutingSubActionInput[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Invalid --sub-actions: must be a JSON array')
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof (entry as RoutingSubActionInput).text === 'string' &&
        (entry as RoutingSubActionInput).text.length > 0
    )
  ) {
    throw new Error('Invalid --sub-actions: expected a non-empty array of {text, constraints?, task?}')
  }
  return parsed as RoutingSubActionInput[]
}

function supplementReceipt(
  supplement: RoutingSupplementRow,
  attempt: RoutingSupplementAttemptRow,
  session?: string
) {
  return {
    inputId: supplement.input_id,
    supplementId: supplement.supplement_id,
    subActionId: supplement.sub_action_id,
    dispatchId: attempt.target_dispatch_id,
    attemptId: attempt.attempt_id,
    requestId: attempt.request_id,
    expectedTurnId: attempt.expected_turn_id,
    outcome: attempt.outcome,
    refusalKind: attempt.refusal_kind ?? undefined,
    detail: attempt.detail ?? undefined,
    turnId: attempt.turn_id ?? undefined,
    sessionId: session
  }
}

export const ORCHESTRATION_ROUTING_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.routingInputRegister',
    permission: 'workspace',
    params: RoutingInputRegisterParams,
    access: {
      kind: 'writes',
      caller: 'from',
      targets: { run: 'run' },
      rule: coordinatedRunAccess
    },
    handler: (params, { runtime }, { run }) => {
      const db = runtime.getOrchestrationDb()
      const input = db.registerRoutingInput({ runId: run.id, text: params.text })
      return { input }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.routingDecisionRegister',
    permission: 'workspace',
    params: RoutingDecisionRegisterParams,
    access: {
      kind: 'writes',
      caller: 'from',
      targets: { run: 'run' },
      rule: coordinatedRunAccess
    },
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const subActions = db.registerRoutingDecision({
        inputId: params.input,
        subActions: parseSubActions(params.subActions)
      })
      return { inputId: params.input, subActions }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.routingSupplementSend',
    permission: 'workspace',
    params: RoutingSupplementSendParams,
    access: {
      kind: 'writes',
      caller: 'from',
      targets: { dispatch: 'dispatch', run: 'run' },
      rule: routingSupplementSendAccess
    },
    handler: async (params, { runtime }) => {
      const result = await deliverTargetedSupplement({
        db: runtime.getOrchestrationDb(),
        inputId: params.input,
        subActionId: params.subAction,
        targetDispatchId: params.dispatch,
        text: params.text,
        ...(params.expectedTurn ? { expectedTurnId: params.expectedTurn } : {})
      })
      return supplementReceipt(result.supplement, result.attempt, result.session)
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.routingSupplementShow',
    permission: 'workspace',
    params: RoutingSupplementShowParams,
    access: {
      kind: 'reads',
      caller: 'from',
      targets: { run: 'run' },
      collection: true,
      rule: inspectedRunAccess
    },
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const supplements = params.supplement
        ? [requireSupplement(db, params.supplement)]
        : params.subAction
          ? db.listSupplements(params.subAction)
          : []
      return {
        supplements: supplements.map((supplement) => ({
          supplement,
          attempts: db.listSupplementAttempts(supplement.supplement_id)
        }))
      }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.routingTargetShow',
    permission: 'workspace',
    params: RoutingTargetShowParams,
    access: {
      kind: 'reads',
      caller: 'from',
      targets: { dispatch: 'dispatch', run: 'run' },
      rule: routingSupplementSendAccess
    },
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const dispatch = db.getDispatchContextById(params.dispatch)
      if (!dispatch) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Dispatch ${params.dispatch} was not found.`
        )
      }
      const custody = structuredMailboxCustody(`dispatch:${dispatch.id}`, db)
      if (typeof custody !== 'object') {
        return { dispatchId: dispatch.id, dispatchStatus: dispatch.status, sessionId: null, activeTurnId: null }
      }
      const host = getStructuredAgentSessionHost()
      const activeTurnId = host
        ? ((await host.currentWorkAtRest(custody.sessionId))?.activeTurnId() ?? null)
        : null
      return {
        dispatchId: dispatch.id,
        dispatchStatus: dispatch.status,
        sessionId: custody.sessionId,
        activeTurnId
      }
    }
  })
] as const

function requireSupplement(db: OrchestrationDb, supplementId: string): RoutingSupplementRow {
  const supplement = db.getSupplement(supplementId)
  if (!supplement) {
    throw new OrchestrationError(
      'lifecycle_not_found',
      `Supplement ${supplementId} was not found.`,
      { supplementId }
    )
  }
  return supplement
}

export type RoutingInputReceipt = { input: RoutingInputRow }
export type RoutingSubActionsReceipt = { inputId: string; subActions: RoutingSubActionRow[] }
export type RoutingSupplementsReceipt = {
  supplements: { supplement: RoutingSupplementRow; attempts: RoutingSupplementAttemptRow[] }[]
}
