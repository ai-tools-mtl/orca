import { z } from 'zod'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { RoutingEntryInput, RoutingEntrySubAction } from './RoutingEntryCard'

export type { RoutingEntryInput }

const attemptSchema = z.object({
  // The ledger CHECK constrains outcomes to exactly these three (migrate-v49's outcome enum).
  outcome: z.enum(['delivered', 'refused', 'unverified']),
  refusal_kind: z.string().nullable(),
  first_action_json: z.string().nullable(),
  created_at: z.string(),
  expected_turn_id: z.string().nullable(),
  turn_id: z.string().nullable()
})

const entryExecutionSchema = z.object({
  agent: z.string().nullable(),
  dispatchId: z.string(),
  status: z.enum(['pending', 'dispatched', 'completed', 'failed', 'circuit_broken', 'attention']),
  result: z.string().nullable(),
  failure: z.string().nullable()
})

export type RoutingEntryExecution = z.infer<typeof entryExecutionSchema>

export const entryShowResultSchema = z.object({
  inputs: z.array(
    z.object({
      input: z.object({
        input_id: z.string(),
        received_seq: z.number(),
        decision_status: z.string(),
        raw_text: z.string()
      }),
      subActions: z.array(
        z.object({
          subAction: z.object({
            sub_action_id: z.string(),
            text: z.string(),
            task_id: z.string().nullable(),
            state: z.enum([
              'registered',
              'delivered',
              'processed',
              'violated',
              'pending_verification'
            ]),
            claimed_dispatch_id: z.string().nullable()
          }),
          execution: entryExecutionSchema.nullish(),
          deliveries: z.array(
            z.object({
              supplement: z.object({
                supplement_id: z.string(),
                target_dispatch_id: z.string(),
                raw_text: z.string()
              }),
              attempts: z.array(attemptSchema)
            })
          )
        })
      )
    })
  ),
  watchdog: z.object({ paused: z.boolean() })
})

type EntryShowResult = z.infer<typeof entryShowResultSchema>

const reviewCycleSchema = z.object({
  cycle_id: z.string(),
  current_revision: z.number(),
  state: z.enum(['reviewing', 'rework', 'accepted']),
  writer_dispatch_id: z.string(),
  reviewer_dispatch_id: z.string()
})

export const entryReviewResultSchema = z.object({
  cycle: reviewCycleSchema.nullable(),
  opinions: z.array(
    z.object({
      opinion_id: z.string(),
      body: z.string(),
      state: z.enum(['blocked', 'resolved'])
    })
  )
})

export type RoutingReviewState = z.infer<typeof entryReviewResultSchema>

const firstActionEvidenceSchema = z.object({
  verdict: z.string(),
  reason: z.string().optional(),
  firstAction: z
    .object({ name: z.string().optional(), path: z.string().optional() })
    .partial()
    .optional()
})

function firstActionSummaryOf(rawEvidence: string | null): string | undefined {
  if (!rawEvidence) {
    return undefined
  }
  const parsed = firstActionEvidenceSchema.safeParse(JSON.parse(rawEvidence))
  if (!parsed.success) {
    return undefined
  }
  if (parsed.data.reason !== undefined) {
    return parsed.data.reason
  }
  const action = parsed.data.firstAction
  if (!action) {
    return undefined
  }
  return translate(
    'auto.components.sidebar.RoutingEntryCard.firstAction',
    'First action {{name}} {{path}}',
    { name: action.name ?? '', path: action.path ?? '' }
  ).trim()
}

