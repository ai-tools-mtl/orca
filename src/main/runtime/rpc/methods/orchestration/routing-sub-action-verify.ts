import { defineOrchestrationMethod } from './access/orchestration-method-access'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { routingSupplementSendAccess } from './access/run-access-rules'
import {
  findSupplementEchoSequence,
  verifySupplementFirstAction,
  type RoutingConversationItem
} from '../../../orchestration/routing/first-action-verification'
import { RoutingSubActionVerifyParams } from '../../../../../shared/rpc-contract/orchestration/orchestration-routing-params'

export const ORCHESTRATION_ROUTING_SUB_ACTION_VERIFY_METHODS = [
  // §5.3 任务卡的证据: the runtime owns the consumption verdict — the caller supplies the same
  // projected history rows it reads via agentSession.history; the judgment and the ledger
  // evidence (first-action + card state) are recorded here, not on the caller.
  defineOrchestrationMethod({
    name: 'orchestration.routingSubActionVerify',
    permission: 'workspace',
    params: RoutingSubActionVerifyParams,
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
      let items: RoutingConversationItem[]
      try {
        const parsed: unknown = JSON.parse(params.items)
        if (!Array.isArray(parsed)) {
          throw new Error('not an array')
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows are the caller's JSON projection of agentSession.history; field guards below re-check the fields the verdict reads.
        items = parsed as RoutingConversationItem[]
      } catch {
        throw new Error('Invalid --items: must be a JSON array of projected history items')
      }
      let forbiddenPaths: string[] | undefined
      if (params.forbiddenPaths) {
        const parsed: unknown = JSON.parse(params.forbiddenPaths)
        if (!Array.isArray(parsed) || !parsed.every((path) => typeof path === 'string')) {
          throw new Error('Invalid --forbidden-paths: must be a JSON array of strings')
        }
        forbiddenPaths = parsed
      }
      const delivered = db
        .listSupplements(params.subAction)
        .flatMap((supplement) => db.listSupplementAttempts(supplement.supplement_id))
        .findLast(
          (attempt) =>
            attempt.outcome === 'delivered' && attempt.expected_turn_id === params.expectedTurn
        )
      if (!delivered) {
        throw new OrchestrationError(
          'lifecycle_not_found',
          `No delivered attempt for sub-action ${params.subAction} on turn ${params.expectedTurn}.`,
          { subActionId: params.subAction, expectedTurnId: params.expectedTurn }
        )
      }
      // The echo wins as anchor when the provider journals it as its own user message; otherwise
      // the caller's fallback anchor (e.g. the last pre-delivery task action) is used.
      const echo = findSupplementEchoSequence(items, params.text)
      const afterSequence = echo ?? params.anchorSequence ?? null
      if (afterSequence === null) {
        const verdict = {
          verdict: 'unverifiable',
          reason: 'the supplement echo is not present and no fallback anchor was provided'
        }
        const recorded = db.recordSupplementFirstActionEvidence({
          attemptId: delivered.attempt_id,
          subActionId: params.subAction,
          verdict
        })
        return {
          verdict,
          subAction: recorded.subAction,
          attempt: recorded.attempt,
          echoSequence: null
        }
      }
      const verdict = verifySupplementFirstAction(items, {
        afterSequence,
        expect: {
          actionName: params.expectAction,
          ...(params.expectPath ? { inputPath: params.expectPath } : {})
        },
        ...(forbiddenPaths ? { forbiddenPaths } : {}),
        expectedTurnId: params.expectedTurn
      })
      const recorded = db.recordSupplementFirstActionEvidence({
        attemptId: delivered.attempt_id,
        subActionId: params.subAction,
        verdict
      })
      return {
        verdict,
        subAction: recorded.subAction,
        attempt: recorded.attempt,
        echoSequence: echo
      }
    }
  })
]
