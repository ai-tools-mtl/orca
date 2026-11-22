import { requireEntryPerson } from './access/entry-person-access'
import { defineOrchestrationMethod } from './access/orchestration-method-access'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { deliverQuestionAnswer } from '../../../orchestration/mailbox/questions/question-answer-delivery'
import {
  EntryAnswerAskParams,
  EntryGateGrantParams,
  EntryGateRejectParams
} from '../../../../../shared/rpc-contract/orchestration/orchestration-routing-params'
import { entryRunOfInput, coordinatedEntryRun } from './entry-run-scope'
import { pumpEntryAutomations } from './entry-automation-pump'
import { continueUnreadWorkerMail } from './messaging/settled-worker-follow-through'
import { markUnreadFollowUpMail } from '../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { createHash } from 'node:crypto'

// The entry's stage gates (entry-stage-pipeline-plan §7): the user grants a 规划/合并 stage's
// output on its card; a plan grant expands the orca-plan into the implement chain in the same
// transaction, and the pump dispatches whatever became eligible.

export const ORCHESTRATION_ENTRY_STAGE_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.entryGateGrant',
    permission: 'workspace',
    params: EntryGateGrantParams,
    access: { kind: 'writes', targets: {} },
    handler: async ({ group, subAction }, ctx) => {
      requireEntryPerson(ctx)
      const { runtime } = ctx
      const db = runtime.getOrchestrationDb()
      const row = db.getSubAction(subAction)
      if (!row) {
        throw new OrchestrationError(
          'lifecycle_not_found',
          `Sub-action ${subAction} was not found.`,
          { subActionId: subAction }
        )
      }
      if (!row.gate) {
        throw new OrchestrationError(
          'invalid_argument',
          `Sub-action ${subAction} has no user gate.`,
          { subActionId: subAction }
        )
      }
      const run = entryRunOfInput(db, group, row.input_id)
      const grant = db.grantRoutingStageGate(subAction)
      // Dispatch whatever this grant unlocked (the next stage, or the expanded chain head).
      await pumpEntryAutomations({ runtime, run, group })
      return {
        subAction: grant.subAction,
        expanded: grant.expanded.map((action) => ({
          subActionId: action.sub_action_id,
          title: action.text,
          agentHint: action.agent_hint
        }))
      }
    }
  }),
  // 门等待期的驳回修改：门保持未放行（事实落账），修改要求作为未读邮件挂到该阶段 worker 的
  // Dispatch，由续接机制重开同会话投递——worker 在原 worktree 返工后重新汇报，卡片回到等待确认。
  // 内容寻址的邮件 id 让同一文本的重放幂等；不同文本是新一轮驳回。
  defineOrchestrationMethod({
    name: 'orchestration.entryGateReject',
    permission: 'workspace',
    params: EntryGateRejectParams,
    access: { kind: 'writes', targets: {} },
    handler: async ({ group, subAction, text }, ctx) => {
      requireEntryPerson(ctx)
      const { runtime } = ctx
      const db = runtime.getOrchestrationDb()
      const row = db.getSubAction(subAction)
      if (!row) {
        throw new OrchestrationError(
          'lifecycle_not_found',
          `Sub-action ${subAction} was not found.`,
          { subActionId: subAction }
        )
      }
      if (row.gate !== 'user_confirm') {
        throw new OrchestrationError(
          'invalid_argument',
          `Sub-action ${subAction} has no user gate to reject.`,
          { subActionId: subAction }
        )
      }
      if (row.gate_granted_at) {
        throw new OrchestrationError(
          'lifecycle_conflict',
          `Sub-action ${subAction} was already confirmed; send a new request instead.`,
          { subActionId: subAction }
        )
      }
      if (
        row.stage_kind !== 'merge' &&
        (!row.task_id || db.getTask(row.task_id)?.status !== 'completed')
      ) {
        throw new OrchestrationError(
          'lifecycle_conflict',
          'The stage has not completed, so there is nothing to reject yet.'
        )
      }
      const dispatch = row.task_id ? db.getDispatchContext(row.task_id) : undefined
      if (!dispatch || dispatch.run_id !== row.run_id) {
        throw new OrchestrationError('dispatch_not_found', 'The stage has no worker dispatch here.')
      }
      if (db.isRoutingRunPaused(row.run_id) || db.isRoutingSubActionPaused(subAction)) {
        throw new OrchestrationError(
          'paused',
          'Resume the entry and the task card before rejecting.'
        )
      }
      const run = entryRunOfInput(db, group, row.input_id)
      const id = `msg_reject_${createHash('sha256')
        .update(JSON.stringify([dispatch.id, subAction, text]))
        .digest('hex')
        .slice(0, 24)}`
      if (!db.getMessageById(id)) {
        db.insertMessage({
          id,
          from: `run:${run.id}`,
          to: `dispatch:${dispatch.id}`,
          subject: `驳回修改：${row.text.slice(0, 60)}`,
          body: text,
          runId: run.id,
          type: 'status'
        })
        markUnreadFollowUpMail(db, dispatch.id)
        continueUnreadWorkerMail(runtime, db, dispatch.id)
      }
      return { subAction, dispatchId: dispatch.id, mailMessageId: id }
    }
  }),
  // worker 的 ask（§2）：入口呈现提问并回答——回答邮件投回 worker 的 Dispatch，唤醒等待中
  // 的阶段。答案走运行时的 ask/reply 账本（answerQuestion），重复回答幂等拒绝；落账后必须
  // 走 deliverQuestionAnswer 的唤醒（orchestration.reply 的同款语义）——只落账不投递，worker
  // 会在 ask 等待里永远停着（2026-11-21 澄清卡死案例：答案躺邮箱 delivered_at 为空）。
  defineOrchestrationMethod({
    name: 'orchestration.entryAnswerAsk',
    permission: 'workspace',
    params: EntryAnswerAskParams,
    access: { kind: 'writes', targets: {} },
    handler: ({ group, message, body }, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const run = coordinatedEntryRun(db, group).run
      const answered = db.answerQuestion({
        messageId: message,
        runId: run.id,
        body,
        consumerGeneration: run.consumer_generation
      })
      deliverQuestionAnswer(runtime, {
        message_id: message,
        dispatch_id: answered.question.dispatch_id
      })
      return { answered: answered.question }
    }
  })
]
