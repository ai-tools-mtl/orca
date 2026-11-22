import { expect, it } from 'vitest'
import {
  createOrcaSessionId,
  formatOrcaSessionAddress
} from '../../../../../shared/agent-session/identity/orca-session-address'
import { OrchestrationDb } from '../../db/orchestration-db'
import { actOnInterruptedEntryApproval, recoveredEntryApprovals } from './entry-write-approval'
import { approvalReportId, closeReportedApproval } from './worker-approval-report'

it.each(['deny', 'renew'] as const)(
  'keeps an interrupted Codex write actionable and queues %s once to its original Dispatch',
  (action) => {
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: '调查启动慢',
        coordinatorHandle: 'desktop-entry:project',
        coordinatorPaneKey: null
      })
      const task = db.createTask({ runId: run.id, spec: '调查启动慢' })
      const started = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: 1,
        taskId: task.id,
        startOptions: { agent: 'codex', readOnly: true }
      })
      const handle = formatOrcaSessionAddress(
        createOrcaSessionId(() => 'e17979cf-8dd6-4d0b-8b4a-d0c662720004')
      )
      db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle,
        paneKey: null,
        processIncarnation: null,
        worktreeId: 'startup-worktree',
        setupState: 'not_applicable',
        effects: []
      })
      db.markWorkerDispatchReady(started.dispatch.id)
      const dispatch = db.getDispatchContextById(started.dispatch.id)!
      const approval = {
        v: 1,
        approvalId: 'orca:codex-prompt%3Athread%3Aitem',
        state: 'open',
        worker: { handle, dispatchId: dispatch.id, taskId: task.id },
        summary: { title: 'Run a command?', detail: 'printf example > startup.txt', reason: null },
        allowedActions: ['allow']
      } as const
      db.insertMessage({
        id: approvalReportId(dispatch.id, approval.approvalId, 'open'),
        from: handle,
        to: `run:${run.id}`,
        runId: run.id,
        type: 'escalation',
        subject: 'Worker approval',
        payload: JSON.stringify({ approval })
      })
      closeReportedApproval(
        db,
        dispatch,
        approval.approvalId,
        { by: 'unknown', decision: null, reason: null, reasonDelivered: false },
        { notify: () => {} }
      )
      expect(recoveredEntryApprovals(db, run.id).get(dispatch.id)?.approvalId).toBe(
        approval.approvalId
      )
      const request = { db, dispatch, approvalId: approval.approvalId, action, notify: () => {} }
      expect(actOnInterruptedEntryApproval(request)).toBe(true)
      expect(actOnInterruptedEntryApproval(request)).toBe(true)
      expect(recoveredEntryApprovals(db, run.id).has(dispatch.id)).toBe(false)
      const mail = db.getAllMessagesForHandle(`dispatch:${dispatch.id}`, 100, ['status'], run.id)
      expect(mail.map((message) => message.subject)).toEqual([
        action === 'deny' ? 'User denied the write' : 'Renew the interrupted approval'
      ])
    } finally {
      db.close()
    }
  }
)
