import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import {
  ROUTE_PROPOSAL_VERSION,
  parseRouteProposal,
  type RouteProposalV1
} from '../../../orchestration/routing/route-proposal'
import {
  deletedRoutingTasks,
  planningTemplateSubActions,
  type RoutingDecisionContext,
  type RoutingDecisionProposal
} from '../../../orchestration/routing/routing-router'
import { applyRedispatchDirectiveFromRouting } from './entry-failed-stage-fallback'
import { entryTaskStatusAnswer } from './entry-results'

// 统一路由动作批的裁决（Orca 侧，协议 v1）：从实际送出的候选快照校验任务引用，从账本生成
// 状态答案，把 create_task/continue_task/control_task 落成子动作、clarify 落成待澄清项、
// reply 落成会话回复、无效目标只挂起相关动作。来源校验与授权由调用方（entry-unified-route）
// 处理，派发走入口的共享尾部。

export type RouteQueryOutcome = { key: string; target: string; answer: string }
export type RouteReplyOutcome = { key: string; text: string }
export type RouteClarificationItem = {
  key: string
  question: string
  taskId?: string
  about?: string
}

/** 执行前复核任务在当前项目的归属与可用状态：路由可能在候选快照生成后失效（软删除/归属
 *  变化）——快照只证明发送当时的资格，登记与派发以账本现状为准。 */
function routeTargetInvalidated(db: OrchestrationDb, runId: string, taskId: string): boolean {
  const task = db.getTask(taskId)
  if (!task || task.run_id !== runId) {
    return true
  }
  return deletedRoutingTasks(db, runId).has(taskId)
}

/** 同一请求可同时产生查询结果、会话回复和工作动作：查询答案与待澄清项进决定（decision_json）
 * 与 reason，会话回复（reply 动作）进 decision.replies，工作动作照常登记。目标越界的查询/
 * 续接只降级为该动作的待澄清——独立且有效的其他动作不受影响。规划模板的阶段行必须排在
 * 子动作数组最前（模板内部 dependsOn 是相对序号）。 */
