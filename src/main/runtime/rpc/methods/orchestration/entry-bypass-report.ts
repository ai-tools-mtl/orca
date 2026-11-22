import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import type { RunRow } from '../../../orchestration/db/orchestration-records'
import { ROUTE_BYPASS_CATEGORIES } from '../../../../../shared/rpc-contract/orchestration/orchestration-routing-params'

// 专用决策模型旁路对照的评估计算（entry-intent-routing-design §专用决策模型旁路验收）：
// 把同一份标注与两侧提案（agent_router 的账本决定 / dedicated_bypass 审计行）按组比对出
// 漏工作、绑错任务、无效输出与澄清率，并列原始提案供人工核对约束丢弃。凭据与全文报文不进
// 任何输出。

export type ProposalActions = { type: string; taskId?: string; instruction?: string }[]

export function parseJson(value: string | null | undefined): unknown {
  if (value === null || value === undefined) {
    return undefined
  }
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/** 接受两种形态：完整 RouteProposalV1 容器（{version, actions}，审计 answers_json）与
 *  裸动作数组（标注 expected_json）。 */
function actionsOf(proposal: unknown): ProposalActions {
  const container =
    proposal &&
    typeof proposal === 'object' &&
    Array.isArray((proposal as { actions?: unknown }).actions)
      ? (proposal as { actions: unknown[] })
      : Array.isArray(proposal)
        ? { actions: proposal }
        : undefined
  const actions = Array.isArray(container?.actions) ? container.actions : []
  return actions.filter(
    (action): action is ProposalActions[number] =>
      action !== null &&
      typeof action === 'object' &&
      typeof (action as ProposalActions[number]).type === 'string'
  )
}

/** 机器可判的动作配对：标注期望与提案按「类型 + 目标任务」对齐。continue_task/create_task
 *  记为工作；query_status/clarify 记为应答。约束丢弃无法自动判定——报告并列原始提案，
 *  由人工对照标注备注核对。 */
function compareActions(
  expected: ProposalActions,
  actual: ProposalActions
): { missingWork: string[]; mismatchedTasks: string[]; clarifications: number } {
  // 消耗语义：一个提案动作只能配对一个期望动作——重复期望必须由重复提案覆盖。
  const actualWork = actual.filter(
    (action) => action.type === 'create_task' || action.type === 'continue_task'
  )
  const missingWork: string[] = []
  const mismatchedTasks: string[] = []
  // 多重集合配对（§任务5）：同类型按「期望归属的计数」消耗，不按出现顺序——两个正确的
  // 续接换序是等价提案；期望续接 A/B 而实际续接 A/A 时，B 计漏工作、第二个 A 计绑错。
  // 无 taskId 的期望动作按 instruction 匹配。
  for (const type of ['create_task', 'continue_task'] as const) {
    const expectedOfType = expected.filter((action) => action.type === type)
    const actualOfType = actualWork.filter((action) => action.type === type)
    const keyOf = (action: { taskId?: string; instruction?: string }): string =>
      action.taskId ?? `instruction:${action.instruction ?? ''}`
    const remaining = new Map<string, number>()
    for (const want of expectedOfType) {
      const key = keyOf(want)
      remaining.set(key, (remaining.get(key) ?? 0) + 1)
    }
    for (const action of actualOfType) {
      const key = keyOf(action)
      const left = remaining.get(key) ?? 0
      if (left <= 0) {
        mismatchedTasks.push(`${type}: ${key} is not an expected binding`)
        continue
      }
      remaining.set(key, left - 1)
    }
    for (const [key, count] of remaining) {
      for (let index = 0; index < count; index += 1) {
        missingWork.push(key)
      }
    }
  }
  return {
    missingWork,
    mismatchedTasks,
    clarifications: actual.filter((action) => action.type === 'clarify').length
  }
}

function percentile(sorted: number[], fraction: number): number | undefined {
  if (sorted.length === 0) {
    return undefined
  }
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1))
  return sorted[index]
}

/** Agent 侧的产出动作集从账本推导：登记的子动作（续接行带任务绑定）+ 决定里的查询/澄清
 *  标记，与审计行的 latency 对齐成与 RouteProposalV1 同形的动作集。 */
function agentSideOf(
  db: OrchestrationDb,
  runId: string,
  inputId: string
): { actions: ProposalActions; latencyMs?: number } {
  // 计划展开的实施/合并行（plan_source_id 非空）不是登记产出——评估对齐「登记时的原始
  // 动作集」，规划展开改变动作数量的噪声被剔除。
  const actions: ProposalActions = db
    .listSubActions(inputId)
    .filter((subAction) => subAction.plan_source_id === null)
    .map((subAction) => ({
      type: subAction.task_id ? 'continue_task' : 'create_task',
      ...(subAction.task_id ? { taskId: subAction.task_id } : {}),
      instruction: subAction.text
    }))
  const decision = parseJson(db.getRoutingInput(inputId)?.decision_json) as
    | { decision?: { actionTypes?: string[]; clarifications?: unknown[] } }
    | undefined
  const inner = decision?.decision
  if (inner?.actionTypes?.includes('query_status')) {
    actions.push({ type: 'query_status' })
  }
  if ((inner?.clarifications?.length ?? 0) > 0 || inner?.actionTypes?.includes('clarify')) {
    actions.push({ type: 'clarify' })
  }
  const audit = db
    .listDecisionModelAudits({ runId, inputId, source: 'agent_router', limit: 1 })
    .at(0)
  return {
    actions,
    ...(audit?.latency_ms !== null && audit?.latency_ms !== undefined
      ? { latencyMs: audit.latency_ms }
      : {})
  }
}

