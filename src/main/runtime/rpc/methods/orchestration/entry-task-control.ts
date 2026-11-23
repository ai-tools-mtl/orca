import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import type { RoutingSubActionRow } from '../../../orchestration/db/routing-records'
import { structuredMailboxCustody } from '../../../orchestration/mailbox/routing/structured-session-mail-target'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { computeAgentSessionPayloadFingerprint } from '../../../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'

// 控制行（§直接操作会话）：暂停/停止类请求不向 worker 会话投递文本，而是走聊天「停止」的
// 同一通道（agentSession.cancel）直接中断目标执行，随后结算账本——目标任务按用户指令中断
// 落账（dispatch/task 终态）并暂停原行（卡片离开「执行中」），控制行落 processed。

const ENTRY_CONTROL_CALLER_KEY = 'orchestration-entry-control'

/** 结算文案：进 dispatch.last_failure / task.result，卡片在「已暂停」下的失败行展示。 */
const INTERRUPTED_RESULT_NOTE = '已按用户指令暂停，执行被中断。'

/** 目标任务的原始行（§5.2 持有 claim 的那一行）：暂停标记落在它上面，卡片才离开执行中。 */
function interruptTargetRow(db: OrchestrationDb, taskId: string): RoutingSubActionRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return db.db
    .prepare(
      'SELECT * FROM routing_sub_actions WHERE task_id = ? AND claimed_dispatch_id IS NOT NULL AND entry_deleted_at IS NULL ORDER BY rowid LIMIT 1'
    )
    .get(taskId) as RoutingSubActionRow | undefined
}

function recordControlError(
  db: OrchestrationDb,
  action: RoutingSubActionRow,
  reason: string
): void {
  db.db
    .prepare('UPDATE routing_sub_actions SET entry_error = ? WHERE sub_action_id = ?')
    .run(reason, action.sub_action_id)
}

/** 目标会话身份：优先派发落账的 assignee，其次结构化托管（mail custody）解析。active 派发
 *  两者皆无 = 该派发不是本机可操作的结构化会话（终态返回 undefined，无会话可中断）。 */
function entryControlSessionOf(
  db: OrchestrationDb,
  dispatchId: string
): { sessionId: string } | 'unsupported' | undefined {
  const dispatch = db.getDispatchContextById(dispatchId)
  if (dispatch?.assignee_orca_session_id) {
    return { sessionId: dispatch.assignee_orca_session_id }
  }
  const custody = structuredMailboxCustody(`dispatch:${dispatchId}`, db)
  if (typeof custody === 'object' && custody.dispatchId === dispatchId) {
    return { sessionId: custody.sessionId }
  }
  return dispatch?.status === 'pending' || dispatch?.status === 'dispatched'
    ? 'unsupported'
    : undefined
}

/** 会话当前是否有活跃轮次；读取失败按「无法证明」处理（返回 undefined）。 */
async function activeTurnOf(
  host: NonNullable<ReturnType<typeof getStructuredAgentSessionHost>>,
  sessionId: string
): Promise<string | undefined> {
  try {
    return (await host.currentWorkAtRest(sessionId))?.activeTurnId() ?? undefined
  } catch {
    return undefined
  }
}

export async function dispatchEntryControlSubAction(
  db: OrchestrationDb,
  action: RoutingSubActionRow
): Promise<void> {
  if (
    action.control_kind !== 'interrupt' ||
    action.state === 'processed' ||
    action.entry_error ||
    !action.task_id
  ) {
    return
  }
  const taskId = action.task_id
  const dispatch = db.getDispatchContext(taskId)
  const dispatchId = dispatch?.run_id === action.run_id ? dispatch.id : undefined
  if (dispatchId) {
    const session = entryControlSessionOf(db, dispatchId)
    if (session === 'unsupported') {
      recordControlError(
        db,
        action,
        '该任务不在本机结构化会话里运行，无法直接中断；请在任务会话里手动停止。'
      )
      return
    }
    if (session) {
      const host = getStructuredAgentSessionHost()
      // 宿主未就绪/读取失败：不落错误，泵下一轮重试。
      if (!host) {
        return
      }
      if (await activeTurnOf(host, session.sessionId)) {
        const fence = host.deps.store.getConversation(session.sessionId)?.currentFence ?? null
        let cancelled: boolean | undefined
        try {
          const outcome = await host.cancel(
            { callerKey: ENTRY_CONTROL_CALLER_KEY },
            {
              envelope: {
                sessionId: session.sessionId,
                clientOperationId: `entryctrl_${action.sub_action_id}`,
                expectedRuntimeFence: fence,
                payloadFingerprint: computeAgentSessionPayloadFingerprint({
                  method: 'agentSession.cancel',
                  sessionId: session.sessionId,
                  fields: {}
                })
              }
            }
          )
          cancelled = outcome.ok ? outcome.value.cancelled : undefined
        } catch {
          cancelled = undefined
        }
        if (cancelled !== true) {
          // false 只可能是重放已接受的停止或目标本就不在跑；仍有活跃轮次才是真失败。
          if (await activeTurnOf(host, session.sessionId)) {
            recordControlError(
              db,
              action,
              '中断未被会话确认，执行可能仍在进行；请在任务会话里手动停止。'
            )
            return
          }
        }
      }
    }
  }
  db.setSubActionState(action.sub_action_id, 'delivered')
  const target = interruptTargetRow(db, taskId)
  if (target && target.sub_action_id !== action.sub_action_id && target.paused_at === null) {
    db.pauseRoutingSubAction(target.sub_action_id)
  }
  if (dispatchId) {
    db.settleWorkerReport({
      taskId,
      dispatchId,
      outcome: 'failed',
      result: INTERRUPTED_RESULT_NOTE
    })
  }
  db.setSubActionState(action.sub_action_id, 'processed')
}
