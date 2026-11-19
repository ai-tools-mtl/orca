import type { CommandHandler } from '../../dispatch/dispatch'
import { printResult } from '../../output/command-result-output'
import { printOrchestrationResult } from '../agent-view'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../arguments/flags'
import { callOrchestrationMutation } from '../recovery/mutation-request'
import { resolveCoordinatorTerminalHandle } from '../identity/terminal-identity'

type SupplementReceipt = {
  inputId: string
  supplementId: string
  subActionId: string
  dispatchId: string
  attemptId: string
  requestId: string
  expectedTurnId: string | null
  outcome: string
  refusalKind?: string
  detail?: string
  turnId?: string
  sessionId?: string
}

export const ORCHESTRATION_ROUTING_DELIVERY_HANDLERS: Record<string, CommandHandler> = {
  'orchestration routing-supplement-send': async ({ flags, client, cwd, json }) => {
    const result = await callOrchestrationMutation<SupplementReceipt>(
      client,
      flags,
      'orchestration.routingSupplementSend',
      {
        input: getRequiredStringFlag(flags, 'input'),
        subAction: getRequiredStringFlag(flags, 'sub-action'),
        dispatch: getRequiredStringFlag(flags, 'dispatch'),
        text: getRequiredStringFlag(flags, 'text'),
        expectedTurn: getOptionalStringFlag(flags, 'expected-turn'),
        from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
      }
    )
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, {
        fields: (value) => supplementReceiptFields(value)
      })
      return
    }
    printResult(result, json, (value) => sendReceiptLine(value))
  },

  'orchestration routing-sub-action-verify': async ({ flags, client, cwd, json }) => {
    const result = await client.call<{
      verdict: {
        verdict: string
        reason?: string
        firstAction?: { sequence: number; name: string; path?: string }
      }
      subAction: { sub_action_id: string; state: string }
      attempt: { attempt_id: string; first_action_json: string | null }
      echoSequence: number | null
    }>('orchestration.routingSubActionVerify', {
      input: getRequiredStringFlag(flags, 'input'),
      subAction: getRequiredStringFlag(flags, 'sub-action'),
      dispatch: getRequiredStringFlag(flags, 'dispatch'),
      expectedTurn: getRequiredStringFlag(flags, 'expected-turn'),
      text: getRequiredStringFlag(flags, 'text'),
      expectAction: getRequiredStringFlag(flags, 'expect-action'),
      expectPath: getOptionalStringFlag(flags, 'expect-path'),
      forbiddenPaths: getOptionalStringFlag(flags, 'forbidden-paths'),
      items: getRequiredStringFlag(flags, 'items'),
      run: getOptionalStringFlag(flags, 'run'),
      from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
    })
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, {
        fields: (value) => ({
          verdict: value.verdict.verdict,
          reason: value.verdict.reason,
          firstAction: value.verdict.firstAction,
          subActionState: value.subAction.state
        })
      })
      return
    }
    printResult(
      result,
      json,
      (value) =>
        `Sub-action ${value.subAction.sub_action_id} verdict=${value.verdict.verdict} state=${value.subAction.state} echo=${value.echoSequence ?? 'none'}.`
    )
  }
}

function supplementReceiptFields(value: SupplementReceipt) {
  return {
    outcome: value.outcome,
    supplementId: value.supplementId,
    subActionId: value.subActionId,
    dispatchId: value.dispatchId,
    attemptId: value.attemptId,
    requestId: value.requestId,
    expectedTurnId: value.expectedTurnId ?? undefined,
    turnId: value.turnId,
    refusalKind: value.refusalKind,
    detail: value.detail
  }
}

function sendReceiptLine(value: SupplementReceipt): string {
  const parts = [
    `attempt ${value.attemptId}`,
    `outcome=${value.outcome}`,
    `request ${value.requestId}`
  ]
  if (value.expectedTurnId) {
    parts.push(`expectedTurn ${value.expectedTurnId}`)
  }
  if (value.turnId) {
    parts.push(`turn ${value.turnId}`)
  }
  if (value.refusalKind) {
    parts.push(`refused:${value.refusalKind}`)
  }
  return parts.join(' ')
}