function dedicatedSideOf(
  db: OrchestrationDb,
  runId: string,
  inputId: string
): {
  outcome: 'missing' | 'classified' | 'error'
  actions: ProposalActions | null
  latencyMs?: number
  inputTokens?: number
  outputTokens?: number
  errorMessage?: string
} {
  const row = db
    .listDecisionModelAudits({ runId, inputId, source: 'dedicated_bypass', limit: 1 })
    .at(0)
  if (!row) {
    return { outcome: 'missing', actions: null }
  }
  return {
    outcome: row.outcome === 'classified' ? 'classified' : 'error',
    actions: row.outcome === 'classified' ? actionsOf(parseJson(row.answers_json)) : null,
    ...(row.latency_ms !== null ? { latencyMs: row.latency_ms } : {}),
    ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
    ...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {})
  }
}

function latencySummary(values: (number | undefined)[]): { p50?: number; p95?: number } {
  const sorted = values
    .filter((value): value is number => typeof value === 'number')
    .sort((a, b) => a - b)
  return {
    ...(percentile(sorted, 0.5) !== undefined ? { p50: percentile(sorted, 0.5) } : {}),
    ...(percentile(sorted, 0.95) !== undefined ? { p95: percentile(sorted, 0.95) } : {})
  }
}

/** 对照报告：按标注分组统计两侧表现；缺标注或缺旁路记录的已决输入列 pending。 */
export function bypassReportOf(db: OrchestrationDb, run: RunRow) {
  const labels = db.listRouteBypassLabels({ runId: run.id, limit: 500 })
  const details = labels.map((label) => {
    const expected = actionsOf(parseJson(label.expected_json))
    const dedicated = dedicatedSideOf(db, run.id, label.input_id)
    const input = db.getRoutingInput(label.input_id)
    // 写入约束保持：标注 write_gated ⇔ 原文的只读审批门已保持（require_write_approval）。
    const writeGateRespected =
      label.category !== 'write_gated' || (input?.require_write_approval ?? 0) === 1
    return {
      labelId: label.label_id,
      inputId: label.input_id,
      category: label.category,
      expected,
      writeGateRespected,
      agent: agentSideOf(db, run.id, label.input_id),
      dedicated,
      comparison:
        dedicated.outcome === 'classified'
          ? compareActions(expected, dedicated.actions ?? [])
          : { missingWork: [], mismatchedTasks: [], clarifications: 0 }
    }
  })
  const labeled = new Set(labels.map((label) => label.input_id))
  const pending: { inputId: string; reason: 'no_label' | 'no_trial' }[] = []
  for (const input of db.listRunRoutingInputs(run.id)) {
    if (input.decision_status !== 'decided') {
      continue
    }
    if (!labeled.has(input.input_id)) {
      pending.push({ inputId: input.input_id, reason: 'no_label' })
      continue
    }
    const hasTrial =
      db.listDecisionModelAudits({
        runId: run.id,
        inputId: input.input_id,
        source: 'dedicated_bypass',
        limit: 1
      }).length > 0
    if (!hasTrial) {
      pending.push({ inputId: input.input_id, reason: 'no_trial' })
    }
  }
  const summary = ROUTE_BYPASS_CATEGORIES.map((category) => {
    const rows = details.filter((detail) => detail.category === category)
    const classified = rows.filter((row) => row.dedicated.outcome === 'classified')
    // 纯状态目标（status_only 组）：期望 query_status 且两侧都给出查询动作。
    const statusAnswered = classified.filter(
      (row) =>
        category !== 'status_only' ||
        (row.expected.some((action) => action.type === 'query_status') &&
          row.dedicated.actions?.some((action) => action.type === 'query_status') === true)
    ).length
    // 写入约束（write_gated 组）：标注声明写入受限，而输入的只读审批门未保持 → 违规。
    const writeGateViolations = classified.filter(
      (row) => category === 'write_gated' && !row.writeGateRespected
    ).length
    const criticalViolations = classified.reduce(
      (sum, row) => sum + row.comparison.missingWork.length + row.comparison.mismatchedTasks.length,
      0
    )
    return {
      category,
      labeled: rows.length,
      invalidOutputs: rows.length - classified.length,
      missingWork: classified.reduce((sum, row) => sum + row.comparison.missingWork.length, 0),
      mismatchedTasks: classified.reduce(
        (sum, row) => sum + row.comparison.mismatchedTasks.length,
        0
      ),
      clarifications: classified.reduce((sum, row) => sum + row.comparison.clarifications, 0),
      statusAnswered,
      writeGateViolations,
      agentLatency: latencySummary(rows.map((row) => row.agent.latencyMs)),
      dedicatedLatency: latencySummary(rows.map((row) => row.dedicated.latencyMs)),
      dedicatedTokens: {
        input: rows.reduce((sum, row) => sum + (row.dedicated.inputTokens ?? 0), 0),
        output: rows.reduce((sum, row) => sum + (row.dedicated.outputTokens ?? 0), 0)
      },
      // 门槛（§任务5：关键反例必须为零——错绑/漏工作/写入约束丢失）。
      passes:
        criticalViolations === 0 && writeGateViolations === 0 && rows.length === classified.length
    }
  }).filter((group) => group.labeled > 0)
  return {
    runId: run.id,
    summary,
    details,
    pending,
    // 关键反例必须为零（错绑/漏工作/写入约束丢失）；正确率与延迟/成本收益由评估者
    // 依据并列数据与 Agent 基线比对——达标后先在少数项目切换，保留切回 Agent 的选项。
    thresholds: {
      criticalViolationsMustBeZero: ['missingWork', 'mismatchedTasks', 'writeGateViolations']
    },
    passes: summary.every((group) => group.passes)
  }
}
