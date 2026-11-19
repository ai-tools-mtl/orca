import { afterEach, describe, expect, it } from 'vitest'
import type { RpcContext } from '../../../core'
import { createOrchestrationRpcHarness } from './rpc-test-harness'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import { createRootDispatch } from '../../../orchestration/db/root-dispatch-test-fixture'

describe('desktop entry methods (plan §1/§9-A per-project 入口)', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext

  afterEach(() => {
    h.cleanup()
  })

  // Typed at each call site: the harness erases handler result types, so every call names the
  // receipt shape its method documents.
  async function call<T>(name: string, params: Record<string, unknown>): Promise<T> {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the asserted shape is the called method's documented receipt.
    return (await h.call(name, params, ctx)) as T
  }

  it('shows an empty standing entry before the first request', async () => {
    ;({ ctx } = h.setup(false))
    const show = await call<{ run: unknown; inputs: unknown[]; watchdog: { paused: boolean } }>(
      'orchestration.entryShow',
      { group: 'proj_alpha' }
    )
    expect(show.run).toBeNull()
    expect(show.inputs).toEqual([])
    expect(show.watchdog.paused).toBe(false)
  })

  it('creates the entry Run on first submit and appends later requests to the same Run', async () => {
    ;({ ctx } = h.setup(false))
    const first = await call<{
      run: { id: string }
      input: { input_id: string; received_seq: number }
    }>('orchestration.entrySubmit', { group: 'proj_alpha', text: '修登录，另外查启动慢' })
    const second = await call<{
      run: { id: string }
      input: { input_id: string; received_seq: number }
    }>('orchestration.entrySubmit', { group: 'proj_alpha', text: '统计手册页数' })
    expect(second.run.id).toBe(first.run.id)
    expect(first.input.received_seq).toBe(1)
    expect(second.input.received_seq).toBe(2)

    const show = await call<{ run: { id: string }; inputs: { input: { input_id: string } }[] }>(
      'orchestration.entryShow',
      { group: 'proj_alpha' }
    )
    expect(show.run.id).toBe(first.run.id)
    expect(show.inputs.map((entry) => entry.input.input_id)).toEqual([
      first.input.input_id,
      second.input.input_id
    ])
  })

  it('keeps per-project entries isolated from each other', async () => {
    ;({ ctx } = h.setup(false))
    const alpha = await call<{ run: { id: string }; input: { input_id: string } }>(
      'orchestration.entrySubmit',
      { group: 'proj_alpha', text: 'alpha 请求' }
    )
    const beta = await call<{ run: { id: string } }>('orchestration.entrySubmit', {
      group: 'proj_beta',
      text: 'beta 请求'
    })
    expect(beta.run.id).not.toBe(alpha.run.id)
    const alphaShow = await call<{ inputs: { input: { input_id: string } }[] }>(
      'orchestration.entryShow',
      { group: 'proj_alpha' }
    )
    expect(alphaShow.inputs).toHaveLength(1)
    await expect(
      call<unknown>('orchestration.entrySupplement', {
        group: 'proj_beta',
        input: alpha.input.input_id,
        subAction: 'sa_x',
        dispatch: 'dispatch_x',
        text: '误投'
      })
    ).rejects.toMatchObject({ code: 'lifecycle_not_found' })
  })

  it('delivers and hands back a sub-action inside the entry Run', async () => {
    ;({ db, ctx } = h.setup(false))
    const submitted = await call<{ run: { id: string }; input: { input_id: string } }>(
      'orchestration.entrySubmit',
      { group: 'proj_alpha', text: '只读 new.txt，跳过 old.txt' }
    )
    const { subActions } = db.registerRoutingDecision({
      inputId: submitted.input.input_id,
      subActions: [{ text: '改读 new.txt' }]
    })
    const subActionId = subActions[0]!.sub_action_id
    const task = db.createTask({ runId: submitted.run.id, spec: 'entry worker' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')

    const send = await call<{ outcome: string; refusalKind?: string }>(
      'orchestration.entrySupplement',
      {
        group: 'proj_alpha',
        input: submitted.input.input_id,
        subAction: subActionId,
        dispatch: dispatch.id,
        text: '只读 new.txt，跳过 old.txt'
      }
    )
    expect(send.outcome).toBe('refused')

    // A refused delivery never claims; after an explicit claim the guarded handback releases.
    db.claimSubActionForDispatch(subActionId, dispatch.id)
    const handback = await call<{ released: boolean }>('orchestration.entryHandback', {
      group: 'proj_alpha',
      subAction: subActionId,
      dispatch: dispatch.id
    })
    expect(handback.released).toBe(true)
  })
})
