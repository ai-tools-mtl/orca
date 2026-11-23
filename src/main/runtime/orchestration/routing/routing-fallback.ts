import type { OrchestrationDb } from '../db/orchestration-db'
import type { RoutingSubActionRow } from '../db/routing-records'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'

/** §执行失败兜底：解绑失败任务并把派发目标钉成兜底 agent（目标一次定死，同 write-handoff；
 *  agent_hint 同步改写让后续泵 pass 与排队重派都按新目标走）。守卫 task_id 非空 + 兜底未
 *  消费；fallback_agent 落行即消费，二次失败不再自动重派。 */
export function markRoutingSubActionFallback(
  this: OrchestrationDb,
  subActionId: string,
  fallbackAgent: TuiAgent
): RoutingSubActionRow | undefined {
  const rebound = this.db
    .prepare(
      `UPDATE routing_sub_actions
       SET task_id = NULL, agent_hint = ?, fallback_agent = ?, claim_version = claim_version + 1
       WHERE sub_action_id = ? AND task_id IS NOT NULL AND fallback_agent IS NULL`
    )
    .run(fallbackAgent, fallbackAgent, subActionId)
  if (rebound.changes === 0) {
    return undefined
  }
  return this.getSubAction(subActionId)
}

/** §执行失败兜底的僵尸证据：结构化 worker turn 被限流终结时落一张 chaterr 升级邮件
 *  （payload 带 dispatchId/agent/failureKind）。调度 worker 会话不落 chat journal——这封
 *  邮件是账本内唯一稳定的限流证据；返回实际撞限流的 agent id。 */
export function usageLimitEscalationAgentOf(
  this: OrchestrationDb,
  dispatchId: string
): string | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetch reads exactly { agent: string | null }.
  const row = this.db
    .prepare(
      `SELECT json_extract(payload, '$.agent') AS agent FROM messages
       WHERE json_valid(payload)
         AND json_extract(payload, '$.dispatchId') = ?
         AND json_extract(payload, '$.failureKind') = 'usageLimitReached'
       ORDER BY sequence DESC LIMIT 1`
    )
    .get(dispatchId) as { agent: string | null } | undefined
  return row?.agent && isTuiAgent(row.agent) ? row.agent : undefined
}

/** §执行失败兜底的续接随迁：旧任务被兜底重派替换后，其它输入绑在旧任务上的续接行改指
 *  新任务（卡片跟住活工作）。已拒收的投递记录保持史实，不随迁重投。 */
export function rebindRoutingTaskBindings(
  this: OrchestrationDb,
  fromTaskId: string,
  toTaskId: string
): void {
  this.db
    .prepare(
      'UPDATE routing_sub_actions SET task_id = ? WHERE task_id = ? AND entry_deleted_at IS NULL'
    )
    .run(toTaskId, fromTaskId)
}

/** 手动重指派（§执行失败兜底的人工位）：解绑失败/僵尸任务的绑定并把派发目标钉成用户所选
 *  agent。不消费 fallback_agent——手动指派再失败时，自动兜底仍可按链接管一次。 */
export function reassignRoutingSubAction(
  this: OrchestrationDb,
  subActionId: string,
  agent: TuiAgent
): RoutingSubActionRow | undefined {
  const rebound = this.db
    .prepare(
      `UPDATE routing_sub_actions
       SET task_id = NULL, agent_hint = ?, claim_version = claim_version + 1
       WHERE sub_action_id = ? AND task_id IS NOT NULL`
    )
    .run(agent, subActionId)
  if (rebound.changes === 0) {
    return undefined
  }
  return this.getSubAction(subActionId)
}

/** Run 内的 usage-limit 僵尸 dispatch 清单（§执行失败兜底）：dispatch 停在 dispatched、
 *  worker idle（ready）、账本有限流升级邮件。不联 routing_sub_actions——被解绑的孤儿僵尸
 *  （原行已被手动重指派/兜底换人）也要被找到并结算，否则它永远占住链工作树，
 *  `folderWorkerOccupied` 会把所有重派静默挡在门外。 */
export function usageLimitZombiesOfRun(
  this: OrchestrationDb,
  runId: string
): { dispatch_id: string; task_id: string; agent: string | null; error: string | null }[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetch reads exactly the zombie projection.
  return this.db
    .prepare(
      `SELECT d.id AS dispatch_id, d.task_id AS task_id,
              json_extract(m.payload, '$.agent') AS agent,
              json_extract(m.payload, '$.error') AS error
       FROM dispatch_contexts d
       JOIN worker_dispatches w ON w.dispatch_id = d.id
       JOIN messages m ON json_valid(m.payload)
         AND json_extract(m.payload, '$.dispatchId') = d.id
         AND json_extract(m.payload, '$.failureKind') = 'usageLimitReached'
       WHERE d.run_id = ? AND d.status = 'dispatched' AND w.state = 'ready'
       GROUP BY d.id`
    )
    .all(runId) as {
    dispatch_id: string
    task_id: string
    agent: string | null
    error: string | null
  }[]
}

/** §换 agent 重派指令的适用判定：目标任务已结算失败，或处于 usage-limit 僵尸形态
 *  （task/dispatch 停在 dispatched、worker idle、账本有限流升级邮件）。裁决层用同步判定
 *  把"更换 agent 后继续"降级为对原行的重派，而不是往终局会话投 steer。 */
export function redispatchDirectiveApplies(this: OrchestrationDb, taskId: string): boolean {
  const task = this.getTask(taskId)
  if (!task) {
    return false
  }
  if (task.status === 'failed') {
    return true
  }
  if (task.status !== 'dispatched') {
    return false
  }
  const dispatch = this.getDispatchContext(taskId)
  if (!dispatch || dispatch.status !== 'dispatched') {
    return false
  }
  if (this.getWorkerDispatch(dispatch.id)?.state !== 'ready') {
    return false
  }
  return this.usageLimitEscalationAgentOf(dispatch.id) !== undefined
}

