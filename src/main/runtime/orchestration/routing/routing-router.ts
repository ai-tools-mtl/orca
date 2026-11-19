import { OrchestrationError } from '../orchestration-error'
import type { OrchestrationDb } from '../db/orchestration-db'
import type { TaskRow } from '../db/orchestration-records'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'

// Plan §5.1: the Router is a restricted decision step over a persistent input — never a general
// agent. The decision provider is a seam: Orca prepares the context (current message, source
// reference, candidate task summaries, executor capabilities), the provider proposes zero or
// more sub-actions, Orca validates and registers them atomically. The identity provider defers
// everything to manual assignment; model-backed providers plug into the same seam later.

export type RoutingDecisionProposal = {
  subActions: { text: string; constraints?: string[]; taskId?: string | null; agent?: TuiAgent }[]
  decision?: unknown
  /** Recorded when nothing needs to happen (§5.1: 无需处理时记录原因，子动作列表为空). */
  reason?: string
}

export type RoutingDecisionContext = {
  inputId: string
  text: string
  candidateTasks: { taskId: string; spec: string; status: string }[]
  executorCapabilities: readonly string[]
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
  const candidateTasks: { taskId: string; spec: string; status: string }[] = db
    .listTasks({ runId: row.run_id })
    .map((task: TaskRow) => ({ taskId: task.id, spec: task.spec, status: task.status }))
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
  let proposal: RoutingDecisionProposal
  try {
    proposal = await withTimeout(
      provider({
        inputId: input.inputId,
        text: row.raw_text,
        candidateTasks,
        executorCapabilities: input.executorCapabilities ?? []
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
  for (const subAction of proposal.subActions) {
    if (
      subAction.taskId !== undefined &&
      subAction.taskId !== null &&
      !candidateIds.has(subAction.taskId)
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
    decision: {
      reason: proposal.reason ?? null,
      decision: proposal.decision ?? null,
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
