import { OrchestrationError } from '../orchestration-error'
import type { OrchestrationDb } from '../db/orchestration-db'
import type { TaskRow } from '../db/orchestration-records'
import type { RoutingStageGate, RoutingStageKind } from '../db/routing-records'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { planAgentPoolSection } from './plan-agent-pool'

// Plan §5.1: the Router is a restricted decision step over a persistent input — never a general
// agent. The decision provider is a seam: Orca prepares the context (current message, source
// reference, candidate task summaries, executor capabilities), the provider proposes zero or
// more sub-actions, Orca validates and registers them atomically. The identity provider defers
// everything to manual assignment; model-backed providers plug into the same seam later.

export type RoutingDecisionProposal = {
  subActions: {
    text: string
    constraints?: string[]
    taskId?: string | null
    agent?: TuiAgent
    stageKind?: RoutingStageKind
    gate?: RoutingStageGate
    dependsOn?: (number | string)[]
    agentHint?: string | null
    /** 控制行（§直接操作会话）：派发时中断目标任务会话而不是投递补充。 */
    controlKind?: 'interrupt'
  }[]
  decision?: unknown
  /** Recorded when nothing needs to happen (§5.1: 无需处理时记录原因，子动作列表为空). */
  reason?: string
}

export type RoutingDecisionContext = {
  inputId: string
  text: string
  candidateTasks: { taskId: string; spec: string; status: string }[]
  executorCapabilities: readonly string[]
  /** 确定性进展摘要（§5.1）：状态查询的回答由运行时生成，不过模型。 */
  statusDigest?: string
  /** 本 Run 最近几条输入及其裁决（会话连续性）：只供 reply/指代消解参考，工作路由仍以当前消息为准。 */
  recentTurns?: { text: string; outcome: string }[]
}

export type RoutingDecisionProvider = (
  context: RoutingDecisionContext
) => Promise<RoutingDecisionProposal>

/** §5.1: no model provider is configured yet — every input stays received for manual
 *  assignment. Never invents sub-actions. */
export const MANUAL_DECISION_PROVIDER: RoutingDecisionProvider = async () => ({
  subActions: [],
  reason: 'no decision provider configured; the input awaits manual assignment'
})

export type RoutedDecision = {
  routed: boolean
  reused: boolean
  reason?: string
  subActions: { sub_action_id: string; text: string; task_id: string | null; agent?: TuiAgent }[]
}

const DEFAULT_ROUTER_TIMEOUT_MS = 30_000

/** 该 Run 里被入口软删除的任务（其绑定子动作带 entry_deleted_at）——路由/裁决共用。 */
export function deletedRoutingTasks(db: OrchestrationDb, runId: string) {
  return new Set(
    db.db
      .prepare(
        `SELECT task_id FROM routing_sub_actions
         WHERE run_id = ? AND task_id IS NOT NULL AND entry_deleted_at IS NOT NULL`
      )
      .all(runId)
      .map((row) => row.task_id)
  )
}

/** 路由/续传的候选窗口（决策源各只看前几条）：活跃任务在前、终态排后，同级新任务优先——
 *  listTasks 的 created_at 升序会把最老的排最前，恰好最不像续传目标。意图分类与 Agent leg
 *  必须共用同一份快照，task_N 回映射才一致。窗口与字段大小显式限幅（设计 §动作协议与上下文：
 *  有限的候选任务与近期项目摘要）；发送的正是这份快照，登记决定时原样留存。 */
export const ROUTE_CANDIDATE_LIMIT = 8
export const ROUTE_CANDIDATE_SPEC_MAX = 160
export const ROUTE_STATUS_DIGEST_MAX = 400

export function routingCandidateTasks(db: OrchestrationDb, runId: string) {
  const deletedTasks = deletedRoutingTasks(db, runId)
  return db
    .listTasks({ runId })
    .filter((task) => !deletedTasks.has(task.id))
    .sort((a, b) => {
      const rank = (task: TaskRow) =>
        task.status === 'completed' || task.status === 'failed' ? 1 : 0
      return rank(a) - rank(b) || b.created_at.localeCompare(a.created_at)
    })
    .slice(0, ROUTE_CANDIDATE_LIMIT)
    .map((task: TaskRow) => ({
      taskId: task.id,
      spec: task.spec.slice(0, ROUTE_CANDIDATE_SPEC_MAX),
      status: task.status
    }))
}

