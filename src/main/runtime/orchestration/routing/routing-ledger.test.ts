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
