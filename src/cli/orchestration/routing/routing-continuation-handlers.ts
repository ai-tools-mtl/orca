import type { CommandHandler } from '../../dispatch/dispatch'
import { printResult } from '../../output/command-result-output'
import { printOrchestrationResult } from '../agent-view'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../arguments/flags'
import { callOrchestrationMutation } from '../recovery/mutation-request'
import { resolveCoordinatorTerminalHandle } from '../identity/terminal-identity'

type ReviewCycleRow = {
  cycle_id: string
  task_id: string
  writer_dispatch_id: string
  reviewer_dispatch_id: string
  current_revision: number
  state: string
}

export const ORCHESTRATION_ROUTING_CONTINUATION_HANDLERS: Record<string, CommandHandler> = {
  'orchestration review-cycle-start': async ({ flags, client, cwd, json }) => {
    const result = await callOrchestrationMutation<{ cycle: ReviewCycleRow }>(
      client,
      flags,
      'orchestration.reviewCycleStart',
      {
        task: getRequiredStringFlag(flags, 'task'),
        writerDispatch: getRequiredStringFlag(flags, 'writer-dispatch'),
        reviewerDispatch: getRequiredStringFlag(flags, 'reviewer-dispatch'),
        run: getOptionalStringFlag(flags, 'run'),
        from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
      }
    )
    printOrchestrationResult(result, json, {
      fields: (value) => ({
        cycleId: value.cycle.cycle_id,
        revision: value.cycle.current_revision,
        state: value.cycle.state
      })
    })
  },

  'orchestration review-revision-submit': async ({ flags, client, cwd, json }) => {
    const result = await callOrchestrationMutation<{ cycle: ReviewCycleRow }>(
      client,
      flags,
      'orchestration.reviewRevisionSubmit',
      {
        cycle: getRequiredStringFlag(flags, 'cycle'),
        run: getOptionalStringFlag(flags, 'run'),
        from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
      }
    )
    printOrchestrationResult(result, json, {
      fields: (value) => ({
        cycleId: value.cycle.cycle_id,
        revision: value.cycle.current_revision,
        state: value.cycle.state
      })
    })
  },

  'orchestration review-opinion-record': async ({ flags, client, cwd, json }) => {
    const result = await callOrchestrationMutation<{
      opinion: { opinion_id: string; revision: number; body: string; state: string }
      cycle: ReviewCycleRow
    }>(client, flags, 'orchestration.reviewOpinionRecord', {
      cycle: getRequiredStringFlag(flags, 'cycle'),
      body: getRequiredStringFlag(flags, 'body'),
      blocking: flags.has('non-blocking') ? false : undefined,
      run: getOptionalStringFlag(flags, 'run'),
      from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
    })
    printOrchestrationResult(result, json, {
      fields: (value) => ({
        opinionId: value.opinion.opinion_id,
        revision: value.opinion.revision,
        state: value.opinion.state,
        cycleState: value.cycle.state
      })
    })
  },

  'orchestration review-cycle-show': async ({ flags, client, cwd, json }) => {
    const result = await client.call<{
      cycle: ReviewCycleRow
      opinions: { opinion_id: string; revision: number; body: string; state: string }[]
    }>('orchestration.reviewCycleShow', {
      cycle: getRequiredStringFlag(flags, 'cycle'),
      run: getOptionalStringFlag(flags, 'run'),
      from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
    })
    printOrchestrationResult(result, json, {
      fields: (value) => ({
        cycleId: value.cycle.cycle_id,
        revision: value.cycle.current_revision,
        state: value.cycle.state,
        opinions: value.opinions.map((opinion) => ({
          id: opinion.opinion_id,
          revision: opinion.revision,
          state: opinion.state,
          body: opinion.body
        }))
      })
    })
  },

  'orchestration review-cycle-accept': async ({ flags, client, cwd, json }) => {
    const result = await callOrchestrationMutation<{ cycle: ReviewCycleRow }>(
      client,
      flags,
      'orchestration.reviewCycleAccept',
      {
        cycle: getRequiredStringFlag(flags, 'cycle'),
        run: getOptionalStringFlag(flags, 'run'),
        from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
      }
    )
    printOrchestrationResult(result, json, {
      fields: (value) => ({
        cycleId: value.cycle.cycle_id,
        state: value.cycle.state
      })
    })
  },

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