export function toEntryInputs(result: EntryShowResult): RoutingEntryInput[] {
  return result.inputs.map((entry) => ({
    inputId: entry.input.input_id,
    text: entry.input.raw_text,
    decisionStatus:
      entry.input.decision_status === 'decided' ? ('decided' as const) : ('received' as const),
    subActions: entry.subActions.map((subAction) => {
      const history = subAction.deliveries
        .flatMap((delivery) =>
          delivery.attempts.map((attempt) => ({
            outcome: attempt.outcome,
            createdAt: attempt.created_at,
            refusalKind: attempt.refusal_kind ?? undefined,
            turnId: attempt.turn_id ?? undefined,
            expectedTurnId: attempt.expected_turn_id ?? undefined,
            firstActionSummary: firstActionSummaryOf(attempt.first_action_json),
            targetDispatchId: delivery.supplement.target_dispatch_id,
            supplementText: delivery.supplement.raw_text
          }))
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      const last = history.at(-1)
      const subActionRow: RoutingEntrySubAction = {
        subActionId: subAction.subAction.sub_action_id,
        text: subAction.subAction.text,
        state: subAction.subAction.state,
        taskId: subAction.subAction.task_id ?? undefined,
        execution: subAction.execution ?? undefined,
        claimedBy: subAction.subAction.claimed_dispatch_id ?? undefined,
        refusalKind: last?.refusalKind,
        firstActionSummary: last?.firstActionSummary,
        history,
        lastSupplementText: last?.supplementText,
        lastTargetDispatchId: last?.targetDispatchId
      }
      return subActionRow
    })
  }))
}

export async function entryReview(
  target: RuntimeClientTarget,
  group: string,
  task: string
): Promise<unknown> {
  return callRuntimeRpc(target, 'orchestration.entryReviewShow', { group, task })
}

export const entryApprovalsSchema = z.object({
  approvals: z.array(
    z.object({
      approvalId: z.string(),
      dispatchId: z.string(),
      workerHandle: z.string(),
      title: z.string(),
      detail: z.string().nullable(),
      reason: z.string().nullable(),
      personOnly: z.boolean()
    })
  )
})

export type RoutingEntryApproval = z.infer<typeof entryApprovalsSchema>['approvals'][number]

export type EntryRoutingResult = { routed: boolean; reason?: string; dispatchErrors?: string[] }

export async function entryApprovals(target: RuntimeClientTarget, group: string): Promise<unknown> {
  return callRuntimeRpc(target, 'orchestration.entryApprovals', { group })
}

export const entryWorkersSchema = z.object({
  workers: z.array(
    z.object({
      dispatchId: z.string(),
      handle: z.string(),
      workerState: z.string(),
      dispatchStatus: z.string(),
      pendingApproval: z.boolean()
    })
  )
})

export type RoutingEntryWorker = z.infer<typeof entryWorkersSchema>['workers'][number]

export async function entryWorkers(
  target: RuntimeClientTarget,
  group: string
): Promise<RoutingEntryWorker[]> {
  const result = entryWorkersSchema.parse(
    await callRuntimeRpc(target, 'orchestration.entryWorkers', { group })
  )
  return result.workers
}

export async function readEntrySnapshot(target: RuntimeClientTarget, group: string) {
  const show = entryShowResultSchema.parse(
    await callRuntimeRpc<unknown>(target, 'orchestration.entryShow', { group })
  )
  const taskIds = new Set(
    show.inputs.flatMap((entry) => entry.subActions).map((entry) => entry.subAction.task_id)
  )
  const reviews = new Map<string, RoutingReviewState>()
  taskIds.delete(null)
  const [approvals] = await Promise.all([
    entryApprovals(target, group).then((result) => entryApprovalsSchema.parse(result).approvals),
    Promise.allSettled(
      [...taskIds].map(async (taskId) => {
        if (taskId) {
          reviews.set(
            taskId,
            entryReviewResultSchema.parse(await entryReview(target, group, taskId))
          )
        }
      })
    )
  ])
  return { inputs: toEntryInputs(show), paused: show.watchdog.paused, reviews, approvals }
}

/** Auto-route through the model provider, with the settings-configured decision model. */
export async function routeViaModel(
  target: RuntimeClientTarget,
  group: string,
  inputId: string,
  dispatch: boolean
): Promise<EntryRoutingResult> {
  const decisionModel = useAppStore.getState().settings?.decisionModel
  return callRuntimeRpc<EntryRoutingResult>(
    target,
    'orchestration.entryAutoRoute',
    {
      group,
      input: inputId,
      dispatch,
      ...(decisionModel ? { decisionModel } : {})
    },
    { timeoutMs: 120_000 }
  )
}
