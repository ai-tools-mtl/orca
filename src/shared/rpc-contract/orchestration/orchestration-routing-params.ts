import { z } from 'zod'
import { OptionalString, requiredString } from '../rpc-param-primitives'

export const RoutingInputRegisterParams = z.object({
  run: OptionalString,
  text: requiredString('Missing --text'),
  from: OptionalString
})

export const RoutingDecisionRegisterParams = z.object({
  input: requiredString('Missing --input'),
  /** JSON array of [{text, constraints?, task?}]; parsed before the Run is checked. */
  subActions: requiredString('Missing --sub-actions'),
  from: OptionalString,
  run: OptionalString
})

export const RoutingSupplementSendParams = z.object({
  input: requiredString('Missing --input'),
  subAction: requiredString('Missing --sub-action'),
  dispatch: requiredString('Missing --dispatch'),
  text: requiredString('Missing --text'),
  /** Omitted: steer the Dispatch's active turn at send time. Given: steer exactly that turn. */
  expectedTurn: OptionalString,
  from: OptionalString,
  run: OptionalString
})

export const RoutingSupplementShowParams = z.object({
  supplement: OptionalString,
  subAction: OptionalString,
  from: OptionalString,
  run: OptionalString
})

export const RoutingTargetShowParams = z.object({
  dispatch: requiredString('Missing --dispatch'),
  from: OptionalString,
  run: OptionalString
})

export const RoutingInputsShowParams = z.object({
  from: OptionalString,
  run: OptionalString
})

export const RoutingSupplementContinueParams = z.object({
  input: requiredString('Missing --input'),
  subAction: requiredString('Missing --sub-action'),
  dispatch: requiredString('Missing --dispatch'),
  from: OptionalString,
  run: OptionalString
})

export const RoutingContinuationBindParams = z.object({
  subAction: requiredString('Missing --sub-action'),
  dispatch: requiredString('Missing --dispatch'),
  from: OptionalString,
  run: OptionalString
})

export const RoutingSubActionVerifyParams = z.object({
  input: requiredString('Missing --input'),
  subAction: requiredString('Missing --sub-action'),
  dispatch: requiredString('Missing --dispatch'),
  expectedTurn: requiredString('Missing --expected-turn'),
  text: requiredString('Missing --text'),
  expectAction: requiredString('Missing --expect-action'),
  expectPath: OptionalString,
  /** JSON array of paths no item in the session may read. */
  forbiddenPaths: OptionalString,
  /** JSON array of projected agentSession.history items (sequence + body). */
  items: requiredString('Missing --items'),
  /** Fallback anchor when the supplement echo is not its own journal item (e.g. the last
   *  pre-delivery task action). The echo wins when present. */
  anchorSequence: z.coerce.number().int().optional(),
  from: OptionalString,
  run: OptionalString
})

export const RoutingSubActionClaimParams = z.object({
  input: requiredString('Missing --input'),
  subAction: requiredString('Missing --sub-action'),
  dispatch: requiredString('Missing --dispatch'),
  from: OptionalString,
  run: OptionalString
})

export const RoutingSubActionHandbackParams = z.object({
  input: requiredString('Missing --input'),
  subAction: requiredString('Missing --sub-action'),
  dispatch: requiredString('Missing --dispatch'),
  reason: OptionalString,
  from: OptionalString,
  run: OptionalString
})

export const RoutingAutoRouteParams = z.object({
  input: requiredString('Missing --input'),
  timeoutMs: z.coerce.number().int().positive().optional(),
  from: OptionalString,
  run: OptionalString
})

export const ReviewCycleStartParams = z.object({
  task: requiredString('Missing --task'),
  writerDispatch: requiredString('Missing --writer-dispatch'),
  reviewerDispatch: requiredString('Missing --reviewer-dispatch'),
  from: OptionalString,
  run: OptionalString
})

export const ReviewCycleParams = z.object({
  cycle: requiredString('Missing --cycle'),
  from: OptionalString,
  run: OptionalString
})

