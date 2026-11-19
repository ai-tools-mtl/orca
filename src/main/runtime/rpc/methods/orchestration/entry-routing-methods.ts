import type { RpcContext } from '../../core'
import { isAgentRpcCaller } from '../../callers/rpc-caller-identity'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { autoRouteWithModelProvider } from '../../../orchestration/routing/model-decision-provider'
import { readZcodeV2PlanCredential } from '../../../../zcode/zcode-v2-plan-credentials'
import {
  EntryAssignParams,
  EntryAutoRouteParams,
  EntryPlanParams,
  EntryShowParams
} from '../../../../../shared/rpc-contract/orchestration/orchestration-routing-params'
import { defineOrchestrationMethod } from './access/orchestration-method-access'
import {
  dispatchEntryDecision,
  dispatchEntrySubAction,
  entryPlacement,
  entryRunOfInput
} from './entry-dispatch'

function requireEntryOperator(ctx: RpcContext): void {
  if (!ctx.caller || ctx.plugin || ctx.orchestrationCaller || isAgentRpcCaller(ctx.caller)) {
    throw new OrchestrationError('invalid_argument', 'Assign workers from the project task entry.')
  }
}

export const ORCHESTRATION_ENTRY_ROUTING_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.entryPlan',
    permission: 'workspace',
    params: EntryPlanParams,
    access: { kind: 'localOnly', targets: {} },
    handler: ({ group, input, subActions }, ctx) => {
      requireEntryOperator(ctx)
      const { runtime } = ctx
      const db = runtime.getOrchestrationDb()
      entryRunOfInput(db, group, input)
      return db.registerRoutingDecision({
        inputId: input,
        subActions: subActions.map((text) => ({ text }))
      })
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.entryAgents',
    permission: 'workspace',
    params: EntryShowParams,
    access: { kind: 'localOnly', targets: {} },
    handler: async ({ group }, { runtime }) => ({
      agents: (await entryPlacement(runtime, group)).agents
    })
  }),
  defineOrchestrationMethod({
    name: 'orchestration.entryAssign',
    permission: 'workspace',
    requires: ['accounts'],
    params: EntryAssignParams,
    access: { kind: 'localOnly', targets: {} },
    handler: async ({ group, input, subAction, agent }, ctx) => {
      requireEntryOperator(ctx)
      const { runtime } = ctx
      const run = entryRunOfInput(runtime.getOrchestrationDb(), group, input)
      await dispatchEntrySubAction({
        runtime,
        run,
        group,
        inputId: input,
        subActionId: subAction,
        agent,
        placement: await entryPlacement(runtime, group)
      })
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.entryAutoRoute',
    permission: 'workspace',
    params: EntryAutoRouteParams,
    requires: ['accounts'],
    access: { kind: 'localOnly', targets: {} },
    handler: async (params, ctx) => {
      if (params.dispatch) {
        requireEntryOperator(ctx)
      }
      const { runtime } = ctx
      const db = runtime.getOrchestrationDb()
      const run = entryRunOfInput(db, params.group, params.input)
      const credential =
        params.decisionModel?.provider === 'custom'
          ? {
              status: 'ok' as const,
              protocol: 'openai' as const,
              apiKey: params.decisionModel.apiKey ?? '',
              baseUrl: params.decisionModel.baseUrl ?? '',
              modelId: params.decisionModel.modelId ?? ''
            }
          : await readZcodeV2PlanCredential()
      const decision = await autoRouteWithModelProvider(db, { inputId: params.input }, credential)
      if (!params.dispatch || !decision.routed || decision.reused) {
        return decision
      }
      const errors = await dispatchEntryDecision({
        runtime,
        run,
        group: params.group,
        inputId: params.input,
        agents: new Map(
          decision.subActions.flatMap((action) =>
            action.agent ? [[action.sub_action_id, action.agent]] : []
          )
        )
      })
      return { ...decision, dispatchErrors: errors.filter((error) => error !== null) }
    }
  })
]
