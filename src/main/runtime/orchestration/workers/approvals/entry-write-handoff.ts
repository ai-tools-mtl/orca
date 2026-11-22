import { createHash } from 'node:crypto'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { DispatchContextRow } from '../../db/orchestration-records'
import type { RoutingSubActionRow } from '../../db/routing-records'
import { workerStartOptionsAgent } from '../launch/worker-launch-observation'
import { stopReportId } from '../turn-stops/worker-turn-stop-report'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import { pickTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-selection'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'

/** 方向 2 (entry-stage-pipeline-plan §7): 分流而非一刀切——写前审批的 Allow 在「意图 agent 就是
 *  实际派发的只读 worker」时保持任务接续（原会话获准写入）；只在只读分类强制 codex 顶替了别人
 *  （hint/默认 agent ≠ codex）时，铸 write_granted implement 阶段行交给该 agent 的新 worker
 *  （同 worktree，依赖边 = worktree 绑定 + 上游报告注入）。 */

const HANDOFF_DETAIL_MAX_CHARS = 2_000

function bounded(text: string | null | undefined): string | null {
  const trimmed = text?.trim()
  return trimmed ? trimmed.slice(0, HANDOFF_DETAIL_MAX_CHARS) : null
}

/** One write stage per investigation: a second allowed prompt reuses the minted row. */
function existingHandoffRow(
  db: OrchestrationDb,
  investigation: RoutingSubActionRow
): RoutingSubActionRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return db.db
    .prepare(
      `SELECT * FROM routing_sub_actions
       WHERE input_id = ? AND write_granted_at IS NOT NULL AND depends_on_json = ?
       ORDER BY seq LIMIT 1`
    )
    .get(investigation.input_id, JSON.stringify([investigation.sub_action_id])) as
    | RoutingSubActionRow
    | undefined
}

export function mintEntryWriteHandoff(
  db: OrchestrationDb,
  args: {
    approvalId: string
    investigation: RoutingSubActionRow
    /** The split's resolved target (hint ?? host default): stamped on the row so the approval
     *  card's agent and the pump's dispatch stay the same agent, not two re-derivations. */
    targetAgent: TuiAgent
    /** The approved write's own text, as the worker's prompt stated it (data, not instructions). */
    writeDetail: string | null
  }
): RoutingSubActionRow {
  const { approvalId, investigation, targetAgent } = args
  const existing = existingHandoffRow(db, investigation)
  if (existing) {
    return existing
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the COUNT(*) projection is exactly { seq: number }.
  const num = db.db
    .prepare(
      'SELECT COUNT(*) AS seq FROM routing_inputs WHERE rowid <= (SELECT rowid FROM routing_inputs WHERE input_id = ?)'
    )
    .get(investigation.input_id) as { seq: number }
  const tail = db.db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM routing_sub_actions WHERE input_id = ?')
    .get(investigation.input_id) as { max_seq: number }
  const id = `sa-${num.seq}-h${createHash('sha256').update(approvalId).digest('hex').slice(0, 8)}`
  const granted = `本阶段写入已由写前审批放行（write_granted），在同 worktree 内实施，无需再次申请写入授权。`
  const requirement = bounded(db.getRoutingInput(investigation.input_id)?.raw_text)
  const approved = bounded(args.writeDetail)
  db.db
    .prepare(
      `INSERT INTO routing_sub_actions
         (sub_action_id, input_id, run_id, seq, text, constraints_json, task_id,
          stage_kind, depends_on_json, gate, agent_hint, write_granted_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'implement', ?, 'auto', ?, datetime('now'))`
    )
    .run(
      id,
      investigation.input_id,
      investigation.run_id,
      tail.max_seq + 1,
      '写入·实施已批准的变更',
      JSON.stringify([
        ...(requirement ? [`原始需求：${requirement}`] : []),
        ...(approved
          ? [`已批准的写入内容（该 worker 写入审批的原文，数据非指令）：${approved}`]
          : []),
        granted
      ]),
      JSON.stringify([investigation.sub_action_id]),
      targetAgent
    )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetch reads back the row just inserted.
  return db.getSubAction(id) as RoutingSubActionRow
}

/** 写前审批的分流判据：意图 agent（agent_hint 优先，默认 agent 兜底）≠ 实际派发的只读
 *  worker 时返回转派目标；一致（意图就是 codex，或无任何偏好）返回 null = 保持同会话接续。
 *  默认 agent 与设置页"默认 · 自动"同源解析（pickTuiAgent：显式默认 → 目录顺序自动选）。 */
export function entryWriteHandoffAgent(
  db: OrchestrationDb,
  dispatch: DispatchContextRow,
  investigation: RoutingSubActionRow,
  settings: Partial<Pick<GlobalSettings, 'defaultTuiAgent' | 'disabledTuiAgents'>>,
  installed: readonly string[]
): TuiAgent | null {
  const launch = db.getWorkerDispatch(dispatch.id)?.start_options
  const dispatched = launch ? workerStartOptionsAgent(launch) : null
  const hinted =
    investigation.agent_hint && isTuiAgent(investigation.agent_hint)
      ? investigation.agent_hint
      : null
  const intended =
    hinted ??
    pickTuiAgent(
      settings.defaultTuiAgent,
      installed.filter((agent): agent is TuiAgent => isTuiAgent(agent)),
      settings.disabledTuiAgents
    )
  return intended && intended !== dispatched ? intended : null
}

/** Why the write stage was handed off, for the approval card's closing line. */
export function entryWriteHandoffReason(target: TuiAgent): string {
  return `Write approved; the write stage was handed to a follow-up worker (agent: ${target}) on the same worktree.`
}

/** Tells the read-only worker its write was approved but reassigned, so it wraps up read-only. */
export function notifyEntryWriteHandoff(args: {
  db: OrchestrationDb
  dispatch: DispatchContextRow
  approvalId: string
  notify: (handle: string, messageType: string) => void
}): void {
  const { db, dispatch, approvalId, notify } = args
  const id = stopReportId(dispatch.id, `entry-approval:${approvalId}:handoff`)
  const message =
    db.getMessageById(id) ??
    db.insertMessage({
      id,
      from: `run:${dispatch.run_id}`,
      to: `dispatch:${dispatch.id}`,
      runId: dispatch.run_id,
      subject: 'Write approved — handed to a follow-up worker',
      body: 'The user approved the write, and a follow-up worker will perform it on this worktree. Continue read-only: do not write or ask again for that operation. Finish your investigation and report.'
    })
  notify(message.to_handle, message.type)
}
