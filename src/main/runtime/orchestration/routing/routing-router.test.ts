import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db/orchestration-db'
import {
  MANUAL_DECISION_PROVIDER,
  routeRoutingInput,
  type RoutingDecisionProvider
} from './routing-router'

const harnesses: { db: OrchestrationDb; dir: string }[] = []
afterAll(() => {
  for (const harness of harnesses) {
    rmSync(harness.dir, { recursive: true, force: true })
  }
})

function createDbWithInput(text: string): { db: OrchestrationDb; inputId: string; taskId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-routing-router-'))
  const db = new OrchestrationDb(join(dir, 'orchestration.db'))
  harnesses.push({ db, dir })
  const run = db.createRun({
    objective: 'audit',
    coordinatorHandle: 'coord',
    coordinatorPaneKey: null
  })
  const task = db.createTask({ runId: run.id, spec: 'existing login task' })
  const input = db.registerRoutingInput({ runId: run.id, text })
  return { db, inputId: input.input_id, taskId: task.id }
}

describe('routing router (plan §5.1)', () => {
  it('defaults to manual assignment when no provider is configured', async () => {
    const { db, inputId } = createDbWithInput('修登录')
    const result = await routeRoutingInput(db, { inputId })
    expect(result.routed).toBe(false)
    expect(result.reason).toMatch(/manual assignment/)
    expect(db.getRoutingInput(inputId)?.decision_status).toBe('received')
  })

  it('registers a valid proposal atomically and reuses it on re-route', async () => {
    const { db, inputId, taskId } = createDbWithInput('修登录')
    const provider: RoutingDecisionProvider = async () => ({
      subActions: [{ text: '修登录', taskId }]
    })
    const first = await routeRoutingInput(db, { inputId, provider })
    expect(first.routed).toBe(true)
    expect(first.reused).toBe(false)
    expect(first.subActions.map((subAction) => subAction.sub_action_id)).toEqual(['sa-1-1'])
    const second = await routeRoutingInput(db, { inputId, provider })
    expect(second.reused).toBe(true)
    expect(second.subActions.map((subAction) => subAction.sub_action_id)).toEqual(['sa-1-1'])
    expect(db.listSubActions(inputId)).toHaveLength(1)
  })

  it('rejects proposals referencing tasks outside the candidate set', async () => {
    const { db, inputId } = createDbWithInput('修登录')
    const provider: RoutingDecisionProvider = async () => ({
      subActions: [{ text: '幻觉任务', taskId: 'task_hallucinated' }]
    })
    const result = await routeRoutingInput(db, { inputId, provider })
    expect(result.routed).toBe(false)
    expect(result.reason).toMatch(/unknown task reference/)
    expect(db.getRoutingInput(inputId)?.decision_status).toBe('received')
  })

  it('records the reason for a deliberate no-op proposal', async () => {
    const { db, inputId } = createDbWithInput('今天天气怎么样')
    const provider: RoutingDecisionProvider = async () => ({
      subActions: [],
      reason: '聊天输入，无需调度动作'
    })
    const result = await routeRoutingInput(db, { inputId, provider })
    expect(result.routed).toBe(true)
    expect(result.subActions).toHaveLength(0)
    const decision = db.getRoutingInput(inputId)?.decision_json
    expect(decision).toContain('聊天输入')
  })

  it('voids the inference on provider timeout and leaves the input received', async () => {
    const { db, inputId } = createDbWithInput('修登录')
    const slowProvider: RoutingDecisionProvider = () => new Promise(() => undefined)
    const result = await routeRoutingInput(db, { inputId, provider: slowProvider, timeoutMs: 50 })
    expect(result.routed).toBe(false)
    expect(result.reason).toMatch(/timed out/)
    expect(db.getRoutingInput(inputId)?.decision_status).toBe('received')
  })

  it('exposes the manual provider as the explicit default', () => {
    expect(MANUAL_DECISION_PROVIDER).toBeTypeOf('function')
  })
})
