import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db/orchestration-db'

const harnesses: { db: OrchestrationDb; dir: string }[] = []
afterAll(() => {
  for (const harness of harnesses) {
    rmSync(harness.dir, { recursive: true, force: true })
  }
})

function createDbWithCycle(): { db: OrchestrationDb; cycleId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-review-cycle-'))
  const db = new OrchestrationDb(join(dir, 'orchestration.db'))
  harnesses.push({ db, dir })
  const run = db.createRun({
    objective: 'audit',
    coordinatorHandle: 'coord',
    coordinatorPaneKey: null
  })
  const task = db.createTask({ runId: run.id, spec: '登录修复' })
  const cycle = db.startReviewCycle({
    taskId: task.id,
    writerDispatchId: 'ctx_writer',
    reviewerDispatchId: 'ctx_reviewer'
  })
  return { db, cycleId: cycle.cycle_id }
}

describe('review cycle (plan §7 write-review pilot)', () => {
  it('records blocking opinions with stable ids and drives rework', () => {
    const { db, cycleId } = createDbWithCycle()
    expect(db.getReviewCycle(cycleId).state).toBe('reviewing')
    expect(db.getReviewCycle(cycleId).current_revision).toBe(1)
    const opinion = db.recordReviewOpinion({
      cycleId,
      body: '缺 legacy 入口回归',
      blocking: true
    })
    expect(opinion.opinion_id).toBe('R1-01')
    expect(db.getReviewCycle(cycleId).state).toBe('rework')
    // 返工：writer submits R2 — the opinion stays recorded as history.
    db.submitReviewRevision(cycleId)
    expect(db.getReviewCycle(cycleId).current_revision).toBe(2)
    expect(db.getReviewCycle(cycleId).state).toBe('reviewing')
    const opinions = db.listReviewOpinions(cycleId)
    expect(opinions).toHaveLength(1)
    expect(opinions[0]?.opinion_id).toBe('R1-01')
  })

  it('sequences opinion ids per revision (R2-01 after rework)', () => {
    const { db, cycleId } = createDbWithCycle()
    db.recordReviewOpinion({ cycleId, body: 'R1 阻塞', blocking: true })
    db.submitReviewRevision(cycleId)
    const opinion = db.recordReviewOpinion({ cycleId, body: 'R2 复审意见', blocking: true })
    expect(opinion.opinion_id).toBe('R2-01')
    expect(opinion.revision).toBe(2)
  })

  it('user acceptance closes only when the current revision has no blocking opinions', () => {
    const { db, cycleId } = createDbWithCycle()
    db.recordReviewOpinion({ cycleId, body: '阻塞', blocking: true })
    expect(() => db.acceptReviewCycle(cycleId)).toThrowError(/blocking opinions/)
    const resolvedOpinion = db.resolveReviewOpinion(cycleId, 'R1-01')
    expect(resolvedOpinion.state).toBe('resolved')
    expect(db.getReviewCycle(cycleId).state).toBe('rework')
    const accepted = db.acceptReviewCycle(cycleId)
    expect(accepted.state).toBe('accepted')
    expect(db.acceptReviewCycle(cycleId).state).toBe('accepted')
  })

  it('refuses writer/reviewer being the same dispatch and opinions after acceptance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-review-cycle-'))
    const db = new OrchestrationDb(join(dir, 'orchestration.db'))
    harnesses.push({ db, dir })
    const run = db.createRun({
      objective: 'audit',
      coordinatorHandle: 'coord',
      coordinatorPaneKey: null
    })
    const task = db.createTask({ runId: run.id, spec: '登录修复' })
    expect(() =>
      db.startReviewCycle({
        taskId: task.id,
        writerDispatchId: 'ctx_same',
        reviewerDispatchId: 'ctx_same'
      })
    ).toThrowError(/different Dispatches/)
    const cycle = db.startReviewCycle({
      taskId: task.id,
      writerDispatchId: 'ctx_writer',
      reviewerDispatchId: 'ctx_reviewer'
    })
    db.acceptReviewCycle(cycle.cycle_id)
    expect(() =>
      db.recordReviewOpinion({ cycleId: cycle.cycle_id, body: '迟到意见', blocking: true })
    ).toThrowError(/accepted/)
  })
})
