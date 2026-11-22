import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../core'
import { createOrchestrationRpcHarness } from './rpc-test-harness'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import {
  partialRuntimeStore,
  storeRepo
} from '../../../orca-runtime-tests/runtime-store-partial-fixture'

const followThrough = vi.hoisted(() => ({ continued: [] as string[] }))
vi.mock('./messaging/settled-worker-follow-through', () => ({
  continueUnreadWorkerMail: (_runtime: unknown, _db: unknown, dispatchId: string) => {
    followThrough.continued.push(dispatchId)
  }
}))

// 门等待期的驳回修改（§7 方向 2 续篇）：门保持未放行，修改要求作为未读邮件挂到该阶段
// worker 的 Dispatch，由续接机制重开同会话投递；同文本重放幂等。
describe('orchestration.entryGateReject', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext

  afterEach(() => {
    h.cleanup()
    vi.restoreAllMocks()
  })

  async function call<T>(name: string, params: Record<string, unknown>): Promise<T> {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the asserted shape is the called method's documented receipt.
    return (await h.call(name, params, ctx)) as T
  }

  async function seedStage(): Promise<{ subActionId: string; dispatchId: string }> {
    const repo = storeRepo({ id: 'proj_alpha', path: '/fixture/project', kind: 'git' })
    const state = h.setup(
      false,
      partialRuntimeStore({
        getRepos: () => [repo],
        getSettings: () => ({
          defaultTuiAgent: 'codex',
          nativeChatProviders: {},
          decisionModel: { source: 'agent' }
        })
      }),
      ':memory:'
    )
    db = state.db
    ctx = { ...state.ctx, caller: { kind: 'desktop' } }
    const submitted = await call<{ run: { id: string }; input: { input_id: string } }>(
      'orchestration.entrySubmit',
      { group: 'proj_alpha', text: '只读调查仓库并设计原型，写入前需我批准' }
    )
    const task = db.createTask({ runId: submitted.run.id, spec: '规划·原型设计' })
    const { dispatch } = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    // 先认领后结算：阶段已完成、其 worker dispatch 已落幕（驳回针对的就是这个状态）。
    db.db.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).run(task.id)
    db.completeDispatch(dispatch.id)
    db.db
      .prepare(
        `INSERT INTO routing_sub_actions
           (sub_action_id, input_id, run_id, seq, text, constraints_json, task_id, stage_kind, gate)
         VALUES ('sa-1-1', ?, ?, 1, '规划·原型设计', '[]', ?, 'prototype', 'user_confirm')`
      )
      .run(submitted.input.input_id, submitted.run.id, task.id)
    return { subActionId: 'sa-1-1', dispatchId: dispatch.id }
  }

  it('keeps the gate ungranted and mails the modification to the settled worker', async () => {
    const { subActionId, dispatchId } = await seedStage()

    const receipt = await call<{ mailMessageId: string }>('orchestration.entryGateReject', {
      group: 'proj_alpha',
      subAction: subActionId,
      text: '出库流程缺反向冲销，改成先冲销再入账。'
    })
    expect(db.getSubAction(subActionId)?.gate_granted_at).toBeNull()
    const unread = db.getUnreadMessages(`dispatch:${dispatchId}`, ['status'])
    expect(
      unread.some((mail) => mail.id === receipt.mailMessageId && mail.body.includes('反向冲销'))
    ).toBe(true)
    expect(followThrough.continued).toEqual([dispatchId])

    // 同文本重放幂等：不新增邮件，也不再次触发续接。
    await call('orchestration.entryGateReject', {
      group: 'proj_alpha',
      subAction: subActionId,
      text: '出库流程缺反向冲销，改成先冲销再入账。'
    })
    expect(
      db
        .getUnreadMessages(`dispatch:${dispatchId}`, ['status'])
        .filter((mail) => mail.id === receipt.mailMessageId)
    ).toHaveLength(1)
    expect(followThrough.continued).toEqual([dispatchId])
  })

  it('refuses to reject a gate that was already granted', async () => {
    const { subActionId } = await seedStage()
    db.grantRoutingStageGate(subActionId)
    await expect(
      call('orchestration.entryGateReject', {
        group: 'proj_alpha',
        subAction: subActionId,
        text: '改'
      })
    ).rejects.toMatchObject({ code: 'lifecycle_conflict' })
  })
})
