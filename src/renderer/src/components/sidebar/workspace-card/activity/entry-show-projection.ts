import { z } from 'zod'
import {
  decisionReasonOf,
  entryClarificationsOf,
  entryQueryAnswersOf,
  entryRepliesOf,
  firstActionSummaryOf,
  parseDependsOn,
  taskReferencesOf
} from './entry-ledger-parsers'
import { pendingAskSchema, answeredAskSchema } from './entry-question-records'
import type {
  RoutingEntryDelivery,
  RoutingEntryInput,
  RoutingEntrySubAction
} from './routing-entry-model'

// orchestration.entryShow / entryReviewShow 的 wire 投影：入口读路径唯一的 schema 与
// 视图模型映射。领域类型（RoutingEntry*）仍以 routing-entry-model 为单一导入面。

const attemptSchema = z.object({
  // The ledger CHECK constrains outcomes to exactly these three (migrate-v49's outcome enum).
  attempt_id: z.string().optional(),
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
  worktreeId: z.string().nullable().optional(),
  readOnly: z.boolean().nullable().optional(),
  terminalHandle: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  failureAt: z.string().nullable().optional(),
  status: z.enum(['pending', 'dispatched', 'completed', 'failed', 'circuit_broken', 'attention']),
  result: z.string().nullable(),
  failure: z.string().nullable()
})

export type RoutingEntryExecution = z.infer<typeof entryExecutionSchema>

