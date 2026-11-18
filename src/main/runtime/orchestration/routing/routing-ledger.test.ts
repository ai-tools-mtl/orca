import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db/orchestration-db'
import { createRootDispatch } from '../db/root-dispatch-test-fixture'

const harnesses: { db: OrchestrationDb; dir: string }[] = []
afterAll(() => {
  for (const harness of harnesses) {
    rmSync(harness.dir, { recursive: true, force: true })
  }
})

function createDb(): OrchestrationDb {
  const dir = mkdtempSync(join(tmpdir(), 'orca-routing-ledger-'))
  const db = new OrchestrationDb(join(dir, 'orchestration.db'))
  harnesses.push({ db, dir })
  return db
}

describe('routing ledger (plan §5.1/§6)', () => {
  it('reuses the recorded sub-actions when an input is re-decided', () => {
    const db = createDb()
    const run = db.createRun({
      objective: 'audit',
      coordinatorHandle: 'coord',
      coordinatorPaneKey: null
    })
    const input = db.registerRoutingInput({ runId: run.id, text: '修登录，另外查启动慢' })
    const first = db.registerRoutingDecision({
      inputId: input.input_id,
      subActions: [{ text: '修登录' }, { text: '查启动慢' }]
    })
    expect(first.reused).toBe(false)
    expect(first.subActions.map((subAction) => subAction.sub_action_id)).toEqual([
      'sa-1-1',
      'sa-1-2'
    ])
    const second = db.registerRoutingDecision({
      inputId: input.input_id,
      subActions: [{ text: '修登录' }, { text: '查启动慢' }]
    })
    expect(second.reused).toBe(true)
    expect(second.subActions.map((subAction) => subAction.sub_action_id)).toEqual(
      first.subActions.map((subAction) => subAction.sub_action_id)
    )
    expect(db.listSubActions(input.input_id)).toHaveLength(2)
  })

  it('numbers the next input after the previous one and lists a run’s inputs in receive order', () => {
    const db = createDb()
    const run = db.createRun({
      objective: 'audit',
      coordinatorHandle: 'coord',
      coordinatorPaneKey: null
    })
    const first = db.registerRoutingInput({ runId: run.id, text: 'first' })
    db.registerRoutingDecision({ inputId: first.input_id, subActions: [{ text: 'a' }] })
    const second = db.registerRoutingInput({ runId: run.id, text: 'second' })
    const decision = db.registerRoutingDecision({
      inputId: second.input_id,
      subActions: [{ text: 'b' }]
    })
    expect(decision.reused).toBe(false)
    expect(decision.subActions[0]?.sub_action_id).toBe('sa-2-1')
    const inputs = db.listRunRoutingInputs(run.id)
    expect(inputs.map((input) => input.input_id)).toEqual([first.input_id, second.input_id])
    expect(inputs.map((input) => input.decision_status)).toEqual(['decided', 'decided'])
  })

  it('refuses decisions for unknown inputs', () => {
    const db = createDb()
    expect(() =>
      db.registerRoutingDecision({ inputId: 'rinp_missing', subActions: [{ text: 'a' }] })
    ).toThrowError(/not found/)
  })
})

