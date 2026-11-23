import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSourceControlAgent } from '../../../text-generation/execution/source-control-agent-launch'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { runGenerationRequest } from '../../../text-generation/agent-generation-request'
import { getCommitMessageAgentSpec } from '../../../../shared/source-control/ai/generation/commit-message-agent-spec'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { parseRouteProposalContent, type RouteProposalV1 } from './route-proposal'
import type { RoutingDecisionContext } from './routing-router'

// 统一 Router 的 Agent 实现（entry-intent-routing-design 首版）：一次调用让已接入的 Agent
// 产出整份 RouteProposalV1 动作批。每次路由尝试最多调用一次；状态答案、任务校验和授权都由
// Orca 裁决——模型不代答、不越界。传输层：zcode 走结构化宿主的一次 generateText，其余走
// 一次性 CLI。

/** The user-side content the route prompt sends: request, recent conversation turns, candidate
 *  tasks, capabilities, and the deterministic progress digest (§5.1) so status queries answer
 *  from Orca's ledger. Exported so the 专用决策模型旁路对照 sends the exact same split (fair
 *  comparison). */
export function routeUserContent(context: {
  text: string
  candidateTasks: { taskId: string; spec: string; status: string }[]
  executorCapabilities: readonly string[]
  statusDigest?: string
  recentTurns?: { text: string; outcome: string }[]
}): string {
  return [
    `请求：${context.text}`,
    ...(context.recentTurns && context.recentTurns.length > 0
      ? [
          `近期对话：${context.recentTurns
            .map((turn) => `「${turn.text}」→ ${turn.outcome}`)
            .join('；')}`
        ]
      : []),
    context.candidateTasks.length > 0
      ? `候选任务：${context.candidateTasks
          .map((task) => `${task.taskId}（${task.spec}，${task.status}）`)
          .join('；')}`
      : '候选任务：无',
    `执行者能力：${context.executorCapabilities.join('、') || '未声明'}`,
    ...(context.statusDigest ? [`当前进展：${context.statusDigest}`] : [])
  ].join('\n')
}

export const UNIFIED_ROUTE_SYSTEM_PROMPT = `You are the routing step of a work dispatcher. Read the request once and reply with ONLY one JSON object: {"version":1,"actions":[...]}. Every action carries a short unique "key" ("a1","a2",…). Action types:
{"key":"a1","type":"query_status","target":"project"} for an explicit project-wide progress overview, or "target":"<candidate taskId>" for one task's progress.
{"key":"a1","type":"continue_task","taskId":"<candidate taskId>","instruction":"..."} to add work to an existing task; the instruction is the supplement in the user's language. When the user asks to switch that task to another worker (e.g. after a failure), keep the task id and add "agent":"<agent id>" — Orca re-dispatches the task's own stage with that worker.
{"key":"a1","type":"create_task","instruction":"...","agent":"<agent id>","planning":false,"prototype":false,"clarification":false} for a new self-contained delivery: preserve every applicable user constraint in the instruction, and related sequential steps stay in ONE action with the order stated.
{"key":"a1","type":"control_task","taskId":"<candidate taskId>","operation":"interrupt","reason":"..."} when the user asks to pause/stop/interrupt/cancel an existing task's ongoing execution (暂停/停止/中断/取消正在跑的任务): Orca stops that task's session directly instead of messaging it. "reason" is a short label of what to stop, in the user's language. Never use it to add or change work — that is continue_task.
{"key":"a1","type":"clarify","question":"...","taskId":"<candidate id if known>"} when the request cannot be routed yet: ask one concrete question.
{"key":"a1","type":"no_action","reason":"..."} only when nothing needs doing; it must be the ONLY action.
{"key":"a1","type":"reply","text":"..."} for conversational messages — greetings, thanks, small talk, or general questions you can answer from 近期对话/候选任务/当前进展 alone. Answer concisely in the user's language, grounded ONLY in that context; say so briefly and name what to dispatch when the answer needs repository detail you were not given. At most one reply per batch; it may accompany work actions.
Rules: at most six actions and only fitting types; never answer a status query yourself — explicit progress questions use query_status because Orca answers from its ledger; resolve pronouns in follow-up messages (那/它/这个) with 近期对话 before routing; reference a candidate taskId only when the request clearly names that task, and when a continuation target is ambiguous propose one clarify for it instead of guessing while other independent work still gets its own actions; for a substantial build request (a requirements document, or a whole feature needing 原型设计/需求拆分/任务设计 before implementation) use create_task with planning=true (prototype=true when UI or interaction is worth prototyping first; clarification=true only when the scope must be clarified into a spec first) and keep the requirement self-contained in the instruction; suggest agent only when the user explicitly names a worker, normalized to its lowercase Orca id (Codex → codex, Claude Code → claude, DeepSeek Harness → dsh, ZCode → zcode), else omit it; write-restricted requests (e.g. 先调查，等我确认再改) keep that wording verbatim in the instruction — Orca enforces the authorization and the read-only gates.`

export function agentRouteProposalPrompt(context: RoutingDecisionContext): string {
  return [UNIFIED_ROUTE_SYSTEM_PROMPT, routeUserContent(context)].join('\n\n')
}

export function createAgentRouteProposalProvider(config: {
  agent: TuiAgent
  cwd: string
  agentCommandOverride?: string
  ensureStructuredHost?: () => Promise<void>
}): (context: RoutingDecisionContext) => Promise<RouteProposalV1> {
  return async (context: RoutingDecisionContext) => {
    const prompt = agentRouteProposalPrompt(context)
    if (config.agent === 'zcode') {
      const signal = AbortSignal.timeout(65_000)
      await config.ensureStructuredHost?.()
      const adapter = getStructuredAgentSessionHost()?.deps.adapter
      if (!adapter?.generateText) {
        throw new Error('Independent ZCode routing is unavailable on this host.')
      }
      const output = await adapter.generateText({
        agent: 'zcode',
        accountHome: {
          variable: 'ZCODE_HOME',
          path: process.env.ZCODE_HOME || join(homedir(), '.zcode')
        },
        prompt: `${prompt}\nReturn the routing JSON directly without using tools.`,
        purpose: 'routing',
        signal
      })
      if (!output) {
        throw new Error(
          signal.aborted
            ? 'ZCode routing timed out.'
            : 'ZCode returned no routing result. Check the ZCode account on this host.'
        )
      }
      return parseRouteProposalContent(output)
    }
    const spec = getCommitMessageAgentSpec(config.agent)
    if (!spec) {
      throw new Error(`Agent ${config.agent} does not support decision generation.`)
    }
    const result = await runGenerationRequest({
      params: {
        agentId: config.agent,
        model: spec.defaultModelId,
        ...(config.agentCommandOverride
          ? { agentCommandOverride: config.agentCommandOverride }
          : {})
      },
      prompt,
      target: { kind: 'local', cwd: config.cwd },
      operation: 'commit-message',
      spawnAgent: spawnSourceControlAgent
    })
    if (!result.success) {
      throw new Error(result.error)
    }
    return parseRouteProposalContent(result.rawOutput)
  }
}
