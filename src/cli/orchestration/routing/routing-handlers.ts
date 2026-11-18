import type { CommandHandler } from '../../dispatch/dispatch'
import { printResult } from '../../output/command-result-output'
import { printOrchestrationResult } from '../agent-view'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../arguments/flags'
import { callOrchestrationMutation } from '../recovery/mutation-request'
import {
  resolveCoordinatorTerminalHandle,
  runScopedSessionCaller
} from '../identity/terminal-identity'

export const ORCHESTRATION_ROUTING_HANDLERS: Record<string, CommandHandler> = {
  'orchestration routing-input-register': async ({ flags, client, cwd, json }) => {
    const result = await callOrchestrationMutation<{
      input: { input_id: string; run_id: string; received_seq: number }
    }>(client, flags, 'orchestration.routingInputRegister', {
      text: getRequiredStringFlag(flags, 'text'),
      run: getOptionalStringFlag(flags, 'run'),
      from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
    })
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, {
        fields: (value) => ({
          inputId: value.input.input_id,
          runId: value.input.run_id,
          receivedSeq: value.input.received_seq
        })
      })
      return
    }
    printResult(
      result,
      json,
      (value) => `Input ${value.input.input_id} received in run ${value.input.run_id}.`
    )
  },

  'orchestration routing-decision-register': async ({ flags, client, cwd, json }) => {
    const result = await callOrchestrationMutation<{
      inputId: string
      subActions: { sub_action_id: string; text: string; constraints_json: string }[]
      reused: boolean
    }>(client, flags, 'orchestration.routingDecisionRegister', {
      input: getRequiredStringFlag(flags, 'input'),
      subActions: getRequiredStringFlag(flags, 'sub-actions'),
      run: getOptionalStringFlag(flags, 'run'),
      from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
    })
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, {
        fields: (value) => ({
          inputId: value.inputId,
          subActions: value.subActions.map((subAction) => {
            const constraints: string[] = JSON.parse(subAction.constraints_json)
            return {
              id: subAction.sub_action_id,
              text: subAction.text,
              constraints
            }
          })
        })
      })
      return
    }
    printResult(
      result,
      json,
      (value) =>
        `Decision ${value.reused ? 'reused' : 'registered'} for ${value.inputId}: ${value.subActions
          .map((subAction) => subAction.sub_action_id)
          .join(', ')}`
    )
  },

  'orchestration routing-inputs-show': async ({ flags, client, cwd, json }) => {
    const run = getOptionalStringFlag(flags, 'run')
    const from = run
      ? runScopedSessionCaller(flags)
      : await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await client.call<{
      inputs: {
        input: { input_id: string; received_seq: number; decision_status: string }
        subActions: {
          subAction: { sub_action_id: string; text: string; task_id: string | null }
          deliveries: {
            supplement: { supplement_id: string; target_dispatch_id: string }
            attempts: { outcome: string; refusal_kind: string | null; request_id: string }[]
          }[]
        }[]
      }[]
    }>('orchestration.routingInputsShow', { run, from })
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, {
        fields: (value) => ({
          inputs: value.inputs.map((entry) => ({
            inputId: entry.input.input_id,
            decision: entry.input.decision_status,
            subActions: entry.subActions.map((subAction) => ({
              id: subAction.subAction.sub_action_id,
              task: subAction.subAction.task_id ?? undefined,
              deliveries: subAction.deliveries.map((delivery) => ({
                dispatch: delivery.supplement.target_dispatch_id,
                lastOutcome: delivery.attempts.at(-1)?.outcome ?? 'none'
              }))
            }))
          }))
        })
      })
      return
    }
    printResult(result, json, (value) => `${value.inputs.length} routing input(s) recorded.`)
  },

  'orchestration routing-auto-route': async ({ flags, client, cwd, json }) => {
    const result = await client.call<{
      routed: boolean
      reused: boolean
      reason?: string
      subActions: { sub_action_id: string; text: string; task_id: string | null }[]
    }>('orchestration.routingAutoRoute', {
      input: getRequiredStringFlag(flags, 'input'),
      timeoutMs: getOptionalStringFlag(flags, 'timeout-ms'),
      run: getOptionalStringFlag(flags, 'run'),
      from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
    })
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, {
        fields: (value) => ({
          routed: value.routed,
          reused: value.reused,
          reason: value.reason,
          subActions: value.subActions.map((subAction) => ({
            id: subAction.sub_action_id,
            text: subAction.text,
            task: subAction.task_id ?? undefined
          }))
        })
      })
      return
    }
    printResult(result, json, (value) =>
      value.routed
        ? `Routed ${value.subActions.length} sub-action(s) for the input${value.reused ? ' (reused)' : ''}.`
        : `Not routed: ${value.reason ?? 'no reason recorded'}`
    )
  },

  'orchestration routing-watchdog-show': async ({ flags, client, cwd, json }) => {
    const run = getOptionalStringFlag(flags, 'run')
    const from = run
      ? runScopedSessionCaller(flags)
      : await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await client.call<{
      runId: string
      watchdog: {
        paused: boolean
        awaitingVerification: {
          inputId: string
          subActionId: string
          attemptId: string
          dispatchId: string
          expectedTurnId: string | null
        }[]
        pendingContinuations: { subActionId: string; sourceDispatchId: string; requestId: string }[]
      }
    }>('orchestration.routingWatchdogShow', { run, from })
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, {
        fields: (value) => ({
          runId: value.runId,
          paused: value.watchdog.paused,
          awaitingVerification: value.watchdog.awaitingVerification.length,
          pendingContinuations: value.watchdog.pendingContinuations.map((entry) => ({
            subActionId: entry.subActionId,
            sourceDispatchId: entry.sourceDispatchId,
            requestId: entry.requestId
          }))
        })
      })
      return
    }
    printResult(
      result,
      json,
      (value) =>
        `Run ${value.runId} paused=${value.watchdog.paused} awaitingVerification=${value.watchdog.awaitingVerification.length} pendingContinuations=${value.watchdog.pendingContinuations.length}.`
    )
  },

  'orchestration routing-supplement-show': async ({ flags, client, cwd, json }) => {
    const run = getOptionalStringFlag(flags, 'run')
    const from = run
      ? runScopedSessionCaller(flags)
      : await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await client.call<{
      supplements: {
        supplement: {
          supplement_id: string
          sub_action_id: string
          input_id: string
          target_dispatch_id: string
          raw_text: string
        }
        attempts: {
          attempt_id: string
          request_id: string
          expected_turn_id: string | null
          outcome: string
          refusal_kind: string | null
          detail: string | null
          turn_id: string | null
        }[]
      }[]
    }>('orchestration.routingSupplementShow', {
      supplement: getOptionalStringFlag(flags, 'supplement'),
      subAction: getOptionalStringFlag(flags, 'sub-action'),
      run,
      from
    })
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, {
        fields: (value) => ({
          supplements: value.supplements.map((entry) => ({
            supplementId: entry.supplement.supplement_id,
            subActionId: entry.supplement.sub_action_id,
            dispatchId: entry.supplement.target_dispatch_id,
            attempts: entry.attempts.map((attempt) => ({
              attemptId: attempt.attempt_id,
              requestId: attempt.request_id,
              expectedTurnId: attempt.expected_turn_id ?? undefined,
              outcome: attempt.outcome,
              refusalKind: attempt.refusal_kind ?? undefined,
              turnId: attempt.turn_id ?? undefined
            }))
          }))
        })
      })
      return
    }
    printResult(result, json, (value) =>
      value.supplements.length === 0
        ? 'No supplements found.'
        : value.supplements
            .map(
              (entry) =>
                `${entry.supplement.supplement_id} sub-action=${entry.supplement.sub_action_id} ${entry.attempts
                  .map((attempt) => attemptRowLine(attempt))
                  .join('; ')}`
            )
            .join('\n')
    )
  },

  'orchestration routing-target-show': async ({ flags, client, cwd, json }) => {
    const run = getOptionalStringFlag(flags, 'run')
    const from = run
      ? runScopedSessionCaller(flags)
      : await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await client.call<{
      dispatchId: string
      dispatchStatus: string
      sessionId: string | null
      activeTurnId: string | null
    }>('orchestration.routingTargetShow', {
      dispatch: getRequiredStringFlag(flags, 'dispatch'),
      run,
      from
    })
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, {
        fields: (value) => ({
          dispatchId: value.dispatchId,
          dispatchStatus: value.dispatchStatus,
          sessionId: value.sessionId ?? undefined,
          activeTurnId: value.activeTurnId ?? undefined
        })
      })
      return
    }
    printResult(
      result,
      json,
      (value) =>
        `Dispatch ${value.dispatchId} [${value.dispatchStatus}] session=${value.sessionId ?? 'none'} activeTurn=${value.activeTurnId ?? 'none'}`
    )
  }
}