/** Route one received input: propose → validate (candidate refs, sub-action presence) →
 *  register atomically (idempotent per §5.1). Timeout, invalid output or a provider refusal
 *  leaves the input received for manual assignment. */
export async function routeRoutingInput(
  db: OrchestrationDb,
  input: {
    inputId: string
    provider?: RoutingDecisionProvider
    timeoutMs?: number
    executorCapabilities?: readonly string[]
    /** 确定性进展摘要，透传给 provider 上下文（状态查询的回答不过模型）。 */
    statusDigest?: string
    /** 近期对话（会话连续性），透传给 provider 上下文。 */
    recentTurns?: { text: string; outcome: string }[]
    /** 决定落库时的授权语义（§派发授权，与决定同一 SAVEPOINT 原子写入）：缺省 hold。 */
    dispatchIntent?: 'hold' | 'granted'
  }
): Promise<RoutedDecision> {
  const row = db.getRoutingInput(input.inputId)
  if (!row) {
    throw new OrchestrationError(
      'lifecycle_not_found',
      `Routing input ${input.inputId} was not found.`,
      {
        inputId: input.inputId
      }
    )
  }
  if (row.decision_status === 'decided') {
    const subActions = db.listSubActions(input.inputId).map((subAction) => ({
      sub_action_id: subAction.sub_action_id,
      text: subAction.text,
      task_id: subAction.task_id
    }))
    return { routed: true, reused: true, subActions }
  }
  const provider = input.provider ?? MANUAL_DECISION_PROVIDER
  if (provider === MANUAL_DECISION_PROVIDER) {
    // The manual default never registers a decision — the input stays received for assignment.
    return {
      routed: false,
      reused: false,
      reason: 'no decision provider configured; the input awaits manual assignment',
      subActions: []
    }
  }
  // 续传/引用的候选窗口：活跃任务在前、终态排后；provider 看到的快照即校验依据。
  const candidateTasks = routingCandidateTasks(db, row.run_id)
  let proposal: RoutingDecisionProposal
  try {
    proposal = await withTimeout(
      provider({
        inputId: input.inputId,
        text: row.raw_text,
        candidateTasks,
        executorCapabilities: input.executorCapabilities ?? [],
        ...(input.statusDigest ? { statusDigest: input.statusDigest } : {}),
        ...(input.recentTurns ? { recentTurns: input.recentTurns } : {})
      }),
      input.timeoutMs ?? DEFAULT_ROUTER_TIMEOUT_MS
    )
  } catch (error) {
    return {
      routed: false,
      reused: false,
      reason: `router unavailable: ${error instanceof Error ? error.message : String(error)}`,
      subActions: []
    }
  }
  // 校验 (§5.1): referenced task ids must come from the runtime-provided candidate set, and a
  // no-op proposal must carry its reason.
  const candidateIds = new Set(candidateTasks.map((candidate) => candidate.taskId))
  const deletedDuringRouting = proposal.subActions.some((action) => action.taskId)
    ? deletedRoutingTasks(db, row.run_id)
    : undefined
  for (const subAction of proposal.subActions) {
    if (
      subAction.taskId !== undefined &&
      subAction.taskId !== null &&
      (!candidateIds.has(subAction.taskId) || deletedDuringRouting?.has(subAction.taskId))
    ) {
      return {
        routed: false,
        reused: false,
        reason: `router proposed an unknown task reference ${subAction.taskId}; the input awaits manual assignment`,
        subActions: []
      }
    }
  }
  if (proposal.subActions.length === 0 && !proposal.reason) {
    return {
      routed: false,
      reused: false,
      reason:
        'the router proposed no sub-actions without a reason; the input awaits manual assignment',
      subActions: []
    }
  }
  const decision = db.registerRoutingDecision({
    inputId: input.inputId,
    subActions: proposal.subActions,
    dispatchIntent: input.dispatchIntent,
    decision: {
      reason: proposal.reason ?? null,
      decision: proposal.decision ?? null,
      taskReferences: proposal.subActions.map((action) => action.taskId ?? null),
      ...(proposal.subActions.some((action) => action.agent)
        ? { agents: proposal.subActions.map((action) => action.agent ?? null) }
        : {})
    }
  })
  return {
    routed: true,
    reused: decision.reused,
    ...(proposal.reason ? { reason: proposal.reason } : {}),
    subActions: decision.subActions.map((subAction, index) => {
      const agent = decision.reused ? undefined : proposal.subActions[index]?.agent
      return {
        sub_action_id: subAction.sub_action_id,
        text: subAction.text,
        task_id: subAction.task_id,
        ...(agent ? { agent } : {})
      }
    })
  }
}