describe('routing sub-action continuations (plan §5.3 row 3 / §6)', () => {
  it('registers one continuation per sub-action and reuses it', () => {
    const db = createDb()
    const run = db.createRun({
      objective: 'audit',
      coordinatorHandle: 'coord',
      coordinatorPaneKey: null
    })
    const input = db.registerRoutingInput({ runId: run.id, text: '调查' })
    db.registerRoutingDecision({ inputId: input.input_id, subActions: [{ text: '调查项' }] })
    const first = db.recordRoutingContinuation({
      subActionId: 'sa-1-1',
      inputId: input.input_id,
      sourceDispatchId: 'ctx_source',
      requestId: 'rtcont_1'
    })
    expect(first.reused).toBe(false)
    expect(first.continuation.follow_up_dispatch_id).toBeNull()
    const second = db.recordRoutingContinuation({
      subActionId: 'sa-1-1',
      inputId: input.input_id,
      sourceDispatchId: 'ctx_source',
      requestId: 'rtcont_1'
    })
    expect(second.reused).toBe(true)
    expect(db.getRoutingContinuation('sa-1-1')?.request_id).toBe('rtcont_1')
  })

  it('binds the follow-up dispatch once; re-binding the same is idempotent, another conflicts', () => {
    const db = createDb()
    const run = db.createRun({
      objective: 'audit',
      coordinatorHandle: 'coord',
      coordinatorPaneKey: null
    })
    const input = db.registerRoutingInput({ runId: run.id, text: '调查' })
    db.registerRoutingDecision({ inputId: input.input_id, subActions: [{ text: '调查项' }] })
    db.recordRoutingContinuation({
      subActionId: 'sa-1-1',
      inputId: input.input_id,
      sourceDispatchId: 'ctx_source',
      requestId: 'rtcont_1'
    })
    const bound = db.bindRoutingContinuationFollowUp('sa-1-1', 'ctx_follow')
    expect(bound.follow_up_dispatch_id).toBe('ctx_follow')
    expect(db.bindRoutingContinuationFollowUp('sa-1-1', 'ctx_follow').follow_up_dispatch_id).toBe(
      'ctx_follow'
    )
    expect(() => db.bindRoutingContinuationFollowUp('sa-1-1', 'ctx_other')).toThrowError(
      /already continues/
    )
  })

  it('refuses continuations for sub-actions without a record', () => {
    const db = createDb()
    expect(db.getRoutingContinuation('sa_missing')).toBeUndefined()
    expect(() => db.bindRoutingContinuationFollowUp('sa_missing', 'ctx_x')).toThrowError(
      /not found/
    )
  })
})

