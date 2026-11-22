import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { AgentJournalApprovalItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import '../../../../orchestration/db/contract-constants'
import '../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../orchestration/db/dispatch-row-writer'
import '../../../../orchestration/db/attempt-outcome-projection'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import type { RoutingSubActionRow } from '../../../../orchestration/db/routing-records'
import { entrySubActionNeedsReadOnly } from '../../../../orchestration/routing/entry-write-policy'
import { approvalReportId } from '../../../../orchestration/workers/approvals/worker-approval-report'
import type { ChatWorkerPrompt } from '../../../../orchestration/workers/approvals/chat-worker-approval-prompt'

const chat = vi.hoisted(() => {
  const state: {
    custody: 'chat' | 'terminal' | 'unverifiable'
    answer: ReturnType<typeof vi.fn>
    prompt: ChatWorkerPrompt | null
  } = { custody: 'chat', answer: vi.fn(), prompt: null }
  return state
})

vi.mock('../../../../orchestration/mailbox/routing/structured-session-mail-target', () => ({
  structuredMailboxCustody: () =>
    chat.custody === 'chat'
      ? { sessionId: 'session-1', dispatchId: null }
      : chat.custody === 'terminal'
        ? 'elsewhere'
        : 'unverifiable'
}))
vi.mock(
  '../../../../orchestration/workers/approvals/chat-worker-approval-prompt',
  async (actual) => ({
    ...(await actual<object>()),
    answerChatWorkerApproval: chat.answer,
    readChatWorkerPrompt: async () => chat.prompt
  })
)

const detection = vi.hoisted(() => ({ installed: ['claude', 'codex', 'dsh'] as string[] }))
vi.mock('../../../../../preflight/workspace-agent-detection', () => ({
  detectAgentsOnHost: async () => detection.installed
}))

const { answerWorkerApproval } = await import('./worker-approval-answer')

const HANDLE = 'term_worker'

function item(resolvedBy: string | null): AgentJournalApprovalItem {
  return {
    kind: 'approval',
    title: 'Allow Bash?',
    detail: 'rm -rf build',
    options: [
      { id: 'allow', label: 'Allow', intent: 'allow_once' },
      { id: 'deny', label: 'Deny', intent: 'reject_once' }
    ],
    resolution: resolvedBy
      ? { state: 'resolved', selectedOptionId: 'allow', resolvedBy, resolvedAt: 2 }
      : { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
}

function setup(approvalId: string, entry = false) {
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'approvals',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: makePaneKey('tab-coordinator', '22222222-2222-4222-8222-222222222222')
  })
  const task = db.createTask({ spec: 'do the work', runId: run.id })
  const dispatch = createRootDispatch(db, task.id, HANDLE)
  if (entry) {
    // A dispatched read-only codex worker on a write-gated entry sub-action (方向 2 handoff seat).
    db.db
      .prepare(
        `UPDATE dispatch_contexts SET status = 'dispatched', assignee_orca_session_id = 'sess_worker' WHERE id = ?`
      )
      .run(dispatch.id)
    db.db
      .prepare(
        `INSERT INTO worker_dispatches (dispatch_id, runtime_epoch, state, stage, start_options)
         VALUES (?, NULL, 'starting', 'accepted', ?)`
      )
      .run(dispatch.id, JSON.stringify({ readOnly: true, agent: 'codex' }))
    const input = db.registerRoutingInput({
      runId: run.id,
      text: '只读调查仓库并给出原型方案，写入前需我批准'
    })
    db.db
      .prepare(
        `INSERT INTO routing_sub_actions
           (sub_action_id, input_id, run_id, seq, text, constraints_json, task_id,
            stage_kind, depends_on_json, gate, agent_hint)
         VALUES ('sa-1-1', ?, ?, 1, '只读调查仓库现状', '[]', ?, NULL, NULL, NULL, 'dsh')`
      )
      .run(input.input_id, run.id, task.id)
  }
  // The escalation Orca's stop report stored for this approval.
  db.insertMessage({
    id: approvalReportId(dispatch.id, approvalId, 'open'),
    from: HANDLE,
    to: `run:${run.id}`,
    subject: 'Worker is waiting for permission',
    type: 'escalation',
    payload: JSON.stringify({
      approval: {
        v: 1,
        approvalId,
        state: 'open',
        worker: { handle: HANDLE, dispatchId: dispatch.id, taskId: dispatch.task_id },
        summary: { title: 'Allow Bash?', detail: 'rm -rf build', reason: null },
        allowedActions: ['allow', 'deny']
      }
    }),
    runId: run.id
  })
  const terminalAnswer = vi.fn(async () => ({
    ok: false as const,
    code: 'approval_not_open' as const,
    message: 'gone'
  }))
  const runtime = {
    getOrchestrationDb: () => db,
    notifyMessageArrived: vi.fn(),
    // Auto 默认（设置未显式选择）：解析走 pickTuiAgent 的目录顺序，本机检测含 claude。
    requireStore: () => ({
      getSettings: () => ({ defaultTuiAgent: null, disabledTuiAgents: [], agentCmdOverrides: {} })
    }),
    terminalWorkerApprovals: { answer: terminalAnswer, isHeld: () => false }
  }
  const call = (decision: 'allow' | 'deny', access: Parameters<typeof answerWorkerApproval>[2]) =>
    answerWorkerApproval(
      { dispatch: dispatch.id, prompt: approvalId, decision },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these runtime members.
      { runtime: runtime as never },
      access
    )
  const closings = () =>
    db
      .getUnreadRunMailbox(run.id, 100)
      .filter((message) => message.subject.startsWith('Worker approval '))
      .map((message) => message.body)
  const mailToWorker = () =>
    z
      .object({ body: z.string() })
      .array()
      .parse(
        db.db
          .prepare(`SELECT body FROM messages WHERE to_handle = ?`)
          .all(`dispatch:${dispatch.id}`)
      )
  return { call, closings, mailToWorker, db, run, dispatch }
}

const person = { answeredBy: 'person' as const, reason: 'Denied by the owner.' }
const coordinator = { answeredBy: 'coordinator' as const, reason: 'Use a script file.' }

describe('answering a worker approval', () => {
  it("closes a chat worker's card at once when its own chat already answered it", async () => {
    chat.custody = 'chat'
    chat.answer.mockResolvedValue({ ok: false, code: 'approval_not_open', message: 'gone' })
    chat.prompt = { revision: 2, body: item('desktop-renderer') }
    const ctx = setup('item_1')

    await expect(ctx.call('allow', person)).rejects.toMatchObject({ code: 'approval_not_open' })
    await expect(ctx.call('allow', person)).rejects.toMatchObject({ code: 'approval_not_open' })
    expect(ctx.closings()).toEqual([
      expect.stringContaining("Allowed in the worker's own chat: approval item_1")
    ])
  })

  it("mails a deny reason to a chat worker only when it is the coordinator's", async () => {
    chat.custody = 'chat'
    chat.answer.mockResolvedValue({
      ok: true,
      prompt: { revision: 2, body: item('trusted-local:orchestration:approval:x') },
      optionLabel: 'Deny'
    })
    const byPerson = setup('item_1')
    await byPerson.call('deny', person)
    expect(byPerson.mailToWorker()).toEqual([])

    const byCoordinator = setup('item_1')
    await byCoordinator.call('deny', coordinator)
    expect(byCoordinator.mailToWorker()).toEqual([{ body: 'Use a script file.' }])
  })

  it('hands an allowed entry write approval to a fresh worker, declining the read-only session', async () => {
    chat.custody = 'chat'
    const approvalId = 'orca:codex-prompt%3Athread-1%3A7'
    chat.answer.mockResolvedValue({
      ok: true,
      prompt: { revision: 3, body: item(null) },
      optionLabel: 'Decline'
    })
    const ctx = setup(approvalId, true)

    const receipt = await ctx.call('allow', person)
    expect(receipt).toMatchObject({ decision: 'allow', option: 'Decline' })
    expect(chat.answer).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'deny', stopOnDeny: false })
    )

    // The write stage is minted once, chained on the investigation card, granted and hinted.
    const db = ctx.db
    const handoff = db.db
      .prepare(`SELECT * FROM routing_sub_actions WHERE write_granted_at IS NOT NULL`)
      .all() as RoutingSubActionRow[]
    expect(handoff).toHaveLength(1)
    expect(handoff[0]).toMatchObject({
      stage_kind: 'implement',
      gate: 'auto',
      agent_hint: 'dsh',
      depends_on_json: '["sa-1-1"]'
    })
    expect(entrySubActionNeedsReadOnly(db, handoff[0] as RoutingSubActionRow)).toBe(false)
    const investigation = db.getSubAction('sa-1-1')
    expect(investigation && entrySubActionNeedsReadOnly(db, investigation)).toBe(true)

    // The read-only worker is told to wrap up; the card closes as allowed-with-handoff.
    expect(ctx.mailToWorker().map((mail) => mail.body)).toHaveLength(1)
    expect(ctx.mailToWorker()[0]?.body).toContain('follow-up worker')
    expect(ctx.closings().join('\n')).toContain('handed to a follow-up worker')

    // A second allowed prompt of the same worker reuses the stage instead of minting a twin.
    chat.answer.mockResolvedValue({
      ok: true,
      prompt: { revision: 4, body: item(null) },
      optionLabel: 'Decline'
    })
    await ctx.call('allow', person)
    expect(
      db.db
        .prepare(`SELECT COUNT(*) AS n FROM routing_sub_actions WHERE write_granted_at IS NOT NULL`)
        .get()
    ).toMatchObject({ n: 1 })
  })

  it('keeps the write in-session when the investigating worker already is the intended agent', async () => {
    chat.custody = 'chat'
    const approvalId = 'orca:codex-prompt%3Athread-1%3A8'
    chat.answer.mockResolvedValue({
      ok: true,
      prompt: { revision: 3, body: item(null) },
      optionLabel: 'Allow'
    })
    const ctx = setup(approvalId, true)
    // 任务接续：提案 agent 就是 codex（与实际派发一致）——Allow 回答原 prompt，不转派。
    ctx.db.db
      .prepare(`UPDATE routing_sub_actions SET agent_hint = 'codex' WHERE sub_action_id = 'sa-1-1'`)
      .run()

    const receipt = await ctx.call('allow', person)
    expect(receipt.decision).toBe('allow')
    expect(chat.answer).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'allow', stopOnDeny: false })
    )
    expect(
      ctx.db.db
        .prepare(`SELECT COUNT(*) AS n FROM routing_sub_actions WHERE write_granted_at IS NOT NULL`)
        .get()
    ).toMatchObject({ n: 0 })
    expect(ctx.mailToWorker()).toEqual([])
  })

  it('hands off to the host default agent when no hint was proposed', async () => {
    chat.custody = 'chat'
    const approvalId = 'orca:codex-prompt%3Athread-1%3A9'
    chat.answer.mockResolvedValue({
      ok: true,
      prompt: { revision: 3, body: item(null) },
      optionLabel: 'Decline'
    })
    const ctx = setup(approvalId, true)
    ctx.db.db
      .prepare(`UPDATE routing_sub_actions SET agent_hint = NULL WHERE sub_action_id = 'sa-1-1'`)
      .run()

    const receipt = await ctx.call('allow', person)
    expect(receipt.decision).toBe('allow')
    expect(chat.answer).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'deny', stopOnDeny: false })
    )
    const handoff = ctx.db.db
      .prepare(`SELECT * FROM routing_sub_actions WHERE write_granted_at IS NOT NULL`)
      .all() as RoutingSubActionRow[]
    expect(handoff).toHaveLength(1)
    // 铸行即钉目标：无 hint 时系统默认 agent（claude）写进 agent_hint，派发不再二次推导。
    expect(handoff[0]).toMatchObject({ agent_hint: 'claude', depends_on_json: '["sa-1-1"]' })
    expect(ctx.closings().join('\n')).toContain('(agent: claude)')
  })
})