export function adjudicateRouteProposal(
  db: OrchestrationDb,
  runId: string,
  rawProposal: RouteProposalV1,
  context: RoutingDecisionContext
): RoutingDecisionProposal {
  // 结构门在裁决入口重过一遍：版本未知、重复键、no_action 不单独出现等结构性错误在登记前
  // 拒绝（provider 解析之外的第二道防线——任何来源的提案都不绕过）。
  const proposal = parseRouteProposal(rawProposal)
  const candidates = new Map(context.candidateTasks.map((task) => [task.taskId, task]))
  const queries: RouteQueryOutcome[] = []
  const replies: RouteReplyOutcome[] = []
  const clarifications: RouteClarificationItem[] = []
  const subActions: RoutingDecisionProposal['subActions'] = []
  let noActionReason: string | undefined
  // 复合请求可含多个 planning 动作（§任务拆解）：每个动作各自展开阶段链并保留自包含
  // 指令，链与链之间互不合并——单变量会静默丢弃前面的规划请求。
  const planningRequests: { instruction: string; prototype: boolean; clarification: boolean }[] = []
  for (const action of proposal.actions) {
    switch (action.type) {
      case 'query_status': {
        if (action.target === 'project') {
          queries.push({
            key: action.key,
            target: 'project',
            answer: context.statusDigest ?? '当前没有进行中的任务记录。'
          })
        } else if (!candidates.has(action.target)) {
          clarifications.push({
            key: action.key,
            question:
              '要查询的任务无法在当前项目里定位。请指明要查询的任务，或查看各任务卡片的进展。',
            about: 'query_status'
          })
        } else if (routeTargetInvalidated(db, runId, action.target)) {
          // 快照内但路由期间失效：该查询进入待澄清，同批其他动作不受影响。
          clarifications.push({
            key: action.key,
            question:
              '要查询的任务已失效或不在当前项目里。请指明要查询的任务，或查看各任务卡片的进展。',
            about: 'query_status'
          })
        } else {
          const answer =
            entryTaskStatusAnswer(db, runId, action.target) ??
            `「${candidates.get(action.target)?.spec ?? action.target}」：尚无进展记录。`
          queries.push({ key: action.key, target: action.target, answer })
        }
        break
      }
      case 'continue_task': {
        // 执行前复核：越界/失效目标只降级为待澄清；可续接要求任务在本 Run 里有可接收的派发。
        if (!candidates.has(action.taskId)) {
          clarifications.push({
            key: action.key,
            question: '要续接的任务无法在当前项目里定位。请指明要续接的任务。',
            about: 'continue_task'
          })
        } else if (routeTargetInvalidated(db, runId, action.taskId)) {
          clarifications.push({
            key: action.key,
            question: '要续接的任务已失效或不在当前项目里。请指明要续接的任务。',
            about: 'continue_task'
          })
        } else {
          const dispatch = db.getDispatchContext(action.taskId)
          if (dispatch && dispatch.run_id === runId) {
            // 换 agent 重派指令（§执行失败兜底）：目标终局/僵尸时降级为对原行的重派。
            applyRedispatchDirectiveFromRouting(db, action.taskId, action.agent, action.instruction)
            subActions.push({ text: action.instruction, taskId: action.taskId })
          } else {
            clarifications.push({
              key: action.key,
              question:
                '要续接的任务当前没有进行中的会话。请改用新任务提交，或等任务恢复后再续接。',
              about: 'continue_task'
            })
          }
        }
        break
      }
      case 'control_task': {
        // 控制动作（§直接操作会话）：与续接同样的执行前复核；落账为控制行，派发时中断目标
        // 会话而不是投递补充。
        if (!candidates.has(action.taskId)) {
          clarifications.push({
            key: action.key,
            question: '要暂停的任务无法在当前项目里定位。请指明要暂停的任务。',
            about: 'control_task'
          })
        } else if (routeTargetInvalidated(db, runId, action.taskId)) {
          clarifications.push({
            key: action.key,
            question: '要暂停的任务已失效或不在当前项目里。请指明要暂停的任务。',
            about: 'control_task'
          })
        } else {
          const dispatch = db.getDispatchContext(action.taskId)
          if (dispatch && dispatch.run_id === runId) {
            subActions.push({
              text: `暂停任务：${action.reason ?? '中断当前执行'}`,
              taskId: action.taskId,
              controlKind: 'interrupt'
            })
          } else {
            clarifications.push({
              key: action.key,
              question: '要暂停的任务当前没有进行中的会话，无需暂停。',
              about: 'control_task'
            })
          }
        }
        break
      }
      case 'create_task': {
        if (action.planning === true) {
          planningRequests.push({
            instruction: action.instruction,
            prototype: action.prototype === true,
            clarification: action.clarification !== false
          })
        } else {
          subActions.push({
            text: action.instruction,
            ...(action.agent ? { agent: action.agent } : {})
          })
        }
        break
      }
      case 'clarify': {
        clarifications.push({
          key: action.key,
          question: action.question,
          ...(action.taskId && candidates.has(action.taskId) ? { taskId: action.taskId } : {}),
          ...(action.about ? { about: action.about } : {})
        })
        break
      }
      case 'no_action': {
        noActionReason = action.reason
        break
      }
      case 'reply': {
        replies.push({ key: action.key, text: action.text })
        break
      }
    }
  }
  const reason = [
    noActionReason,
    ...queries.map((query) =>
      query.target === 'project' ? `项目进展：${query.answer}` : `当前进展：${query.answer}`
    ),
    ...clarifications.map((item) => `待澄清：${item.question}`)
  ]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join('\n')
  // 每个规划动作各自展开阶段链（自包含指令即该链的需求原文）；模板的 dependsOn 是链内
  // 相对序号，拼入同一批次时按「该链起始行号」偏移，链与链的依赖各自闭合、互不串链。
  const planningStages: RoutingDecisionProposal['subActions'] = []
  let chainOffset = 0
  for (const request of planningRequests) {
    const chain = planningTemplateSubActions(
      request.instruction,
      request.prototype,
      request.clarification,
      context.executorCapabilities
    )
    for (const stage of chain) {
      if (stage.dependsOn) {
        stage.dependsOn = stage.dependsOn.map((edge) =>
          typeof edge === 'number' ? edge + chainOffset : edge
        )
      }
      planningStages.push(stage)
    }
    chainOffset += chain.length
  }
  const subActionBatch = [...planningStages, ...subActions]
  // 零子动作提案必须带 reason（routeRoutingInput 结构不变量）：reply-only 的会话回复兜底充当。
  const replyFallback = replies.map((reply) => reply.text).join('\n')
  const effectiveReason = reason || (subActionBatch.length === 0 ? replyFallback : '')
  return {
    subActions: subActionBatch,
    ...(effectiveReason ? { reason: effectiveReason } : {}),
    decision: {
      strategy: 'unified_agent',
      protocolVersion: ROUTE_PROPOSAL_VERSION,
      queries,
      replies,
      clarifications,
      actionTypes: proposal.actions.map((action) => action.type),
      // 实际发送的候选快照原样留存（含 spec/status）——回放与审计都以它为准。
      candidateSnapshot: context.candidateTasks
    }
  }
}
