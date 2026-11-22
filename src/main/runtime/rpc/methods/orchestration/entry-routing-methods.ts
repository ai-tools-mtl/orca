import type { z } from 'zod'
import type { RpcContext } from '../../core'
import { recordEntryAssignmentError, recordEntryRoutingError } from './entry-assignment-errors'
import { deleteEntryRequests } from './entry-request-deletion'
import { isAgentRpcCaller } from '../../callers/rpc-caller-identity'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { normalizeDecisionModelSettings } from '../../../../../shared/settings/decision-model-settings'
import { autoRouteUnifiedAgentFromEntry } from './entry-unified-route'
import { completeEntryDispatch, type EntryRouteOutcome } from './entry-dispatch-completion'
import { testEntryRouting } from './entry-routing-probe'
import {
  EntryAssignParams,
  EntryAutoRouteParams,
  EntryDeleteParams,
  EntryPlanParams,
  EntryRoutingTestParams,
  EntryShowParams
} from '../../../../../shared/rpc-contract/orchestration/orchestration-routing-params'
import { defineOrchestrationMethod } from './access/orchestration-method-access'
import { dispatchEntrySubAction } from './entry-dispatch'
import { entryPlacement } from './entry-placement'
import { coordinatedEntryRun, entryRunOfInput } from './entry-run-scope'
import { entryStatusDigest } from './entry-results'

function requireEntryOperator(ctx: RpcContext): void {
  if (!ctx.caller || ctx.plugin || ctx.orchestrationCaller || isAgentRpcCaller(ctx.caller)) {
    throw new OrchestrationError(
      'invalid_argument',
      'Manage instructions from the project task entry.'
    )
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
      // 手动规划也是规划（§派发授权）：决定落库即未授权，轮询不派发——派发仍等显式
      // dispatch=true 或逐卡 entryAssign（手动派发入口不受影响）。
      return db.registerRoutingDecision({
        inputId: input,
        subActions: subActions.map((entry) =>
          typeof entry === 'string'
            ? { text: entry }
            : {
                text: entry.text,
                stageKind: entry.stageKind,
                gate: entry.gate,
                dependsOn: entry.dependsOn,
                ...(entry.agentHint ? { agentHint: entry.agentHint } : {})
              }
        )
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
      try {
        await dispatchEntrySubAction({
          runtime,
          run,
          group,
          inputId: input,
          subActionId: subAction,
          agent,
          placement: await entryPlacement(runtime, group)
        })
      } catch (error) {
        recordEntryAssignmentError(runtime.getOrchestrationDb(), input, subAction, error)
        throw error
      }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.entryDelete',
    permission: 'workspace',
    params: EntryDeleteParams,
    access: { kind: 'localOnly', targets: {} },
    handler: (params, ctx) => {
      requireEntryOperator(ctx)
      const db = ctx.runtime.getOrchestrationDb()
      const { run } = coordinatedEntryRun(db, params.group)
      return deleteEntryRequests(db, run.id, params)
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.entryAutoRoute',
    permission: 'workspace',
    params: EntryAutoRouteParams,
    requires: ['accounts'],
    access: { kind: 'localOnly', targets: {} },
    handler: (params, ctx) => {
      if (params.dispatch) {
        requireEntryOperator(ctx)
      }
      const { runtime } = ctx
      // 按（项目, 输入）合并同一运行时内的在途路由：并发与重放共享一次分类、一次拆分，
      // 最终只登记一次决定；settle 后的重复调用走已登记结果的复用路径。
      const key = `${params.group}\u0000${params.input}`
      let route = inFlightEntryRoutes.get(key)
      if (!route) {
        route = runEntryRoute(params, ctx).finally(() => {
          if (inFlightEntryRoutes.get(key) === route) {
            inFlightEntryRoutes.delete(key)
          }
        })
        inFlightEntryRoutes.set(key, route)
      }
      // dispatch=false：只规划。登记（或复用）已发生，但派发完成不在此调用——登记时带的
      // 派发保持把阶段推进器挡住，直到某次 dispatch=true 触达。
      // dispatch=true：区分「决定已登记」与「派发已受理」——即便路由是合并/重放复用的
      // （先前可能由 dispatch=false 登记），也要完成派发（幂等：已绑任务的子动作跳过，
      // 派发保持清除后阶段推进器才接管）。
      return route.then((routed) => {
        if (!params.dispatch || !routed.decision.routed) {
          return routed.decision
        }
        return completeEntryDispatch({
          db: runtime.getOrchestrationDb(),
          runtime,
          group: params.group,
          inputId: params.input,
          routed
        }).then((completion) => completion.decision)
      })
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.entryRoutingTest',
    permission: 'workspace',
    params: EntryRoutingTestParams,
    requires: ['accounts'],
    access: { kind: 'localOnly', targets: {} },
    handler: (params, ctx) => {
      requireEntryOperator(ctx)
      return testEntryRouting(params, ctx.runtime)
    }
  })
]

type EntryAutoRouteInput = z.infer<typeof EntryAutoRouteParams>

const inFlightEntryRoutes = new Map<string, Promise<EntryRouteOutcome>>()

async function runEntryRoute(
  params: EntryAutoRouteInput,
  ctx: RpcContext
): Promise<EntryRouteOutcome> {
  const { runtime } = ctx
  const db = runtime.getOrchestrationDb()
  const run = entryRunOfInput(db, params.group, params.input)
  // 旧 wire 形状（扁平 intent_agent / custom / decisions 两块式）在加载与 RPC 边界统一归一化为
  // Agent 单次路由的 agent-only 形状。
  const decisionModel = normalizeDecisionModelSettings(params.decisionModel)
  // The decision baseline proposes agents only from the project's installed pool; a
  // placement probe failure leaves them unassigned instead of failing the route.
  const executorCapabilities = await entryPlacement(runtime, params.group)
    .then((placement) => placement.agents)
    .catch(() => [])
  // 状态查询的"回答"（§5.1 确定性模板）：进展摘要由运行时生成，随上下文给 provider。
  const statusDigest = entryStatusDigest(db, run.id)
  // Agent 单次路由（统一动作协议 v1）：一次 Agent 调用产出动作批，Orca 裁决登记。
  // 决定落库即未授权（与决定同一 SAVEPOINT）：中断只会留下「已登记且未授权」的自洽状态。
  const decision = await autoRouteUnifiedAgentFromEntry(
    db,
    runtime,
    { input: params.input, decisionModel },
    run,
    executorCapabilities,
    statusDigest
  )
  if (!decision.routed && decision.reason) {
    recordEntryRoutingError(db, params.input, decision.reason)
  }
  if (!decision.routed) {
    return { decision, run }
  }
  // 重放 false：已授权的输入不受影响（迟到的 false 不得撤销授权）；旧中断产物/旧账本的
  // 无授权语义决定补写派发保持——轮询保持零派发。
  if (!params.dispatch && decision.reused) {
    db.ensureRoutingDispatchHold(params.input)
  }
  return { decision, run }
}
