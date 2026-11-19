import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../db/orchestration-db'
import {
  autoRouteWithModelProvider,
  createModelDecisionProvider,
  resolveModelDecisionProvider
} from './model-decision-provider'

const okCredential = {
  status: 'ok' as const,
  apiKey: 'synthetic-key',
  baseUrl: 'https://plan.example',
  modelId: 'glm-test',
  identity: '[]',
  configPath: '/synthetic/config'
}

function completionsResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
}

describe('model decision provider (plan §5.1 model-backed seam)', () => {
  const harnesses: { db: OrchestrationDb; dir: string }[] = []
  afterEach(() => {
    for (const harness of harnesses) {
      rmSync(harness.dir, { recursive: true, force: true })
    }
    vi.unstubAllGlobals()
  })

  function dbHarness(): OrchestrationDb {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-decision-'))
    const db = new OrchestrationDb(join(dir, 'orchestration.db'))
    harnesses.push({ db, dir })
    return db
  }

  it('proposes sub-actions from the model reply, stripping code fences', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _init?: unknown) =>
      completionsResponse(
        '```json\n{"subActions":[{"text":"修登录"},{"text":"查启动慢","taskId":"task_7"}]}\n```'
      )
    )
    const provider = createModelDecisionProvider({ ...okCredential, fetchImpl })
    const proposal = await provider({
      inputId: 'rinp_1',
      text: '修登录，另外查启动慢',
      candidateTasks: [{ taskId: 'task_7', spec: '启动慢调查', status: 'pending' }],
      executorCapabilities: []
    })
    expect(proposal.subActions).toEqual([
      { text: '修登录' },
      { text: '查启动慢', taskId: 'task_7' }
    ])
    const call = vi.mocked(fetchImpl).mock.calls[0]
    expect(String(call[0])).toBe('https://plan.example/api/paas/v4/chat/completions')
  })

  it('reports a reason and stays manual on HTTP errors and non-JSON replies', async () => {
    const failing = createModelDecisionProvider({
      ...okCredential,
      fetchImpl: vi.fn(async () => new Response('no', { status: 503 }))
    })
    await expect(
      failing({
        inputId: 'rinp_1',
        text: 'x',
        candidateTasks: [],
        executorCapabilities: []
      })
    ).rejects.toThrow('decision model returned 503')

    const gibberish = createModelDecisionProvider({
      ...okCredential,
      fetchImpl: vi.fn(async () => completionsResponse('I cannot help with that.'))
    })
    await expect(
      gibberish({
        inputId: 'rinp_1',
        text: 'x',
        candidateTasks: [],
        executorCapabilities: []
      })
    ).rejects.toThrow('decision model replied without a JSON object')
  })

  it('resolves unavailable without a serving credential', async () => {
    const resolution = await resolveModelDecisionProvider({ status: 'unavailable' })
    expect(resolution.status).toBe('unavailable')
  })

  it('auto-routes an entry input through the model and registers sub-actions', async () => {
    const db = dbHarness()
    const run = db.createRun({
      objective: 'routing',
      coordinatorHandle: 'desktop-entry:proj_alpha',
      coordinatorPaneKey: null
    })
    const input = db.registerRoutingInput({ runId: run.id, text: '修登录，另外查启动慢' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        completionsResponse('{"subActions":[{"text":"修登录"},{"text":"查启动慢"}]}')
      )
    )
    const routed = await autoRouteWithModelProvider(db, { inputId: input.input_id }, okCredential)
    expect(routed.routed).toBe(true)
    expect(routed.subActions.map((subAction) => subAction.text)).toEqual(['修登录', '查启动慢'])
    expect(db.listSubActions(input.input_id)).toHaveLength(2)
  })

  it('stays manual with the unavailable reason when no credential serves', async () => {
    const db = dbHarness()
    const run = db.createRun({
      objective: 'routing',
      coordinatorHandle: 'desktop-entry:proj_beta',
      coordinatorPaneKey: null
    })
    const input = db.registerRoutingInput({ runId: run.id, text: '没有凭据' })
    const routed = await autoRouteWithModelProvider(
      db,
      { inputId: input.input_id },
      {
        status: 'absent'
      }
    )
    expect(routed.routed).toBe(false)
    expect(routed.reason).toContain('manual assignment')
    expect(db.listSubActions(input.input_id)).toHaveLength(0)
  })
})
