import { recordEntryAssignmentError } from './entry-assignment-errors'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { RunRow } from '../../../orchestration/db/orchestration-records'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import type { RoutingSubActionRow } from '../../../orchestration/db/routing-records'
import { routingInputDispatchAuthorized } from '../../../orchestration/routing/dispatch-authorization'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import { pickTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-selection'
import { entrySubActionNeedsReadOnly } from '../../../orchestration/routing/entry-write-policy'
import { entryPlacement } from './entry-placement'
import { structuredMailboxCustody } from '../../../orchestration/mailbox/routing/structured-session-mail-target'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { dispatchEntrySubAction } from './entry-dispatch'

type EntryDispatchSubAction = typeof dispatchEntrySubAction

/** 执行失败兜底（§能力分工）：指定的 agent 执行失败（usage limit、任务失败、熔断）即该
 *  agent 当前不可用——同一阶段同一 worktree 用兜底 agent（设置默认链排除失败者的下一个可
 *  用者）立即重派一次。fallback_agent 落行即消费，二次失败不再兜底（升级卡照旧）；只读调
 *  查行只可能跑在 codex 上，没有替代 agent，不兜底。 */
export async function pumpFailedStages(
  args: { runtime: OrcaRuntimeService; run: RunRow; group: string },
  dispatchSubAction: EntryDispatchSubAction
): Promise<void> {
  const { runtime, run, group } = args
  const db = runtime.getOrchestrationDb()
  if (db.isRoutingRunPaused(run.id)) {
    return
  }
  const failed: {
    action: RoutingSubActionRow
    failedAgent: string | undefined
    oldTaskId: string
  }[] = []
  for (const input of db.listRunRoutingInputs(run.id)) {
    // 兜底重派与首派同一授权语义：只有已授权输入的失败阶段自动重派。
    if (!routingInputDispatchAuthorized(input)) {
      continue
    }
    for (const action of db.listSubActions(input.input_id)) {
      if (!action.stage_kind || !action.task_id || action.paused_at || action.fallback_agent) {
        continue
      }
      if (entrySubActionNeedsReadOnly(db, action)) {
        continue
      }
      const taskId = action.task_id
      if (db.getTask(taskId)?.status === 'failed') {
        failed.push({
          action,
          failedAgent:
            action.agent_hint && isTuiAgent(action.agent_hint) ? action.agent_hint : undefined,
          oldTaskId: taskId
        })
        continue
      }
      const zombie = await usageLimitZombieAgent(db, taskId)
      if (zombie) {
        failed.push({ action, failedAgent: zombie, oldTaskId: taskId })
      }
    }
  }
  if (failed.length === 0) {
    return
  }
  const placement = await entryPlacement(runtime, group).catch(() => undefined)
  if (!placement) {
    return
  }
  const settings = runtime.requireStore().getSettings()
  for (const { action, failedAgent, oldTaskId } of failed) {
    // 与设置页"默认 · 自动"同源的兜底链，排除失败者后取下一个可用者。
    const fallback = pickTuiAgent(
      settings.defaultTuiAgent,
      placement.agents.filter((candidate) => candidate !== failedAgent),
      settings.disabledTuiAgents
    )
    if (!fallback) {
      continue
    }
    try {
      if (action.claimed_dispatch_id) {
        const handback = db.handbackSubAction({
          subActionId: action.sub_action_id,
          fromDispatchId: action.claimed_dispatch_id,
          reason: `worker failed (${failedAgent ?? 'unknown agent'}); retrying with ${fallback}`
        })
        if (!handback.released) {
          continue
        }
      }
      const rebound = db.markRoutingSubActionFallback(action.sub_action_id, fallback)
      if (!rebound) {
        continue
      }
      await dispatchSubAction({
        runtime,
        run,
        group,
        inputId: action.input_id,
        subActionId: action.sub_action_id,
        agent: fallback,
        placement
      })
      // 续接行随迁：其它输入绑在旧任务上的续接（用户"换 agent 继续"的显式请求）改指新
      // 任务，卡片跟住活工作；其已拒收的投递记录保持史实，不再重投（指令已由重派兑现）。
      const newTaskId = db.getSubAction(action.sub_action_id)?.task_id
      if (newTaskId && newTaskId !== oldTaskId) {
        db.rebindRoutingTaskBindings(oldTaskId, newTaskId)
      }
    } catch (error) {
      recordEntryAssignmentError(db, action.input_id, action.sub_action_id, error)
    }
  }
}

/** 裁决层的换 agent 重派指令降级（§执行失败兜底）：目标任务终局/僵尸时，"更换 agent 后
 *  继续"的续接永远无法 steer——转换为对原阶段行的重派（解绑、钉 agent、指令并进约束），
 *  由泵重派；指令行仍登记绑旧任务，投递经跟随改指新 worker。 */
export function applyRedispatchDirectiveFromRouting(
  db: OrchestrationDb,
  taskId: string,
  agent: string | undefined,
  instruction: string
): void {
  if (!db.redispatchDirectiveApplies(taskId)) {
    return
  }
  const original = db.redispatchDirectiveRowOf(taskId)
  if (original) {
    db.applyRedispatchDirective(original, agent && isTuiAgent(agent) ? agent : null, instruction)
  }
}

/** 僵尸结算（§执行失败兜底）：限流终局的 dispatch 停在 dispatched 会永远占住链工作树
 *  （folderWorkerOccupied），把所有重派/派发静默挡在门外——按账本里的限流升级邮件把它
 *  结算成 failed（最后一次尝试的真实结果），释放工作树让泵重派。孤儿僵尸（原行已被解绑）
 *  也覆盖：扫描在 dispatch 级，不依赖路由行的绑定。 */
export async function pumpZombieSettlements(args: {
  runtime: OrcaRuntimeService
  run: RunRow
}): Promise<void> {
  const { runtime, run } = args
  const db = runtime.getOrchestrationDb()
  if (db.isRoutingRunPaused(run.id)) {
    return
  }
  for (const zombie of db.usageLimitZombiesOfRun(run.id)) {
    if (!zombie.task_id) {
      continue
    }
    try {
      db.settleWorkerReport({
        taskId: zombie.task_id,
        dispatchId: zombie.dispatch_id,
        outcome: 'failed',
        result: `${zombie.agent ?? 'the worker'} hit its usage limit; the attempt is settled so the stage can be re-dispatched.`
      })
    } catch (error) {
      console.warn('[orchestration] failed to settle a usage-limit zombie', {
        dispatchId: zombie.dispatch_id,
        error
      })
    }
  }
}

/** usage-limit 僵尸判定：task/dispatch 都停在 dispatched、worker idle（ready），且账本里有
 *  这条 dispatch 的限流升级邮件（chat-worker-error-escalation 落账，payload.failureKind=
 *  'usageLimitReached'——调度 worker 会话不落 chat journal，这封邮件是唯一稳定的限流证据）。
 *  会话仍有 active turn 时不判僵尸（用户可能已亲自续上 turn）。返回实际撞限流的 agent id
 *  （邮件 payload 的 agent 字段，比行的 agent_hint 更真）。供泵的自动兜底与 entryAssign 的
 *  手动重指派共用。 */
export async function usageLimitZombieAgent(
  db: OrchestrationDb,
  taskId: string
): Promise<string | undefined> {
  const dispatch = db.getDispatchContext(taskId)
  if (!dispatch || dispatch.status !== 'dispatched') {
    return undefined
  }
  if (db.getTask(taskId)?.status !== 'dispatched') {
    return undefined
  }
  if (db.getWorkerDispatch(dispatch.id)?.state !== 'ready') {
    return undefined
  }
  const failedAgent = db.usageLimitEscalationAgentOf(dispatch.id)
  if (!failedAgent) {
    return undefined
  }
  const host = getStructuredAgentSessionHost()
  const custody = structuredMailboxCustody(`dispatch:${dispatch.id}`, db)
  if (host && typeof custody === 'object') {
    try {
      const work = await host.currentWorkAtRest(custody.sessionId)
      if (work?.activeTurnId()) {
        return undefined
      }
    } catch {
      // 会话不可达：turn 终结的账本证据已足够，按僵尸处理。
    }
  }
  return failedAgent
}