export const entryShowResultSchema = z.object({
  inputs: z.array(
    z.object({
      canDelete: z.boolean().optional(),
      canDeleteFailed: z.boolean().optional(),
      input: z.object({
        input_id: z.string(),
        entry_error: z.string().nullish(),
        received_seq: z.number(),
        decision_status: z.string(),
        raw_text: z.string(),
        created_at: z.string().optional(),
        decision_json: z.string().nullable().optional(),
        loop_dev: z.number().optional()
      }),
      subActions: z.array(
        z.object({
          canDelete: z.boolean().optional(),
          assignmentFailed: z.boolean().optional(),
          // plan 阶段的 orca-plan 解析失败标记（entry-results 包装层派生，仿 assignmentFailed）。
          planUnusable: z.boolean().optional(),
          planParseError: z.string().nullable().optional(),
          // 已解析成功的计划 stages（门卡"查看计划"的数据源）。
          planStages: z
            .array(
              z.object({
                title: z.string(),
                spec: z.string(),
                agent: z.string().optional()
              })
            )
            .nullable()
            .optional(),
          // merge 检查点行（§8）：泵执行 git 合并后的结算戳与收据。
          mergedAt: z.string().nullable().optional(),
          mergeReceipt: z
            .object({ commitSha: z.string().nullable(), baseBranch: z.string() })
            .nullable()
            .optional(),
          pendingAsk: pendingAskSchema.nullish(),
          pendingAsks: z.array(pendingAskSchema).optional(),
          answeredAsks: z.array(answeredAskSchema).nullish(),
          subAction: z.object({
            sub_action_id: z.string(),
            created_at: z.string().optional(),
            seq: z.number().int().positive().optional(),
            entry_error: z.string().nullish(),
            text: z.string(),
            task_id: z.string().nullable(),
            state: z.enum([
              'registered',
              'delivered',
              'processed',
              'violated',
              'pending_verification'
            ]),
            claimed_dispatch_id: z.string().nullable(),
            paused_at: z.string().nullable().optional(),
            queued_at: z.string().nullable().optional(),
            stage_kind: z
              .enum(['clarification', 'prototype', 'plan', 'implement', 'merge'])
              .nullable()
              .optional(),
            depends_on_json: z.string().nullable().optional(),
            gate: z.enum(['auto', 'user_confirm']).nullable().optional(),
            gate_granted_at: z.string().nullable().optional(),
            agent_hint: z.string().nullable().optional()
          }),
          execution: entryExecutionSchema.nullish(),
          deliveries: z.array(
            z.object({
              supplement: z.object({
                supplement_id: z.string(),
                target_dispatch_id: z.string(),
                raw_text: z.string(),
                created_at: z.string().optional()
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
  canAccept: z.boolean().optional(),
  issue: z.string().nullable().optional(),
  opinions: z.array(
    z.object({
      opinion_id: z.string(),
      body: z.string(),
      state: z.enum(['blocked', 'resolved'])
    })
  )
})

export type RoutingReviewState = z.infer<typeof entryReviewResultSchema>

export function toEntryInputs(result: Pick<EntryShowResult, 'inputs'>): RoutingEntryInput[] {
  return result.inputs.map((entry) => {
    const recordedReferences = taskReferencesOf(entry.input.decision_json)
    const taskReferences = recordedReferences
      ? entry.subActions.map(
          ({ subAction }, index) => recordedReferences[(subAction.seq ?? index + 1) - 1] ?? null
        )
      : undefined
    return {
      inputId: entry.input.input_id,
      text: entry.input.raw_text,
      canDelete: entry.canDelete,
      canDeleteFailed: entry.canDeleteFailed,
      routingError: entry.input.entry_error ?? undefined,
      decisionStatus:
        entry.input.decision_status === 'decided' ? ('decided' as const) : ('received' as const),
      receivedAt: entry.input.created_at,
      loopDev: entry.input.loop_dev === 1,
      decisionReason: decisionReasonOf(entry.input.decision_json),
      taskReferences,
      clarifications: entryClarificationsOf(entry.input.decision_json),
      replies: entryRepliesOf(entry.input.decision_json),
      queryAnswers: entryQueryAnswersOf(entry.input.decision_json),
      subActions: entry.subActions.map((subAction, index) => {
        const deliveries = subAction.deliveries
          .map<RoutingEntryDelivery>(({ supplement, attempts }) => ({
            supplementId: supplement.supplement_id,
            text: supplement.raw_text,
            targetDispatchId: supplement.target_dispatch_id,
            createdAt: supplement.created_at ?? '',
            attempts: attempts
              .map((attempt) => ({
                attemptId: attempt.attempt_id,
                outcome: attempt.outcome,
                createdAt: attempt.created_at,
                refusalKind: attempt.refusal_kind ?? undefined,
                turnId: attempt.turn_id ?? undefined,
                firstActionSummary: firstActionSummaryOf(attempt.first_action_json)
              }))
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          }))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        const lastDelivery = deliveries.at(-1)
        const lastAttempt = lastDelivery?.attempts.at(-1)
        const subActionRow: RoutingEntrySubAction = {
          subActionId: subAction.subAction.sub_action_id,
          text: subAction.subAction.text,
          createdAt: subAction.subAction.created_at,
          canDelete: subAction.canDelete,
          assignmentFailed: subAction.assignmentFailed,
          assignmentError: subAction.subAction.entry_error ?? undefined,
          state: subAction.subAction.state,
          taskId: subAction.subAction.task_id ?? undefined,
          stageKind: subAction.subAction.stage_kind ?? undefined,
          dependsOn: parseDependsOn(subAction.subAction.depends_on_json),
          gate: subAction.subAction.gate ?? undefined,
          gateGrantedAt: subAction.subAction.gate_granted_at ?? undefined,
          planUnusable: subAction.planUnusable ?? undefined,
          planParseError: subAction.planParseError ?? undefined,
          planStages: subAction.planStages ?? undefined,
          mergedAt: subAction.mergedAt ?? undefined,
          mergeReceipt: subAction.mergeReceipt ?? undefined,
          agentHint: subAction.subAction.agent_hint ?? undefined,
          pendingAsks:
            subAction.pendingAsks ?? (subAction.pendingAsk ? [subAction.pendingAsk] : undefined),
          answeredAsks: subAction.answeredAsks ?? undefined,
          resumed: (taskReferences ?? [])[index] != null,
          pausedAt: subAction.subAction.paused_at ?? undefined,
          queuedAt: subAction.subAction.queued_at ?? undefined,
          execution: subAction.execution
            ? {
                ...subAction.execution,
                worktreeId: subAction.execution.worktreeId ?? undefined,
                readOnly: subAction.execution.readOnly ?? undefined,
                terminalHandle: subAction.execution.terminalHandle ?? undefined,
                sessionId: subAction.execution.sessionId ?? undefined,
                completedAt: subAction.execution.completedAt ?? undefined
              }
            : undefined,
          claimedBy: subAction.subAction.claimed_dispatch_id ?? undefined,
          refusalKind: lastAttempt?.refusalKind,
          firstActionSummary: lastAttempt?.firstActionSummary,
          deliveries,
          lastSupplementText: lastDelivery?.text,
          lastTargetDispatchId: lastDelivery?.targetDispatchId
        }
        return subActionRow
      })
    }
  })
}