export const ReviewOpinionRecordParams = z.object({
  cycle: requiredString('Missing --cycle'),
  body: requiredString('Missing --body'),
  blocking: z.boolean().optional(),
  from: OptionalString,
  run: OptionalString
})

// The desktop 统一任务入口's own surface: the entry coordinates its Run as
// `desktop-entry:<group>`, so these name a project group instead of a Run or a caller handle.
export const EntryShowParams = z.object({
  group: requiredString('Missing --group')
})

export const DecisionModelParams = z.object({
  source: z.literal('agent'),
  /** The installed agent proposing the route; omitted means the first installed one. */
  agent: z.string().optional()
})

export const DecisionModelPatchParams = DecisionModelParams

/** 专用决策模型旁路对照（评估）：endpoint identity only — the key never echoes back. */
export const RouteBypassPatchParams = z.object({
  enabled: z.boolean(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  modelId: z.string().optional(),
  protocol: z.enum(['openai', 'anthropic']).optional()
})

export const EntryRoutingTestParams = z.discriminatedUnion('source', [
  DecisionModelParams,
  z.object({
    source: z.literal('dedicated'),
    baseUrl: requiredString('Missing --base-url'),
    apiKey: requiredString('Missing --api-key'),
    modelId: requiredString('Missing --model'),
    protocol: z.enum(['openai', 'anthropic']).optional()
  })
])

export const EntrySubmitParams = z.object({
  group: requiredString('Missing --group'),
  text: requiredString('Missing --text'),
  /** 循环开发（本次）: this submission's dev sub-actions run the writer→reviewer loop. */
  loop: z.boolean().optional(),
  /** Selects the settings-backed reviewer model without carrying its credentials. */
  decisionModel: DecisionModelParams.pick({ source: true, agent: true }).optional(),
  /** 客户端请求 ID（8–64 字符，字母数字 _ -）：整个提交重放（响应丢失后重试）复用同一
   *  输入——路由与派发去重从提交入口开始，而不是只从路由开始。 */
  requestId: z.string().optional()
})

export const EntrySupplementParams = z.object({
  group: requiredString('Missing --group'),
  input: requiredString('Missing --input'),
  subAction: requiredString('Missing --sub-action'),
  dispatch: requiredString('Missing --dispatch'),
  text: requiredString('Missing --text'),
  /** Omitted: steer the Dispatch's active turn at send time. Given: steer exactly that turn. */
  expectedTurn: OptionalString
})

export const EntryHandbackParams = z.object({
  group: requiredString('Missing --group'),
  subAction: requiredString('Missing --sub-action'),
  dispatch: requiredString('Missing --dispatch')
})

export const EntryTransferParams = EntrySupplementParams.omit({ expectedTurn: true }).extend({
  fromDispatch: requiredString('Missing source dispatch').nullable()
})

export const EntryPauseParams = z.object({
  group: requiredString('Missing --group'),
  /** Given: pause/resume that one task card (§5.5 per-card wait) instead of the whole entry. */
  subAction: OptionalString
})

export const EntryReviewParams = z.object({
  group: requiredString('Missing --group'),
  task: requiredString('Missing --task')
})

export const EntryApprovalsParams = z.object({
  group: requiredString('Missing --group')
})

export const EntryReviewAcceptParams = EntryReviewParams.extend({
  cycle: requiredString('Missing --cycle'),
  revision: z.number().int().positive()
})

export const EntryAutoRouteParams = z.object({
  group: requiredString('Missing --group'),
  input: requiredString('Missing --input'),
  dispatch: z.boolean().optional(),
  /** custom: the settings-configured decision model; omitted routes on the ZCode plan credential. */
  decisionModel: DecisionModelParams.optional()
})

export const EntryPlanParams = z.object({
  group: requiredString('Missing --group'),
  input: requiredString('Missing --input'),
  /** A plain string is a classic sub-action; the object form registers a pipeline stage. */
  subActions: z
    .array(
      z.union([
        z.string().trim().min(1),
        z.object({
          text: z.string().trim().min(1),
          stageKind: z.enum(['clarification', 'prototype', 'plan', 'implement', 'merge']),
          gate: z.enum(['auto', 'user_confirm']).optional(),
          /** Upstream edges: 1-based seqs within this batch. */
          dependsOn: z.array(z.number().int().min(1)).max(8).optional(),
          agentHint: z.string().trim().optional()
        })
      ])
    )
    .min(1)
    .max(8)
})

export const EntryGateGrantParams = z.object({
  group: requiredString('Missing --group'),
  subAction: requiredString('Missing --sub-action')
})

export const EntryGateRejectParams = z.object({
  group: requiredString('Missing --group'),
  subAction: requiredString('Missing --sub-action'),
  /** The modification requirement: mailed to the stage worker as an unread follow-up. */
  text: requiredString('Missing --text')
})

export const EntryAnswerAskParams = z.object({
  group: requiredString('Missing --group'),
  /** The pending question's message id (orchestration.entryShow exposes it). */
  message: requiredString('Missing --message'),
  body: requiredString('Missing --body')
})

export const DecisionAuditListParams = z.object({
  group: requiredString('Missing --group'),
  /** Filter to one input's attempts (原请求 / 重试 / 升级重拆各占一行). */
  input: z.string().optional(),
  limit: z.number().int().positive().max(200).optional()
})

export const EntryAssignParams = z.object({
  group: requiredString('Missing --group'),
  input: requiredString('Missing --input'),
  subAction: requiredString('Missing --sub-action'),
  agent: requiredString('Missing --agent')
})

export const EntryWorkersParams = z.object({
  group: requiredString('Missing --group')
})

export const EntryClaimParams = z.object({
  group: requiredString('Missing --group'),
  subAction: requiredString('Missing --sub-action'),
  dispatch: requiredString('Missing --dispatch')
})

export const EntryDeleteParams = z.discriminatedUnion('scope', [
  EntryShowParams.extend({
    scope: z.literal('request'),
    input: requiredString('Missing --input')
  }),
  EntryShowParams.extend({
    scope: z.literal('sub-action'),
    input: requiredString('Missing --input'),
    subAction: requiredString('Missing --sub-action')
  }),
  EntryShowParams.extend({ scope: z.literal('failed') }),
  // 清空全部指令：best-effort 扫全部可删候选（received + 整条可删 + 失败），在跑/被认领的保留。
  EntryShowParams.extend({ scope: z.literal('all') })
])

// ─── 专用决策模型旁路对照（评估）───────────────────────────────────────────────

/** 人工标注的评估分组（entry-intent-routing-design §专用决策模型旁路验收）。 */
/** 人工标注的评估分组（entry-intent-routing-design §专用决策模型旁路验收）。 */
export const ROUTE_BYPASS_CATEGORIES = [
  'status_only',
  'single_task',
  'composite',
  'continuation_ambiguous',
  'write_gated'
] as const

export type RouteBypassCategory = (typeof ROUTE_BYPASS_CATEGORIES)[number]

const RouteBypassExpectedActionSchema = z.object({
  type: z.enum(['query_status', 'continue_task', 'create_task', 'clarify']),
  /** continue_task/create_task 的期望任务归属（账本候选 ID 或任务说明关键词）。 */
  taskId: z.string().optional(),
  instruction: z.string().optional()
})

export const RouteBypassLabelSetParams = z.object({
  group: requiredString('Missing --group'),
  input: requiredString('Missing --input'),
  category: z.enum(ROUTE_BYPASS_CATEGORIES),
  expected: z.array(RouteBypassExpectedActionSchema).min(0).max(8),
  notes: z.string().optional()
})

export const RouteBypassLabelListParams = z.object({
  group: requiredString('Missing --group'),
  limit: z.number().int().positive().max(500).optional()
})

export const RouteBypassTrialListParams = z.object({
  group: requiredString('Missing --group'),
  input: z.string().optional(),
  limit: z.number().int().positive().max(200).optional()
})

export const RouteBypassReportParams = z.object({
  group: requiredString('Missing --group')
})

export type EntryDeleteRequest = z.output<typeof EntryDeleteParams>
