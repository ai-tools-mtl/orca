/** Optional-decision-routing rows (plan §6): input → sub-action → supplement → attempt linkage. */

export type RoutingDecisionStatus = 'received' | 'decided'

export type RoutingInputRow = {
  input_id: string
  run_id: string
  raw_text: string
  received_seq: number
  decision_status: RoutingDecisionStatus
  decision_json: string | null
  created_at: string
}

export type RoutingSubActionState =
  | 'registered'
  | 'delivered'
  | 'processed'
  | 'violated'
  | 'pending_verification'

export type RoutingSubActionRow = {
  sub_action_id: string
  input_id: string
  run_id: string
  seq: number
  text: string
  constraints_json: string
  task_id: string | null
  /** Card state per §5.3: 已收到(registered)/已投递(delivered)/本轮已处理(processed)/
   *  本轮未按补充执行(violated)/待核对(pending_verification). */
  state: RoutingSubActionState
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
