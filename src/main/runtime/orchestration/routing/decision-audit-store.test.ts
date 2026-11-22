import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db/orchestration-db'

// 决策审计的落库形状 (调参参考)：classified/error 两种行 + 原始答案/映射/分支阈值快照的
// JSON 往返 + 按 run 查询（最新在前）与 input 过滤。

const harnesses: { db: OrchestrationDb; dir: string }[] = []
afterAll(() => {
  for (const harness of harnesses) {
    rmSync(harness.dir, { recursive: true, force: true })
  }
})

function createHarness(): { db: OrchestrationDb; runId: string; inputId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-decision-audit-'))
  const db = new OrchestrationDb(join(dir, 'orchestration.db'))
  harnesses.push({ db, dir })
  const run = db.createRun({
    objective: 'audit',
    coordinatorHandle: 'coord',
    coordinatorPaneKey: null
  })
  const input = db.registerRoutingInput({ runId: run.id, text: '改按钮颜色' })
  return { db, runId: run.id, inputId: input.input_id }
}

describe('decision model audit store', () => {
  it('records classified and error attempts with their payloads and lists newest first', () => {
    const { db, runId, inputId } = createHarness()
    db.recordDecisionModelAudit({
      runId,
      inputId,
      source: 'decisions',
      model: 'typesafe/jev-1.13',
      outcome: 'classified',
      httpStatus: 200,
      latencyMs: 812,
      creditsUsed: 3,
      inputTokens: 950,
      state: { request: '改按钮颜色' },
      answers: { continuation: { choice: 'task_1', confidence: 0.9 } },
      classification: {
        needsPlanning: false,
        taskReference: { taskId: 'task_1', confidence: 0.9 }
      },
      applied: { branch: 'continuation', taskId: 'task_1', confidence: 0.9, floor: 0.5 }
    })
    db.recordDecisionModelAudit({
      runId,
      inputId,
      source: 'decisions',
      outcome: 'error',
      errorMessage: 'decisions 服务返回 429（30 后可重试）',
      latencyMs: 120
    })

    const audits = db.listDecisionModelAudits({ runId })
    expect(audits).toHaveLength(2)
    // 最新在前：重试排在原请求前面，调参时按时间倒序对看。
    expect(audits[0]!.outcome).toBe('error')
    expect(audits[0]!.error_message).toMatch(/429/)
    expect(audits[0]!.classification_json).toBeNull()
    const classified = audits[1]!
    expect(classified.outcome).toBe('classified')
    expect(classified.source).toBe('decisions')
    expect(classified.model).toBe('typesafe/jev-1.13')
    expect(JSON.parse(classified.answers_json!)).toMatchObject({
      continuation: { choice: 'task_1', confidence: 0.9 }
    })
    expect(JSON.parse(classified.applied_json!)).toMatchObject({
      branch: 'continuation',
      taskId: 'task_1',
      floor: 0.5
    })
    expect(classified.credits_used).toBe(3)
    expect(classified.input_tokens).toBe(950)

    expect(db.listDecisionModelAudits({ runId, inputId: 'rinp_missing' })).toHaveLength(0)
    expect(db.listDecisionModelAudits({ runId, limit: 1 })).toHaveLength(1)
  })
})
