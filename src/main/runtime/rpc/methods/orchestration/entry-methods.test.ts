import { afterEach, describe, expect, it } from 'vitest'
import { createOrchestrationRpcHarness } from './rpc-test-harness'
import { createRootDispatch } from '../../../orchestration/db/root-dispatch-test-fixture'

describe('desktop entry methods (plan §1/§9-A per-project 入口)', () => {
  const h = createOrchestrationRpcHarness()

  afterEach(() => {
    h.cleanup()
  })

  it('shows an empty standing entry before the first request', async () => {
    const { ctx } = h.setup(false)
    const show = (await h.call('orchestration.entryShow', { group: 'proj_alpha' }, ctx)) as {
      run: unknown
      inputs: unknown[]
      watchdog: { paused: boolean }
    }
    expect(show.run).toBeNull()
    expect(show.inputs).toEqual([])
    expect(show.watchdog.paused).toBe(false)
  })

  it('creates the entry Run on first submit and appends later requests to the same Run', async () => {
    const { ctx } = h.setup(false)
    const first = (await h.call(
      'orchestration.entrySubmit',
      { group: 'proj_alpha', text: '修登录，另外查启动慢' },
      ctx
    )) as { run: { id: string }; input: { input_id: string; received_seq: number } }
    const second = (await h.call(
      'orchestration.entrySubmit',
      { group: 'proj_alpha', text: '统计手册页数' },
      ctx
    )) as { run: { id: string }; input: { input_id: string; received_seq: number } }
    expect(second.run.id).toBe(first.run.id)
    expect(first.input.received_seq).toBe(1)
    expect(second.input.received_seq).toBe(2)

    const show = (await h.call('orchestration.entryShow', { group: 'proj_alpha' }, ctx)) as {
      run: { id: string }
      inputs: { input: { input_id: string } }[]
    }
    expect(show.run.id).toBe(first.run.id)
    expect(show.inputs.map((entry) => entry.input.input_id)).toEqual([
      first.input.input_id,
      second.input.input_id
    ])
  })

  it('keeps per-project entries isolated from each other', async () => {
    const { ctx } = h.setup(false)
    const alpha = (await h.call(
      'orchestration.entrySubmit',
      { group: 'proj_alpha', text: 'alpha 请求' },
      ctx
    )) as { run: { id: string }; input: { input_id: string } }
    const beta = (await h.call(
      'orchestration.entrySubmit',
      { group: 'proj_beta', text: 'beta 请求' },
      ctx
    )) as { run: { id: string } }
    expect(beta.run.id).not.toBe(alpha.run.id)
    const alphaShow = (await h.call('orchestration.entryShow', { group: 'proj_alpha' }, ctx)) as {
      inputs: { input: { input_id: string } }[]
    }
    expect(alphaShow.inputs).toHaveLength(1)
    await expect(
      h.call(
        'orchestration.entrySupplement',
        {
          group: 'proj_beta',
          input: alpha.input.input_id,
          subAction: 'sa_x',
          dispatch: 'dispatch_x',
          text: '误投'
        },
        ctx
      )
    ).rejects.toMatchObject({ code: 'lifecycle_not_found' })
  })

  it('delivers and hands back a sub-action inside the entry Run', async () => {
    const { db, ctx } = h.setup(false)
    const submitted = (await h.call(
      'orchestration.entrySubmit',
      { group: 'proj_alpha', text: '只读 new.txt，跳过 old.txt' },
      ctx
    )) as { run: { id: string }; input: { input_id: string } }
    const { subActions } = db.registerRoutingDecision({
      inputId: submitted.input.input_id,
      subActions: [{ text: '改读 new.txt' }]
    })
    const subActionId = subActions[0]!.sub_action_id
    const task = db.createTask({ runId: submitted.run.id, spec: 'entry worker' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')

    const send = (await h.call(
      'orchestration.entrySupplement',
      {
        group: 'proj_alpha',
        input: submitted.input.input_id,
        subAction: subActionId,
        dispatch: dispatch.id,
        text: '只读 new.txt，跳过 old.txt'
      },
      ctx
    )) as { outcome: string; refusalKind?: string }
    expect(send.outcome).toBe('refused')

    // A refused delivery never claims; after an explicit claim the guarded handback releases.
    db.claimSubActionForDispatch(subActionId, dispatch.id)
    const handback = (await h.call(
      'orchestration.entryHandback',
      { group: 'proj_alpha', subAction: subActionId, dispatch: dispatch.id },
      ctx
    )) as { released: boolean }
    expect(handback.released).toBe(true)
  })
})