/** §换 agent 重派指令的裁决目标：目标任务绑定的原阶段行（仍绑在该任务上）；merge 行没有
 *  worker，不适用。 */
export function redispatchDirectiveRowOf(
  this: OrchestrationDb,
  taskId: string
): RoutingSubActionRow | undefined {
  const row = this.getRoutingSubActionByTask(taskId)
  return row && row.task_id === taskId && row.stage_kind && row.stage_kind !== 'merge'
    ? row
    : undefined
}

/** §换 agent 重派指令的落账：解绑终局/僵尸任务并留 handback（旧→新任务的跟随映射）、
 *  钉 agent（null = 不改 hint 交给泵挑）、指令文本并进约束（重派 worker 的 spec 组装会
 *  带上）。幂等：只在行仍绑着目标任务时解绑。 */
export function applyRedispatchDirective(
  this: OrchestrationDb,
  row: RoutingSubActionRow,
  agent: TuiAgent | null,
  instruction: string
): void {
  if (row.claimed_dispatch_id) {
    this.handbackSubAction({
      subActionId: row.sub_action_id,
      fromDispatchId: row.claimed_dispatch_id,
      reason: `routing redispatch directive${agent ? ` (${agent})` : ''}`
    })
  }
  this.db
    .prepare(
      `UPDATE routing_sub_actions
       SET task_id = NULL, claim_version = claim_version + 1, agent_hint = COALESCE(?, agent_hint)
       WHERE sub_action_id = ? AND task_id = ?`
    )
    .run(agent, row.sub_action_id, row.task_id)
  const capped = instruction.trim().slice(0, 300)
  if (capped && !row.constraints_json.includes(capped)) {
    let constraints: unknown = []
    try {
      constraints = JSON.parse(row.constraints_json)
    } catch {
      constraints = []
    }
    const next = [...(Array.isArray(constraints) ? constraints : []), capped]
    this.db
      .prepare('UPDATE routing_sub_actions SET constraints_json = ? WHERE sub_action_id = ?')
      .run(JSON.stringify(next), row.sub_action_id)
  }
}

/** 晚到的续接跟随兜底重派：查旧任务是否被兜底/指令换人过（handback 记录旧 dispatch→行→
 *  新任务），返回新任务 id。没有兜底痕迹的旧任务返回 undefined（正常完成/失败不走跟随）。 */
export function fallbackRedispatchTargetOfTask(
  this: OrchestrationDb,
  oldTaskId: string
): string | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetch reads exactly { new_task_id: string | null }.
  const row = this.db
    .prepare(
      `SELECT sa.task_id AS new_task_id FROM routing_sub_action_handbacks hb
       JOIN dispatch_contexts d ON d.id = hb.handed_back_from
       JOIN routing_sub_actions sa ON sa.sub_action_id = hb.sub_action_id
       WHERE d.task_id = ? AND sa.task_id IS NOT NULL AND sa.task_id != ?
       ORDER BY hb.created_at DESC, hb.rowid DESC LIMIT 1`
    )
    .get(oldTaskId, oldTaskId) as { new_task_id: string | null } | undefined
  return row?.new_task_id ?? undefined
}

/** 旧任务是否留有换人 handback（兜底/指令重派）——跟随分支区分「还没换人」与「换了但
 *  新任务未落账」用：后者记 paused 拒收保持可重投。 */
export function hasRedispatchHandbackOfTask(this: OrchestrationDb, oldTaskId: string): boolean {
  return (
    this.db
      .prepare(
        `SELECT 1 FROM routing_sub_action_handbacks hb
         JOIN dispatch_contexts d ON d.id = hb.handed_back_from
         WHERE d.task_id = ? LIMIT 1`
      )
      .get(oldTaskId) !== undefined
  )
}

/** 续接投递跟随兜底重派时的补充重指目标：原 dispatch 已终局，投递改指新 dispatch。 */
export function retargetRoutingSupplement(
  this: OrchestrationDb,
  supplementId: string,
  toDispatchId: string
): void {
  this.db
    .prepare('UPDATE routing_supplements SET target_dispatch_id = ? WHERE supplement_id = ?')
    .run(toDispatchId, supplementId)
}

export type RoutingFallbackMethods = {
  markRoutingSubActionFallback: typeof markRoutingSubActionFallback
  reassignRoutingSubAction: typeof reassignRoutingSubAction
  rebindRoutingTaskBindings: typeof rebindRoutingTaskBindings
  usageLimitEscalationAgentOf: typeof usageLimitEscalationAgentOf
  usageLimitZombiesOfRun: typeof usageLimitZombiesOfRun
  redispatchDirectiveApplies: typeof redispatchDirectiveApplies
  redispatchDirectiveRowOf: typeof redispatchDirectiveRowOf
  applyRedispatchDirective: typeof applyRedispatchDirective
  fallbackRedispatchTargetOfTask: typeof fallbackRedispatchTargetOfTask
  hasRedispatchHandbackOfTask: typeof hasRedispatchHandbackOfTask
  retargetRoutingSupplement: typeof retargetRoutingSupplement
}

export function attachRoutingFallback(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    markRoutingSubActionFallback,
    reassignRoutingSubAction,
    rebindRoutingTaskBindings,
    usageLimitEscalationAgentOf,
    usageLimitZombiesOfRun,
    redispatchDirectiveApplies,
    redispatchDirectiveRowOf,
    applyRedispatchDirective,
    fallbackRedispatchTargetOfTask,
    hasRedispatchHandbackOfTask,
    retargetRoutingSupplement
  })
}
