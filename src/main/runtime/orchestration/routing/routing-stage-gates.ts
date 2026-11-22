import type { OrchestrationDb } from '../db/orchestration-db'
import { entrySubActionNeedsReadOnly } from './entry-write-policy'
import { OrchestrationError } from '../orchestration-error'
import type { RoutingSubActionRow } from '../db/routing-records'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { savedOrcaPlanStages, type OrcaPlanParse, type OrcaPlanStage } from './orca-plan-parse'

// 阶段化生命周期 (entry-stage-pipeline-plan §6/§7): dependency edges and user gates over the
// routing ledger. A stage's own gate guards its DOWNSTREAM — the user grants a stage's output
// (prototype, plan) before the next stage dispatches; a plan grant also expands the orca-plan
// into an implement chain inside the same transaction.

export function parseStageDependsOn(row: RoutingSubActionRow): string[] {
  if (!row.depends_on_json) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(row.depends_on_json)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** The stage produced its output and the user has not granted it yet — downstream holds. */
export function stageGateAwaiting(row: RoutingSubActionRow): boolean {
  return row.gate === 'user_confirm' && row.gate_granted_at === null
}

/** A plan stage whose payload never parsed — its downstream stays blocked until the user
 *  reworks the request (no silent expansion). */
export function stagePlanUnusable(row: RoutingSubActionRow): boolean {
  return row.stage_kind === 'plan' && savedOrcaPlanStages(row.plan_json) === null
}

export type StageUpstream = {
  rows: RoutingSubActionRow[]
  /** Upstream ids not yet user-accepted: unsettled, ungranted gates or unusable plans. */
  blockedOn: string[]
  /** The first upstream with a bound worktree — the chain's shared workspace. */
  worktreeId?: string
}

export function resolveStageUpstream(
  db: OrchestrationDb,
  row: RoutingSubActionRow
): StageUpstream | null {
  const ids = parseStageDependsOn(row)
  if (ids.length === 0) {
    return null
  }
  const rows = ids
    .map((id) => db.getSubAction(id))
    .filter((upstream): upstream is RoutingSubActionRow => upstream !== undefined)
  const resolvedIds = new Set(rows.map((upstream) => upstream.sub_action_id))
  const blockedOn = ids.filter((id) => !resolvedIds.has(id))
  let worktreeId: string | undefined
  for (const upstream of rows) {
    if (
      !stageUpstreamSettled(db, upstream) ||
      stageGateAwaiting(upstream) ||
      stagePlanUnusable(upstream)
    ) {
      blockedOn.push(upstream.sub_action_id)
      continue
    }
    worktreeId ??= upstreamWorktreeId(db, upstream)
  }
  return { rows, blockedOn, ...(worktreeId ? { worktreeId } : {}) }
}

/** Writable loop stages require user acceptance before downstream dispatch. */
function stageUpstreamSettled(db: OrchestrationDb, upstream: RoutingSubActionRow): boolean {
  // merge 行没有 worker/task：系统在泵里执行 git 合并，merged_at 即结算（pipeline §8）。
  if (upstream.stage_kind === 'merge') {
    return upstream.merged_at !== null
  }
  if (!upstream.task_id) {
    return false
  }
  const task = db.getTask(upstream.task_id)
  if (task?.status !== 'completed') {
    return false
  }
  if (upstream.stage_kind === 'clarification' || upstream.stage_kind === 'plan') {
    return true
  }
  const input = db.getRoutingInput(upstream.input_id)
  if (input?.loop_dev !== 1 || entrySubActionNeedsReadOnly(db, upstream)) {
    return true
  }
  const cycle = db.getLatestReviewCycleForTask(task.id)
  return cycle?.state === 'accepted'
}

function upstreamWorktreeId(
  db: OrchestrationDb,
  upstream: RoutingSubActionRow
): string | undefined {
  if (!upstream.task_id) {
    return undefined
  }
  const dispatch = db.getDispatchContext(upstream.task_id)
  return dispatch ? (db.getWorkerDispatch(dispatch.id)?.worktree_id ?? undefined) : undefined
}

/** Persist the plan stage's orca-plan once its worker reported: usable stages or a parse
 *  failure marker. A payload never downgrades: the pump re-settles parse-failed rows while the
 *  plan-file recovery probes the workspace, so a marker may upgrade to stages — stages stay. */
export function saveRoutingPlanParse(
  this: OrchestrationDb,
  subActionId: string,
  parsed: OrcaPlanParse
): RoutingSubActionRow {
  const payload =
    parsed.status === 'ok'
      ? JSON.stringify({ stages: parsed.stages })
      : JSON.stringify({
          parseError:
            parsed.status === 'missing'
              ? '报告中没有 orca-plan 计划块，需要人工整理后再确认'
              : parsed.detail
        })
  this.db
    .prepare(
      `UPDATE routing_sub_actions SET plan_json = ?
       WHERE sub_action_id = ?
         AND (plan_json IS NULL
              OR (json_valid(plan_json) AND json_extract(plan_json, '$.parseError') IS NOT NULL))`
    )
    .run(payload, subActionId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetch reads back the row just updated.
  return this.getSubAction(subActionId) as RoutingSubActionRow
}

export type StageGateGrant = {
  subAction: RoutingSubActionRow
  /** Implement/merge stages minted by this grant (empty for prototype gates and replays). */
  expanded: RoutingSubActionRow[]
}

/** Grant one stage's output. Idempotent: a replay returns the row with its existing expansion.
 *  A plan stage must carry a usable orca-plan — granting an unparseable plan is refused so the
 *  request gets reworked instead of silently advancing. */
export function grantRoutingStageGate(this: OrchestrationDb, subActionId: string): StageGateGrant {
  const row = this.getSubAction(subActionId)
  if (!row) {
    throw new OrchestrationError(
      'lifecycle_not_found',
      `Sub-action ${subActionId} was not found.`,
      {
        subActionId
      }
    )
  }
  if (row.gate !== 'user_confirm') {
    throw new OrchestrationError(
      'invalid_argument',
      `Sub-action ${subActionId} has no user gate.`,
      { subActionId }
    )
  }
  if (row.gate_granted_at) {
    return {
      subAction: row,
      expanded: this.listSubActions(row.input_id).filter(
        (action) => action.plan_source_id === row.sub_action_id
      )
    }
  }
  if (this.isRoutingRunPaused(row.run_id) || this.isRoutingSubActionPaused(subActionId)) {
    throw new OrchestrationError(
      'paused',
      'Resume the project task entry and card before confirming.'
    )
  }
  // merge 行先确认后由泵执行（无 worker/task），task 完成检查只适用于 worker 阶段。
  if (
    row.stage_kind !== 'merge' &&
    (!row.task_id || this.getTask(row.task_id)?.status !== 'completed')
  ) {
    throw new OrchestrationError('lifecycle_conflict', 'The stage has not completed.')
  }
  const planStages = row.stage_kind === 'plan' ? savedOrcaPlanStages(row.plan_json) : null
  if (row.stage_kind === 'plan' && !planStages) {
    throw new OrchestrationError(
      'invalid_argument',
      '该阶段的 orca-plan 尚未整理好（解析失败或缺失），请补充要求后重新走规划。'
    )
  }
  this.db.exec('SAVEPOINT grant_stage_gate')
  try {
    this.db
      .prepare(
        "UPDATE routing_sub_actions SET gate_granted_at = datetime('now') WHERE sub_action_id = ?"
      )
      .run(subActionId)
    let expanded: RoutingSubActionRow[] = []
    if (planStages) {
      const existing = this.listSubActions(row.input_id).filter(
        (action) => action.plan_source_id === row.sub_action_id
      )
      expanded = existing.length > 0 ? existing : expandOrcaPlanStages(this, row, planStages)
    }
    this.db.exec('RELEASE grant_stage_gate')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetch reads back the row just updated.
    return { subAction: this.getSubAction(subActionId) as RoutingSubActionRow, expanded }
  } catch (error) {
    this.db.exec('ROLLBACK TO grant_stage_gate')
    this.db.exec('RELEASE grant_stage_gate')
    throw error
  }
}

/** Record a checkpoint merge attempt (pipeline §8): merged_at + receipt settle the row on
 *  success; failures only stamp entry_error — the pump retries granted-but-unmerged rows. */
export function recordRoutingMergeOutcome(
  this: OrchestrationDb,
  subActionId: string,
  outcome: { ok: true; receiptJson: string } | { ok: false; error: string }
): void {
  if (outcome.ok) {
    this.db
      .prepare(
        `UPDATE routing_sub_actions
           SET merged_at = datetime('now'), merge_receipt_json = ?, entry_error = NULL
         WHERE sub_action_id = ?`
      )
      .run(outcome.receiptJson, subActionId)
  } else {
    this.db
      .prepare('UPDATE routing_sub_actions SET entry_error = ? WHERE sub_action_id = ?')
      .run(outcome.error, subActionId)
  }
}

/** 自动里程碑合并失败（冲突/非 ff）→ 升级为人工确认：门变回 user_confirm 并带上失败原因，
 *  卡片回到待确认态由人放行；泵不再自动重试该行（§8）。 */
export function promoteRoutingMergeCheckpoint(
  this: OrchestrationDb,
  subActionId: string,
  error: string
): void {
  this.db
    .prepare(
      `UPDATE routing_sub_actions
         SET gate = 'user_confirm', gate_granted_at = NULL, entry_error = ?
       WHERE sub_action_id = ? AND stage_kind = 'merge' AND gate = 'auto' AND merged_at IS NULL`
    )
    .run(error, subActionId)
}

/** Mint one implement sub-action per plan stage, chained on the plan's own sub-action id so
 *  worktree binding and report injection flow through the ordinary dependency edge. */
function expandOrcaPlanStages(
  db: OrchestrationDb,
  plan: RoutingSubActionRow,
  stages: OrcaPlanStage[]
): RoutingSubActionRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the COUNT(*) projection is exactly { seq: number }.
  const num = db.db
    .prepare(
      'SELECT COUNT(*) AS seq FROM routing_inputs WHERE rowid <= (SELECT rowid FROM routing_inputs WHERE input_id = ?)'
    )
    .get(plan.input_id) as { seq: number }
  const tail = db.db
    .prepare(
      'SELECT COUNT(*) AS count, COALESCE(MAX(seq), 0) AS max_seq FROM routing_sub_actions WHERE input_id = ?'
    )
    .get(plan.input_id) as { count: number; max_seq: number }
  const expanded: RoutingSubActionRow[] = []
  let previousId = plan.sub_action_id
  let minted = 0
  const mintRow = (row: {
    stageKind: 'implement' | 'merge'
    gate: 'auto' | 'user_confirm'
    text: string
    constraintsJson: string
    agentHint: string | null
  }): string => {
    const id = `sa-${num.seq}-${tail.count + minted + 1}`
    db.db
      .prepare(
        `INSERT INTO routing_sub_actions
           (sub_action_id, input_id, run_id, seq, text, constraints_json, task_id,
            stage_kind, depends_on_json, gate, agent_hint, plan_source_id)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        plan.input_id,
        plan.run_id,
        tail.max_seq + minted + 1,
        row.text,
        row.constraintsJson,
        row.stageKind,
        JSON.stringify([previousId]),
        row.gate,
        row.agentHint,
        plan.sub_action_id
      )
    minted += 1
    return id
  }
  stages.forEach((stage, index) => {
    const id = mintRow({
      stageKind: 'implement',
      gate: 'auto',
      text: stage.title,
      constraintsJson: JSON.stringify([stage.spec]),
      agentHint:
        typeof stage.agent === 'string' && isTuiAgent(stage.agent.trim().toLowerCase())
          ? stage.agent.trim().toLowerCase()
          : null
    })
    expanded.push(db.getSubAction(id) as RoutingSubActionRow)
    previousId = id
    // checkpoint 里程碑（或链尾兜底）：铸 merge 检查点行。中间里程碑自动合并——其授权已由
    // 计划门覆盖（§8），失败时升级为人工确认；链尾交付保留唯一一次确认门。
    if (stage.checkpoint === true || index === stages.length - 1) {
      const chainTail = index === stages.length - 1
      const mergeId = mintRow({
        stageKind: 'merge',
        gate: chainTail ? 'user_confirm' : 'auto',
        text: `合并检查点：${stage.title} 后把链条累积产出提交并合并进主分支。`,
        constraintsJson: '[]',
        agentHint: null
      })
      expanded.push(db.getSubAction(mergeId) as RoutingSubActionRow)
      previousId = mergeId
    }
  })
  return expanded
}