describe('sub-action card state + run pause (plan §5.3/§5.5)', () => {
  it('walks registered → delivered → processed and refuses terminal moves', () => {
    const db = createDb()
    const run = db.createRun({
      objective: 'audit',
      coordinatorHandle: 'coord',
      coordinatorPaneKey: null
    })
    const input = db.registerRoutingInput({ runId: run.id, text: '修登录' })
    db.registerRoutingDecision({ inputId: input.input_id, subActions: [{ text: '修登录' }] })
    const subActionId = db.listSubActions(input.input_id)[0]!.sub_action_id
    expect(db.getSubAction(subActionId)?.state).toBe('registered')
    db.setSubActionState(subActionId, 'delivered')
    db.setSubActionState(subActionId, 'processed')
    expect(db.getSubAction(subActionId)?.state).toBe('processed')
    expect(() => db.setSubActionState(subActionId, 'delivered')).toThrowError(/cannot move/)
  })

  it('records first-action evidence on the attempt with the card state', () => {
    const db = createDb()
    const run = db.createRun({
      objective: 'audit',
      coordinatorHandle: 'coord',
      coordinatorPaneKey: null
    })
    const input = db.registerRoutingInput({ runId: run.id, text: '修登录' })
    db.registerRoutingDecision({ inputId: input.input_id, subActions: [{ text: '修登录' }] })
    const subActionId = db.listSubActions(input.input_id)[0]!.sub_action_id
    db.setSubActionState(subActionId, 'delivered')
    const task = db.createTask({ runId: run.id, spec: 'audit task' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    const supplement = db.recordRoutingSupplement({
      inputId: input.input_id,
      subActionId,
      targetDispatchId: dispatch.id,
      text: '修登录'
    })
    const attempt = db.recordSupplementAttempt({
      supplementId: supplement.supplement_id,
      requestId: 'rtsend_1',
      targetDispatchId: dispatch.id,
      expectedTurnId: 'turn-1',
      outcome: 'delivered',
      turnId: 'turn-1'
    })
    const recorded = db.recordSupplementFirstActionEvidence({
      attemptId: attempt.attempt_id,
      subActionId,
      verdict: {
        verdict: 'complied',
        firstAction: { sequence: 9, name: 'read', path: '/w/new.txt' }
      }
    })
    expect(recorded.subAction.state).toBe('processed')
    expect(JSON.parse(recorded.attempt.first_action_json ?? '{}').firstAction?.path).toBe(
      '/w/new.txt'
    )
  })

  it('pauses and resumes a run’s entry admission', () => {
    const db = createDb()
    const run = db.createRun({
      objective: 'audit',
      coordinatorHandle: 'coord',
      coordinatorPaneKey: null
    })
    expect(db.isRoutingRunPaused(run.id)).toBe(false)
    db.pauseRoutingRun(run.id)
    expect(db.isRoutingRunPaused(run.id)).toBe(true)
    db.resumeRoutingRun(run.id)
    expect(db.isRoutingRunPaused(run.id)).toBe(false)
  })
})

describe('sub-action claims and handbacks (plan §5.2 phase B)', () => {
  it('claims once, refuses a second live claim, and re-claims after handback', () => {
    const db = createDb()
    const run = db.createRun({
      objective: 'audit',
      coordinatorHandle: 'coord',
      coordinatorPaneKey: null
    })
    const input = db.registerRoutingInput({ runId: run.id, text: '修登录' })
    db.registerRoutingDecision({ inputId: input.input_id, subActions: [{ text: '修登录' }] })
    const subActionId = db.listSubActions(input.input_id)[0]!.sub_action_id
    const claimed = db.claimSubActionForDispatch(subActionId, 'ctx_a')
    expect(claimed.claimed_dispatch_id).toBe('ctx_a')
    expect(claimed.claim_version).toBe(1)
    expect(() => db.claimSubActionForDispatch(subActionId, 'ctx_b')).toThrowError(
      /claimed by ctx_a/
    )
    const result = db.handbackSubAction({
      subActionId,
      fromDispatchId: 'ctx_a',
      reason: 'worker handed back'
    })
    expect(result.released).toBe(true)
    expect(result.subAction.claimed_dispatch_id).toBeNull()
    expect(result.subAction.claim_version).toBe(2)
    expect(result.handback?.reason).toBe('worker handed back')
    const reclaimed = db.claimSubActionForDispatch(subActionId, 'ctx_b')
    expect(reclaimed.claimed_dispatch_id).toBe('ctx_b')
    expect(reclaimed.claim_version).toBe(3)
    expect(db.listSubActionHandbacks(subActionId)).toHaveLength(1)
  })

  it('is idempotent when re-claiming the same dispatch', () => {
    const db = createDb()
    const run = db.createRun({
      objective: 'audit',
      coordinatorHandle: 'coord',
      coordinatorPaneKey: null
    })
    const input = db.registerRoutingInput({ runId: run.id, text: '修登录' })
    db.registerRoutingDecision({ inputId: input.input_id, subActions: [{ text: '修登录' }] })
    const subActionId = db.listSubActions(input.input_id)[0]!.sub_action_id
    const first = db.claimSubActionForDispatch(subActionId, 'ctx_a')
    const second = db.claimSubActionForDispatch(subActionId, 'ctx_a')
    expect(second.claim_version).toBe(first.claim_version)
  })

  it('releases nothing when the handback names a dispatch that holds no claim', () => {
    const db = createDb()
    const run = db.createRun({
      objective: 'audit',
      coordinatorHandle: 'coord',
      coordinatorPaneKey: null
    })
    const input = db.registerRoutingInput({ runId: run.id, text: '修登录' })
    db.registerRoutingDecision({ inputId: input.input_id, subActions: [{ text: '修登录' }] })
    const subActionId = db.listSubActions(input.input_id)[0]!.sub_action_id
    const result = db.handbackSubAction({
      subActionId,
      fromDispatchId: 'ctx_nobody',
      reason: 'stale'
    })
    expect(result.released).toBe(false)
  })
})
