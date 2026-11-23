import { z } from 'zod'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'

// 任务入口单次调用的统一 Router（entry-intent-routing-design）：一次路由调用返回一份版本化
// 的动作批（RouteProposalV1）。模型键（key）只在批内引用；持久动作 ID 由 Orca 在登记时生成。
// 结构性错误（版本未知、重复键、no_action 不单独出现）在登记前拒绝——入口保持可重试的
// 待路由状态；目标与授权的校验由 Orca 在裁决时逐项执行。

export const ROUTE_PROPOSAL_VERSION = 1

const actionKeySchema = z.string().trim().min(1).max(64)

const queryStatusActionSchema = z.object({
  key: actionKeySchema,
  type: z.literal('query_status'),
  /** "project" = 项目整体概览；否则为候选任务 id。 */
  target: z.string().trim().min(1)
})

/** Models copy templates literally and invent agent names; unknown ids drop so the action stays
 *  unassigned instead of the whole proposal failing validation. */
const normalizeAgentSuggestion = z.preprocess(
  (raw) =>
    typeof raw === 'string' && isTuiAgent(raw.trim().toLowerCase())
      ? raw.trim().toLowerCase()
      : undefined,
  z.custom<TuiAgent>(isTuiAgent).optional()
)

const continueTaskActionSchema = z.object({
  key: actionKeySchema,
  type: z.literal('continue_task'),
  taskId: z.string().trim().min(1),
  instruction: z.string().trim().min(1),
  /** 用户点名换 agent 时可带（§执行失败兜底）：裁决层把它转成对原行的重派。 */
  agent: normalizeAgentSuggestion
})

const createTaskActionSchema = z.object({
  key: actionKeySchema,
  type: z.literal('create_task'),
  instruction: z.string().trim().min(1),
  agent: normalizeAgentSuggestion,
  /** 确需原型或计划时请求现有规划模板；模型只分类，阶段链由 Orca 注册。 */
  planning: z.boolean().optional(),
  prototype: z.boolean().optional(),
  clarification: z.boolean().optional()
})

/** 控制动作：对该任务正在进行的执行做直接会话操作（中断），不向会话投递任何文本。 */
const controlTaskActionSchema = z.object({
  key: actionKeySchema,
  type: z.literal('control_task'),
  taskId: z.string().trim().min(1),
  operation: z.literal('interrupt'),
  reason: z.string().trim().min(1).optional()
})

const clarifyActionSchema = z.object({
  key: actionKeySchema,
  type: z.literal('clarify'),
  question: z.string().trim().min(1),
  taskId: z.string().trim().min(1).optional(),
  about: z.string().trim().optional()
})

const noActionSchema = z.object({
  key: actionKeySchema,
  type: z.literal('no_action'),
  reason: z.string().trim().min(1)
})

const replyActionSchema = z.object({
  key: actionKeySchema,
  type: z.literal('reply'),
  text: z.string().trim().min(1)
})

const routeActionSchema = z.discriminatedUnion('type', [
  queryStatusActionSchema,
  continueTaskActionSchema,
  createTaskActionSchema,
  controlTaskActionSchema,
  clarifyActionSchema,
  noActionSchema,
  replyActionSchema
])

export const routeProposalSchema = z.object({
  version: z.literal(ROUTE_PROPOSAL_VERSION),
  actions: z.array(routeActionSchema).min(1).max(8)
})

export type RouteActionV1 = z.infer<typeof routeActionSchema>
export type RouteProposalV1 = z.infer<typeof routeProposalSchema>

/** 结构性错误：无法解析、版本未知或字段校验失败——入口保持可重试的待路由状态。 */
export class RouteProposalFormatError extends Error {}

export function parseRouteProposal(raw: unknown): RouteProposalV1 {
  const parsed = routeProposalSchema.safeParse(raw)
  if (!parsed.success) {
    throw new RouteProposalFormatError(
      `the route proposal is not a valid v1 action batch: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}`
    )
  }
  const { actions } = parsed.data
  if (actions.some((action) => action.type === 'no_action') && actions.length > 1) {
    throw new RouteProposalFormatError('no_action must be the only action in a proposal')
  }
  if (actions.filter((action) => action.type === 'reply').length > 1) {
    throw new RouteProposalFormatError('at most one reply action is allowed in a proposal')
  }
  if (new Set(actions.map((action) => action.key)).size !== actions.length) {
    throw new RouteProposalFormatError('action keys must be unique within a proposal')
  }
  return parsed.data
}

/** Models fence JSON even when told not to; the outermost object is the reply. */
export function parseRouteProposalContent(content: string): RouteProposalV1 {
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new RouteProposalFormatError('the route source replied without a JSON object')
  }
  let body: unknown
  try {
    body = JSON.parse(content.slice(start, end + 1))
  } catch (error) {
    throw new RouteProposalFormatError(
      `the route source replied with invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  return parseRouteProposal(body)
}
