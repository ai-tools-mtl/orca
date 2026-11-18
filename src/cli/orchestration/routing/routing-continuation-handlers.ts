import type { CommandHandler } from '../../dispatch/dispatch'
import { printResult } from '../../output/command-result-output'
import { printOrchestrationResult } from '../agent-view'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../arguments/flags'
import { callOrchestrationMutation } from '../recovery/mutation-request'
import { resolveCoordinatorTerminalHandle } from '../identity/terminal-identity'

export const ORCHESTRATION_ROUTING_CONTINUATION_HANDLERS: Record<string, CommandHandler> = {
  'orchestration routing-sub-action-claim': async ({ flags, client, cwd, json }) => {
    const result = await callOrchestrationMutation<{
      subAction: {
        sub_action_id: string
        claimed_dispatch_id: string | null
        claim_version: number
      }
      claimVersion: number
    }>(client, flags, 'orchestration.routingSubActionClaim', {
      input: getRequiredStringFlag(flags, 'input'),
      subAction: getRequiredStringFlag(flags, 'sub-action'),
      dispatch: getRequiredStringFlag(flags, 'dispatch'),
      run: getOptionalStringFlag(flags, 'run'),
      from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
    })
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, {
        fields: (value) => ({
          subActionId: value.subAction.sub_action_id,
          claimedBy: value.subAction.claimed_dispatch_id ?? undefined,
          claimVersion: value.claimVersion
        })
      })
      return
    }
    printResult(
      result,
      json,
      (value) =>
        `Sub-action ${value.subAction.sub_action_id} claimed by ${value.subAction.claimed_dispatch_id ?? 'none'} (claim v${value.claimVersion}).`
    )
  },

  'orchestration routing-sub-action-handback': async ({ flags, client, cwd, json }) => {
    const result = await callOrchestrationMutation<{
      released: boolean
      subAction: {
        sub_action_id: string
        claimed_dispatch_id: string | null
        claim_version: number
      }
      handback: { claim_version: number; handed_back_from: string; reason: string | null } | null
    }>(client, flags, 'orchestration.routingSubActionHandback', {
      input: getRequiredStringFlag(flags, 'input'),
      subAction: getRequiredStringFlag(flags, 'sub-action'),
      dispatch: getRequiredStringFlag(flags, 'dispatch'),
      reason: getOptionalStringFlag(flags, 'reason'),
      run: getOptionalStringFlag(flags, 'run'),
      from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
    })
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, {
        fields: (value) => ({
          released: value.released,
          subActionId: value.subAction.sub_action_id,
          claimVersion: value.subAction.claim_version,
          handedBackFrom: value.handback?.handed_back_from,
          reason: value.handback?.reason ?? undefined
        })
      })
      return
    }
    printResult(result, json, (value) =>
      value.released
        ? `Sub-action ${value.subAction.sub_action_id} handed back from ${value.handback?.handed_back_from ?? 'unknown'}; awaiting re-assignment.`
        : `Sub-action ${value.subAction.sub_action_id} was not claimed by ${'--dispatch'}; nothing released.`
    )
  },

  'orchestration routing-supplement-continue': async ({ flags, client, cwd, json }) => {
    const result = await callOrchestrationMutation<{
      continuation: {
        sub_action_id: string
        source_dispatch_id: string
        follow_up_dispatch_id: string | null
        request_id: string
      }
      requestId: string
      reused: boolean
    }>(client, flags, 'orchestration.routingSupplementContinue', {
      input: getRequiredStringFlag(flags, 'input'),
      subAction: getRequiredStringFlag(flags, 'sub-action'),
      dispatch: getRequiredStringFlag(flags, 'dispatch'),
      run: getOptionalStringFlag(flags, 'run'),
      from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
    })
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, {
        fields: (value) => ({
          subActionId: value.continuation.sub_action_id,
          requestId: value.continuation.request_id,
          reused: value.reused,
          followUpDispatchId: value.continuation.follow_up_dispatch_id ?? undefined
        })
      })
      return
    }
    printResult(
      result,
      json,
      (value) =>
        `Continuation ${value.reused ? 'reused' : 'registered'} for ${value.continuation.sub_action_id}; send the follow-up with --retry-request ${value.requestId}, then bind it via orchestration routing-continuation-bind.`
    )
  },

  'orchestration routing-continuation-bind': async ({ flags, client, cwd, json }) => {
    const result = await callOrchestrationMutation<{
      continuation: {
        sub_action_id: string
        follow_up_dispatch_id: string | null
        request_id: string
      }
    }>(client, flags, 'orchestration.routingContinuationBind', {
      subAction: getRequiredStringFlag(flags, 'sub-action'),
      dispatch: getRequiredStringFlag(flags, 'dispatch'),
      run: getOptionalStringFlag(flags, 'run'),
      from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
    })
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, {
        fields: (value) => ({
          subActionId: value.continuation.sub_action_id,
          followUpDispatchId: value.continuation.follow_up_dispatch_id ?? undefined
        })
      })
      return
    }
    printResult(
      result,
      json,
      (value) =>
        `Sub-action ${value.continuation.sub_action_id} continues through ${value.continuation.follow_up_dispatch_id ?? 'none'}.`
    )
  }
}