/** The 规划模板 the entry registers for a needsPlanning input (pipeline §3, 用户定序：需求拆解
 *  先行；需求文档/简单功能跳过澄清): 需求澄清与拆解 when needed, then 原型设计 when the request
 *  warrants one, then 任务设计与拆解 producing the orca-plan. 原型/计划 carry the manual user
 *  gates (验收与范围是仅有的人类决策点；门卡呈现计划 stages); clarification auto-releases —
 *  阶段内 ask 已把用户放进环，产物随后还要过 plan 门，中间这道人工点击是冗余的。Stages carry
 *  the §5.1 role baseline as agent hint (方案/拆解 claude→…, 原型绘制 dsh→…; dispatch
 *  re-checks the hint against the host's installed pool); the plan stage also embeds the
 *  host's installed agent pool with capability profiles so per-stage agents follow the
 *  strengths of each agent instead of collapsing the chain onto one; the template texts avoid
 *  the investigation/read-only heuristic's patterns on purpose — stage authority is the gate,
 *  and stages skip the heuristic at dispatch. */
export function planningTemplateSubActions(
  requirement: string,
  needsPrototype: boolean,
  needsClarification: boolean,
  availableAgents: readonly string[] = []
): RoutingDecisionProposal['subActions'] {
  const requirementText = `需求原文：\n${requirement}`
  // 能力分工注入计划 prompt：计划 worker 只认识自己，不给池与画像就会把全部阶段填给自己。
  const agentPoolSection = planAgentPoolSection(availableAgents)
  const clarification = {
    text: `需求澄清与拆解：先把需求整理成一份需求说明——目标、边界（明确不做什么）、模块划分、关键流程与验收要点，可写入 requirements.md。本阶段只产出需求说明，不做架构设计也不实施。需要向用户提问时，每个问题单独一行、用 1. 2. 3. 编号，不要把多条问题挤成一段。\n\n${requirementText}`,
    stageKind: 'clarification' as const,
    gate: 'auto' as const,
    agentHint: 'claude'
  }
  const prototype = {
    text: `原型设计：基于需求说明产出满足需求的原型设计稿（可写入 prototype/ 目录），说明关键设计决策后停下。本阶段只做原型，不实施需求本身。\n\n${requirementText}`,
    stageKind: 'prototype' as const,
    gate: 'user_confirm' as const,
    agentHint: 'dsh'
  }
  const plan = {
    text: `任务设计与拆解：先核对仓库中与需求相关的代码，结合需求说明与原型，在报告末尾输出 orca-plan JSON 计划块（{"stages":[{"title":"…","agent":"…","spec":"…","checkpoint":true}]}，最多 8 个阶段，spec 为自包含指令）。计划块必须以 orca-plan 围栏代码块原文内嵌在报告正文里——不要只把计划写入文件或在报告里只给文件路径。checkpoint:true 标记里程碑阶段：该阶段完成后把链条累积产出合并进主分支（用户确认后执行），建议加在需求、原型、架构等文档类阶段；最后一个实施阶段应声明，未声明时系统会在链尾兜底追加合并。${agentPoolSection ? `\n\n${agentPoolSection}` : ''}\n\n本阶段只产出计划，不实施需求本身。\n\n${requirementText}`,
    stageKind: 'plan' as const,
    gate: 'user_confirm' as const,
    agentHint: 'claude'
  }
  const stages: RoutingDecisionProposal['subActions'] = []
  if (needsClarification) {
    stages.push(clarification)
  }
  if (needsPrototype) {
    stages.push({ ...prototype, ...(stages.length > 0 ? { dependsOn: [stages.length] } : {}) })
  }
  stages.push({
    ...plan,
    ...(stages.length > 0 ? { dependsOn: [stages.length] } : {})
  })
  return stages
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`router timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
      })
    ])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}
