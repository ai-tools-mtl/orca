import type { CommandHandler } from '../../dispatch/dispatch'
import { printResult } from '../../output/command-result-output'
import { printOrchestrationResult } from '../agent-view'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../arguments/flags'
import { callOrchestrationMutation } from '../recovery/mutation-request'
import { resolveCoordinatorTerminalHandle } from '../identity/terminal-identity'

export const ORCHESTRATION_ROUTING_CONTINUATION_HANDLERS: Record<string, CommandHandler> = {
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
