import { z } from 'zod'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  entryReviewResultSchema,
  entryShowResultSchema,
  toEntryInputs
} from './entry-show-projection'
import type { RoutingReviewState } from './routing-entry-model'

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
      createdAt: z.string().optional(),
      dispatchId: z.string(),
      workerHandle: z.string(),
      title: z.string(),
      detail: z.string().nullable(),
      reason: z.string().nullable(),
      personOnly: z.boolean(),
      interrupted: z.boolean().optional()
    })
  )
})

export type RoutingEntryApproval = z.infer<typeof entryApprovalsSchema>['approvals'][number]

export type EntryRoutingResult = { routed: boolean; reason?: string; dispatchErrors?: string[] }

const entryPeekResultSchema = entryShowResultSchema.pick({ inputs: true })

export async function peekEntryInputs(target: RuntimeClientTarget, group: string) {
  return toEntryInputs(
    entryPeekResultSchema.parse(await callRuntimeRpc(target, 'orchestration.entryPeek', { group }))
  )
}

export async function entryApprovals(target: RuntimeClientTarget, group: string): Promise<unknown> {
  return callRuntimeRpc(target, 'orchestration.entryApprovals', { group })
}

export const entryWorkersSchema = z.object({
  workers: z.array(
    z.object({
      dispatchId: z.string(),
      handle: z.string(),
      worktreeId: z.string().nullable().optional(),
      agent: z.string().nullable().optional(),
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
