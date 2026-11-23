import type { EntryClarification, EntryQueryAnswer, EntryReply } from './entry-ledger-parsers'

import type { RoutingEntryPendingAsk, RoutingEntryAnsweredAsk } from './entry-question-records'
import type { RoutingEntryExecution, RoutingReviewState } from './entry-show-projection'

export type { RoutingEntryExecution, RoutingReviewState }

// One supplement with its ledger attempts (§6), oldest first — the card's 证据条.
export type RoutingEntryDelivery = {
  supplementId: string
  text: string
  targetDispatchId: string
  createdAt: string
  attempts: {
    attemptId?: string
    outcome: 'delivered' | 'refused' | 'unverified'
    createdAt: string
    refusalKind?: string
    turnId?: string
    firstActionSummary?: string
  }[]
}

export type RoutingEntrySubAction = {
  subActionId: string
  text: string
  createdAt?: string
  canDelete?: boolean
  assignmentFailed?: boolean
  assignmentError?: string
  state: 'registered' | 'delivered' | 'processed' | 'violated' | 'pending_verification'
  taskId?: string
  /** 阶段化生命周期 (pipeline §3): prototype/plan/implement/merge; undefined = 经典子动作。 */
  stageKind?: 'clarification' | 'prototype' | 'plan' | 'implement' | 'merge'
  /** 上游 sub_action_id 列表（JSON 解析后）；派发被这些上游的完成/确认挡住。 */
  dependsOn?: string[]
  /** 本产物的用户确认门：downstream 在 gate_granted 前不派发。 */
  gate?: 'auto' | 'user_confirm'
  gateGrantedAt?: string
  /** plan 阶段的 orca-plan 未解析成功（pipeline §5 保守默认）：gate 呈失败卡而非放行按钮。 */
  planUnusable?: boolean
  planParseError?: string
  /** 已解析成功的计划 stages：门卡折叠列表呈现，确认放行前用户能看到撰写的计划。 */
  planStages?: { title: string; spec: string; agent?: string }[]
  /** merge 检查点：合并完成时刻 + 收据（§8）；undefined = 未合并。 */
  mergedAt?: string
  mergeReceipt?: { commitSha: string | null; baseBranch: string }
  agentHint?: string
  pendingAsks?: RoutingEntryPendingAsk[]
  answeredAsks?: RoutingEntryAnsweredAsk[]
  /** The decision referenced an existing task (续接) — its evidence merges into that task's
   *  first sub-action card, so the continuation itself renders no second card. */
  resumed?: boolean
  /** Per-card 暂停 (§5.5): deliveries and write approvals hold until 恢复. */
  pausedAt?: string
  /** Same-folder serialization (§5.6): waiting for the folder's occupier to finish. */
  queuedAt?: string
  execution?: RoutingEntryExecution
  claimedBy?: string
  refusalKind?: string
  firstActionSummary?: string
  deliveries: RoutingEntryDelivery[]
  lastSupplementText?: string
  lastTargetDispatchId?: string
}

export type RoutingEntryInput = {
  inputId: string
  text: string
  canDelete?: boolean
  canDeleteFailed?: boolean
  routingError?: string
  decisionStatus: 'received' | 'decided'
  receivedAt?: string
  /** 循环开发（本次）: dev sub-actions of this submission run the writer→reviewer loop. */
  loopDev?: boolean
  /** The recorded decision's reason (§5.1 轻量调度 verdict), when one was stored. */
  decisionReason?: string
  /** Per sub-action: a non-null entry means the decision referenced an existing task (续接). */
  taskReferences?: (string | null)[]
  /** 统一路由动作批的待澄清项：与查询答案/工作卡片同屏展示，等用户回答。 */
  clarifications?: EntryClarification[]
  /** 路由模型的会话回复（reply 动作）与状态查询答案（query_status）：渲染成助手回复气泡。 */
  replies?: EntryReply[]
  queryAnswers?: EntryQueryAnswer[]
  subActions: RoutingEntrySubAction[]
}

// The RPC-facing schemas and callers live in entry-facts-rpc.ts; the entry cards import these
// types through this module so the view-model stays the single import surface.
export type {
  EntryRoutingResult,
  RoutingEntryApproval,
  RoutingEntryWorker
} from './entry-facts-rpc'
