import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import type {
  RoutingInputRow,
  RoutingSubActionRow
} from '../../../orchestration/db/routing-records'
import {
  routingInputDispatchAuthorized,
  routingInputDispatchHold
} from '../../../orchestration/routing/dispatch-authorization'
import { deliverRecordedSupplement } from '../../../orchestration/routing/targeted-supplement-delivery'
import { routingInputsPayload } from './routing-supplements'

/** 决定里的续接行：taskReferences[seq-1] 非空 = 该子动作是续接（绑定目标任务）。 */
export function taskReferenceRows(db: OrchestrationDb, inputId: string): RoutingSubActionRow[] {
  const raw = db.getRoutingInput(inputId)?.decision_json
  const decision: unknown = raw ? JSON.parse(raw) : null
  const references =
    decision &&
    typeof decision === 'object' &&
    'taskReferences' in decision &&
    Array.isArray(decision.taskReferences)
      ? decision.taskReferences
      : []
  return db
    .listSubActions(inputId)
    .filter((action) => action.task_id && references[action.seq - 1] === action.task_id)
}

/** 向续接行的目标任务登记一次投递并投出；任务在当前 Run 里没有可接收的派发时保持未登记。 */
async function deliverTaskReference(
  db: OrchestrationDb,
  inputId: string,
  action: RoutingSubActionRow
): Promise<void> {
  const dispatch = db.getDispatchContext(action.task_id!)
  if (!dispatch || dispatch.run_id !== action.run_id) {
    return
  }
  const supplement = db.recordRoutingSupplement({
    inputId,
    subActionId: action.sub_action_id,
    targetDispatchId: dispatch.id,
    text: action.text
  })
  await deliverRecordedSupplement(db, supplement)
}

export async function dispatchEntryTaskReferences(
  db: OrchestrationDb,
  inputId: string
): Promise<void> {
  for (const action of taskReferenceRows(db, inputId)) {
    const existing = db.listSupplements(action.sub_action_id)[0]
    if (existing) {
      // 显式 dispatch=true 的重放复用原投递记录再请求一次投递。
      await deliverRecordedSupplement(db, existing)
      continue
    }
    await deliverTaskReference(db, inputId, action)
  }
}

/** 恢复路径的持久化授权门（§派发授权）：只有 dispatchAuthorized 已写（或旧账本无任何
 *  授权键的「决定即意图」行，v61 已回填）才允许投递；带派发保持（dispatch=false /
 *  中断产物 / 手动规划）的输入零尝试。 */
function authorizedInputOf(db: OrchestrationDb, inputId: string): RoutingInputRow | undefined {
  const row = db.getRoutingInput(inputId)
  if (!row || routingInputDispatchHold(row) || !routingInputDispatchAuthorized(row)) {
    return undefined
  }
  return row
}

/** 恢复已授权但投递未落定的续接（§重放与恢复），按三个可证明的状态推进：
 *  - 尚无补充记录：登记一次投递并投出（原动作、原目标）；
 *  - 已有补充但零投递尝试（登记后、尝试前中断）：复用原补充记录和原目标 Dispatch 补投，
 *    不可接收的会话由投递入口记录明确拒收；
 *  - 已有投递尝试：一律不动——已送达/结果未知复用原记录（结果未知保持待核对，绝不向新
 *    轮次重发），paused 拒收的重投走 entryResume。
 *  重复轮询、重启或显式重放都只复用记录，不登记第二份补充。 */
export async function resumeEntryUndeliveredTaskReferences(
  db: OrchestrationDb,
  inputId: string
): Promise<void> {
  if (!authorizedInputOf(db, inputId)) {
    return
  }
  for (const action of taskReferenceRows(db, inputId)) {
    const existing = db.listSupplements(action.sub_action_id)[0]
    if (existing) {
      if (db.listSupplementAttempts(existing.supplement_id).length === 0) {
        await deliverRecordedSupplement(db, existing)
      }
      continue
    }
    await deliverTaskReference(db, inputId, action)
  }
}

export async function resumeEntrySupplements(db: OrchestrationDb, runId: string): Promise<void> {
  for (const { input, subActions } of routingInputsPayload(db, runId).inputs) {
    // 路由生成的续接需要持久化授权才能恢复投递（§派发授权）：
    // dispatchAuthorized 缺失 = 路由续接未经授权，即使 paused 也不投。
    const authorized = routingInputDispatchAuthorized(input)
    const routeGeneratedIds = new Set(
      taskReferenceRows(db, input.input_id).map((r) => r.sub_action_id)
    )
    for (const { subAction, deliveries } of subActions) {
      if (routeGeneratedIds.has(subAction.sub_action_id) && !authorized) {
        continue
      }
      for (const { supplement, attempts } of deliveries) {
        const last = attempts.at(-1)
        if (last && last.refusal_kind === 'paused') {
          await deliverRecordedSupplement(db, supplement)
        }
      }
    }
  }
}

/** 恢复单张 paused 任务卡（§5.5）：只重投该子动作上保持 paused 的补充。授权规则与项目恢复
 *  一致——只有路由生成的续接行（taskReferences 绑定）要求整条输入已持久化授权；手动补充
 *  的暂停/恢复由用户管理，不问路由授权。目标与轮次校验由投递入口保持。 */
export async function resumeEntrySupplementsForSubAction(
  db: OrchestrationDb,
  subActionId: string
): Promise<void> {
  const subAction = db.getSubAction(subActionId)
  if (!subAction) {
    return
  }
  // 路由生成的续接需要持久化授权才能恢复投递（§派发授权）；手动补充不经路由授权。
  const routeGenerated = taskReferenceRows(db, subAction.input_id).some(
    (row) => row.sub_action_id === subActionId
  )
  if (routeGenerated && !authorizedInputOf(db, subAction.input_id)) {
    return
  }
  for (const supplement of db.listSupplements(subActionId)) {
    const last = db.listSupplementAttempts(supplement.supplement_id).at(-1)
    if (last && last.refusal_kind === 'paused') {
      await deliverRecordedSupplement(db, supplement)
    }
  }
}
