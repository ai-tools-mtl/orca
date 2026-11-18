import { defineOrchestrationMethod } from './access/orchestration-method-access'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { generateId } from '../../../orchestration/db/generated-id'
import { routingSupplementSendAccess } from './access/run-access-rules'
import {
  RoutingContinuationBindParams,
  RoutingSubActionClaimParams,
  RoutingSubActionHandbackParams,
  RoutingSupplementContinueParams
} from '../../../../../shared/rpc-contract/orchestration/orchestration-routing-params'

export const ORCHESTRATION_ROUTING_CONTINUATION_METHODS = [
  // §5.2 (phase B): one valid execution target per sub-action — claim before supplementing a
  // new target, hand back to release. Handback refuses sub-actions already consumed on the
  // claimed Dispatch (only unexecuted sub-actions can be handed back).
  defineOrchestrationMethod({
    name: 'orchestration.routingSubActionClaim',
    permission: 'workspace',
    params: RoutingSubActionClaimParams,
    access: {
      kind: 'writes',
      caller: 'from',
      targets: { dispatch: 'dispatch', run: 'run' },
      rule: routingSupplementSendAccess
    },
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const subAction = db.getSubAction(params.subAction)
      if (!subAction || subAction.input_id !== params.input) {
        throw new OrchestrationError(
          'lifecycle_not_found',
          `Sub-action ${params.subAction} does not belong to input ${params.input}.`,
          { subActionId: params.subAction, inputId: params.input }
        )
      }
      if (!db.getDispatchContextById(params.dispatch)) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Dispatch ${params.dispatch} was not found.`,
          { dispatchId: params.dispatch }
        )
      }
      const subActionRow = db.claimSubActionForDispatch(params.subAction, params.dispatch)
      return {
        subAction: subActionRow,
        claimVersion: subActionRow.claim_version
      }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.routingSubActionHandback',
    permission: 'workspace',
    params: RoutingSubActionHandbackParams,
    access: {
      kind: 'writes',
      caller: 'from',
      targets: { dispatch: 'dispatch', run: 'run' },
      rule: routingSupplementSendAccess
    },
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const subAction = db.getSubAction(params.subAction)
      if (!subAction || subAction.input_id !== params.input) {
        throw new OrchestrationError(
          'lifecycle_not_found',
          `Sub-action ${params.subAction} does not belong to input ${params.input}.`,
          { subActionId: params.subAction, inputId: params.input }
        )
      }
      // §5.2: only an unexecuted sub-action can be handed back — a delivered consumption on the
      // claimed Dispatch puts it in 待核对 instead.
      const consumed = db
        .listSupplements(params.subAction)
        .some((supplement) =>
          db
            .listSupplementAttempts(supplement.supplement_id)
            .some(
              (attempt) =>
                attempt.target_dispatch_id === params.dispatch && attempt.outcome === 'delivered'
            )
        )
      if (consumed) {
        throw new OrchestrationError(
          'lifecycle_conflict',
          `Sub-action ${params.subAction} was already delivered on ${params.dispatch}; it stays in 待核对 instead of a handback.`,
          { subActionId: params.subAction, dispatchId: params.dispatch }
        )
      }
      const result = db.handbackSubAction({
        subActionId: params.subAction,
        fromDispatchId: params.dispatch,
        reason: params.reason ?? null
      })
      return {
        released: result.released,
        subAction: result.subAction,
        handback: result.handback ?? null
      }
    }
  }),

  // §5.3 row 3: a settled Dispatch's unconsumed supplement continues through exactly one
  // follow-up. This registers (or reuses) the continuation record; the caller performs the
  // follow-up send itself — reusing the returned request id as its retry id — and binds the
  // resulting Dispatch with orchestration.routingContinuationBind.
  defineOrchestrationMethod({
    name: 'orchestration.routingSupplementContinue',
    permission: 'workspace',
    params: RoutingSupplementContinueParams,
    access: {
      kind: 'writes',
      caller: 'from',
      targets: { dispatch: 'dispatch', run: 'run' },
      rule: routingSupplementSendAccess
    },
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const dispatch = db.getDispatchContextById(params.dispatch)
      if (!dispatch) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Dispatch ${params.dispatch} was not found.`,
          { dispatchId: params.dispatch }
        )
      }
      const subAction = db.getSubAction(params.subAction)
      if (!subAction || subAction.input_id !== params.input) {
        throw new OrchestrationError(
          'lifecycle_not_found',
          `Sub-action ${params.subAction} does not belong to input ${params.input}.`,
          { subActionId: params.subAction, inputId: params.input }
        )
      }
      // Continuation is the settled-Dispatch path; an active Dispatch still owns the
      // targeted-delivery path (§5.3 row 1).
      if (dispatch.status === 'dispatched') {
        throw new OrchestrationError(
          'lifecycle_conflict',
          `Dispatch ${dispatch.id} is still dispatched; use orchestration.routingSupplementSend.`,
          { dispatchId: dispatch.id, status: dispatch.status }
        )
      }
      const consumed = db
        .listSupplements(params.subAction)
        .some((supplement) =>
          db
            .listSupplementAttempts(supplement.supplement_id)
            .some(
              (attempt) =>
                attempt.target_dispatch_id === dispatch.id && attempt.outcome === 'delivered'
            )
        )
      if (consumed) {
        throw new OrchestrationError(
          'lifecycle_conflict',
          `The supplement was already consumed on Dispatch ${dispatch.id}; continuation is not applicable.`,
          { subActionId: params.subAction, dispatchId: dispatch.id }
        )
      }
      const requestId =
        db
          .listSupplements(params.subAction)
          .flatMap((supplement) => db.listSupplementAttempts(supplement.supplement_id))
          .at(-1)?.request_id ?? generateId('rtcont')
      const { continuation, reused } = db.recordRoutingContinuation({
        subActionId: params.subAction,
        inputId: params.input,
        sourceDispatchId: dispatch.id,
        requestId
      })
      return { continuation, requestId: continuation.request_id, reused }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.routingContinuationBind',
    permission: 'workspace',
    params: RoutingContinuationBindParams,
    access: {
      kind: 'writes',
      caller: 'from',
      targets: { dispatch: 'dispatch', run: 'run' },
      rule: routingSupplementSendAccess
    },
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      return {
        continuation: db.bindRoutingContinuationFollowUp(params.subAction, params.dispatch)
      }
    }
  })
]
