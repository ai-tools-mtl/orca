/** Optional-decision-routing rows (plan §6): input → sub-action → supplement → attempt linkage. */

export type RoutingDecisionStatus = 'received' | 'decided'

export type RoutingInputRow = {
  input_id: string
  run_id: string
  raw_text: string
  received_seq: number
  decision_status: RoutingDecisionStatus
  decision_json: string | null
  entry_error: string | null
  /** 持久化的客户端请求 ID（v57）：提交去重按它判别，不猜 input_id 形状。仅迁移能可靠
   *  证明来源的旧格式行由迁移回填；身份候选不唯一的行保持 NULL 并标记 request_id_state。 */
  request_id: string | null
  /** 'ambiguous' = 请求派生但身份候选不唯一（作用域同形或与随机 ID 同形）——与该行同形
   *  的请求 ID 提交一律显式冲突，由调用者换新 ID 或先删除该历史请求。 */
  request_id_state: string | null
  /** 循环开发（本次）: the submission asked for the writer→reviewer loop on dev sub-actions. */
  loop_dev: 0 | 1
  /** The submission's decision-model config, persisted for the loop's reviewer pick. */
  review_model_json: string | null
  require_write_approval: 0 | 1 | null
  created_at: string
}

export type RoutingSubActionState =
  | 'registered'
  | 'delivered'
  | 'processed'
  | 'violated'
  | 'pending_verification'

/** 阶段化生命周期 (entry-stage-pipeline-plan §3): null = classic sub-action (§5.1 path).
 *  prototype/plan are the 规划期 stages, implement the expanded dev chain, merge the closing
 *  stage. A stage's own `gate` guards its DOWNSTREAM: the user grants the produced output
 *  (prototype, plan, merged tree) before the next stage dispatches. */
export type RoutingStageKind = 'clarification' | 'prototype' | 'plan' | 'implement' | 'merge'

export type RoutingStageGate = 'auto' | 'user_confirm'

export type RoutingSubActionRow = {
  sub_action_id: string
  input_id: string
  run_id: string
  seq: number
  text: string
  constraints_json: string
  task_id: string | null
  /** §5.2: the one valid execution target while the sub-action is claimed; null = unclaimed. */
  claimed_dispatch_id: string | null
  claim_version: number
  entry_error: string | null
  /** Card state per §5.3: 已收到(registered)/已投递(delivered)/本轮已处理(processed)/
   *  本轮未按补充执行(violated)/待核对(pending_verification). */
  state: RoutingSubActionState
  /** Per-card pause (§5.5): set by the card's 暂停, gates deliveries and write approvals. */
  paused_at: string | null
  /** Same-folder serialization (§5.6): set when the folder guard defers this sub-action. */
  queued_at: string | null
  stage_kind: RoutingStageKind | null
  /** JSON array of upstream sub_action_ids; null = no dependency edge. */
  depends_on_json: string | null
  gate: RoutingStageGate | null
  /** When the user granted this stage's output (entryGateGrant); null = awaiting. */
  gate_granted_at: string | null
  /** Preferred worker for autonomous stage dispatch; a preference, re-checked against placement. */
  agent_hint: string | null
  /** plan 阶段产出的 orca-plan（{"stages":[…]}）或其解析失败标记（{"parseError":…}）。 */
  plan_json: string | null
  /** For expanded stages: the plan sub-action that produced this stage (lineage + idempotency). */
  plan_source_id: string | null
  /** merge 检查点行：泵执行 git 合并成功的时刻（结算语义，§8）；null = 未合并。 */
  merged_at: string | null
  /** merge 收据（{"commitSha":…,"baseBranch":…}）；null = 未合并或失败。 */
  merge_receipt_json: string | null
  /** 该行写入已获写前审批放行（方向 2 转派行）：只豁免本行只读，不影响同输入其它行。 */
  write_granted_at: string | null
  created_at: string
}

export type RoutingSupplementRow = {
  supplement_id: string
  input_id: string
  sub_action_id: string
  run_id: string
  target_dispatch_id: string
  raw_text: string
  created_at: string
}

export type RoutingSupplementOutcome = 'delivered' | 'refused' | 'unverified'

export type RoutingSupplementAttemptRow = {
  attempt_id: string
  supplement_id: string
  request_id: string
  target_dispatch_id: string
  /** Null only on refusals recorded before any expected turn was established. */
  expected_turn_id: string | null
  outcome: RoutingSupplementOutcome
  refusal_kind: string | null
  detail: string | null
  turn_id: string | null
  /** §6 任务补充与交回: the first post-delivery task action and its result, when verified. */
  first_action_json: string | null
  created_at: string
}

export type RoutingContinuationRow = {
  /** Primary key: plan §6 唯一续接记录 — one continuation per sub-action. */
  sub_action_id: string
  input_id: string
  source_dispatch_id: string
  /** Null while the continuation is registered but the follow-up send has not accepted. */
  follow_up_dispatch_id: string | null
  request_id: string
  created_at: string
}

export type RoutingHandbackRow = {
  sub_action_id: string
  claim_version: number
  handed_back_from: string
  reason: string | null
  created_at: string
}
