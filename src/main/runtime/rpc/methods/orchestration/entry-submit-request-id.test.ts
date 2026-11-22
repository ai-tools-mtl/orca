import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../core'
import { createOrchestrationRpcHarness } from './rpc-test-harness'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import { generateId } from '../../../orchestration/db/generated-id'
import { entryRunOfInput } from './entry-run-scope'
import {
  partialRuntimeStore,
  storeRepo
} from '../../../orca-runtime-tests/runtime-store-partial-fixture'

// 提交去重（§提交去重）：请求 ID 按入口 Run 作用域派生——同一项目内同 ID 同参数重放复用原
// 输入（含旧版裸 rinp_<requestId> 格式），文本或循环开发选项不一致是明确冲突；不同项目的
// 同一 requestId 各自登记，互不串号；两次主动提交即使文本相同也各自成输入。

const routeProvider = vi.hoisted(() => ({
  fn: vi.fn<() => Promise<unknown>>()
}))

vi.mock('../../../orchestration/routing/agent-route-proposal-provider', () => ({
  createAgentRouteProposalProvider: () => routeProvider.fn
}))

describe('entry submit request id dedup', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext

  afterEach(() => {
    h.cleanup()
    routeProvider.fn.mockReset()
    vi.restoreAllMocks()
  })

  async function call<T>(name: string, params: Record<string, unknown>): Promise<T> {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the asserted shape is the called method's documented receipt.
    return (await h.call(name, params, ctx)) as T
  }

  const group = 'proj_dedup'

  async function submit(text: string, requestId?: string): Promise<string> {
    const { input } = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text,
      ...(requestId ? { requestId } : {})
    })
    return input.input_id
  }

  function prepareWorkers(databasePath = ':memory:') {
    const repo = storeRepo({ id: group, path: '/fixture/project', kind: 'git' })
    const state = h.setup(
      false,
      partialRuntimeStore({
        getRepos: () => [repo],
        getSettings: () => ({ defaultTuiAgent: 'codex', nativeChatProviders: {} })
      }),
      databasePath
    )
    db = state.db
    ctx = { ...state.ctx, caller: { kind: 'desktop' } }
  }

  it('replays a whole submission by request id and rejects conflicting content', async () => {
    const state = h.setup(false)
    db = state.db
    ctx = { ...state.ctx, caller: { kind: 'desktop' } }
    const first = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '修登录',
      requestId: 'unified-replay-0001'
    })
    const replay = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '修登录',
      requestId: 'unified-replay-0001'
    })
    expect(replay.input.input_id).toBe(first.input.input_id)
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM routing_inputs').get()).toEqual({
      count: 1
    })
    // 同 ID 不同内容：明确冲突错误，不悄悄复用。
    await expect(
      call('orchestration.entrySubmit', {
        group,
        text: '修启动慢',
        requestId: 'unified-replay-0001'
      })
    ).rejects.toMatchObject({ code: 'lifecycle_conflict' })
    // 两次主动提交即使文本相同也各自成输入。
    const next = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '修登录',
      requestId: 'unified-replay-0002'
    })
    expect(next.input.input_id).not.toBe(first.input.input_id)
    // 同一请求 ID 用在另一个项目：各自登记、归属各自的 Run（按入口身份和项目隔离）。
    const otherGroup = `${group}_b`
    const otherSubmit = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group: otherGroup,
      text: '修登录',
      requestId: 'unified-replay-0001'
    })
    const otherInput = otherSubmit.input.input_id
    expect(otherInput).not.toBe(first.input.input_id)
    const otherRun = entryRunOfInput(db, otherGroup, otherInput)
    expect(otherRun.id).not.toBe(entryRunOfInput(db, group, first.input.input_id).id)
    expect(db.getRoutingInput(otherInput)?.run_id).toBe(otherRun.id)
    // 邻项目的重放同样复用邻项目自己的输入。
    const otherReplay = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group: otherGroup,
      text: '修登录',
      requestId: 'unified-replay-0001'
    })
    expect(otherReplay.input.input_id).toBe(otherInput)
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM routing_inputs').get()).toEqual({
      count: 3
    })
  })

  it('replays a legacy-format request id in its own run and treats loop changes as conflicts', async () => {
    prepareWorkers()
    // 旧版登记形态：裸 rinp_<requestId>（作用域化之前派生）——手工落一条，带 loop_dev=1。
    const anchor = await submit('锚定入口 Run')
    const runId = db.getRoutingInput(anchor)!.run_id
    const legacyId = 'rinp_legacy-replay-001'
    db.db
      .prepare(
        "INSERT INTO routing_inputs (input_id, run_id, raw_text, received_seq, decision_status, request_id, loop_dev) VALUES (?, ?, '修登录', 2, 'received', 'legacy-replay-001', 1)"
      )
      .run(legacyId, runId)
    db.registerRoutingDecision({ inputId: legacyId, subActions: [{ text: '修登录' }] })
    // 原入口原项目内重放：复用旧输入（不新增行），已有子动作引用继续可用。
    const replay = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '修登录',
      requestId: 'legacy-replay-001',
      loop: true
    })
    expect(replay.input.input_id).toBe(legacyId)
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM routing_inputs').get()).toEqual({
      count: 2
    })
    expect(db.listSubActions(legacyId)).toHaveLength(1)
    // 旧格式 ID 用同一套冲突判定：loop 选项变化（省略 = false ≠ 旧行 true）明确冲突。
    await expect(
      call('orchestration.entrySubmit', {
        group,
        text: '修登录',
        requestId: 'legacy-replay-001'
      })
    ).rejects.toMatchObject({ code: 'lifecycle_conflict' })
    // 当前格式 ID 同样判定 loop 冲突；相同参数重放仍复用。
    const looped = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '修启动',
      requestId: 'loop-check-0001',
      loop: true
    })
    await expect(
      call('orchestration.entrySubmit', { group, text: '修启动', requestId: 'loop-check-0001' })
    ).rejects.toMatchObject({ code: 'lifecycle_conflict' })
    const replayLoop = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '修启动',
      requestId: 'loop-check-0001',
      loop: true
    })
    expect(replayLoop.input.input_id).toBe(looped.input.input_id)
    // 跨项目：旧输入归属项目 A，同一 requestId 在项目 B 得到自己的独立输入。
    const other = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group: `${group}_b`,
      text: '修登录',
      requestId: 'legacy-replay-001'
    })
    expect(other.input.input_id).not.toBe(legacyId)
    expect(db.getRoutingInput(other.input.input_id)?.run_id).toBe(
      entryRunOfInput(db, `${group}_b`, other.input.input_id).id
    )
  })

  it('registers a second submission independently when its request id spells another scoped input id', async () => {
    prepareWorkers()
    const first = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '修登录',
      requestId: 'independent-first-01'
    })
    const runId = entryRunOfInput(db, group, first.input.input_id).id
    expect(first.input.input_id).toBe(`rinp_${runId}_independent-first-01`)
    // 第二个合法 requestId 拼出的旧格式查询键恰好等于第一条输入的当前格式 ID——
    // 它是一次新的主动提交，不得被旧格式回查误认成重放。
    const second = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '修登录',
      requestId: `${runId}_independent-first-01`
    })
    expect(second.input.input_id).not.toBe(first.input.input_id)
    expect(second.input.input_id).toBe(`rinp_${runId}_${runId}_independent-first-01`)
    expect(
      db.db.prepare('SELECT COUNT(*) AS count FROM routing_inputs WHERE run_id = ?').get(runId)
    ).toEqual({ count: 2 })
    // 各自重放仍复用各自的输入，账本不增。
    const firstReplay = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '修登录',
      requestId: 'independent-first-01'
    })
    const secondReplay = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '修登录',
      requestId: `${runId}_independent-first-01`
    })
    expect(firstReplay.input.input_id).toBe(first.input.input_id)
    expect(secondReplay.input.input_id).toBe(second.input.input_id)
    expect(
      db.db.prepare('SELECT COUNT(*) AS count FROM routing_inputs WHERE run_id = ?').get(runId)
    ).toEqual({ count: 2 })
  })

  /** 文件型 v56 账本夹具：真实 SQLite 文件上按 v56 写入形态落行（无 request_id 列），
   *  版本号回拨后关闭，经正常初始化重开完成 v56→57 升级——回填由迁移执行，夹具不预填。 */
  async function upgradeV56Fixture(
    text: string,
    buildRows: (runId: string) => string[]
  ): Promise<{ runId: string; inputIds: string[] }> {
    const databasePath = join(mkdtempSync(join(tmpdir(), 'orca-req-id-v56-')), 'orchestration.db')
    prepareWorkers(databasePath)
    const anchor = await submit('锚定入口 Run')
    const runId = db.getRoutingInput(anchor)!.run_id
    const inputIds = buildRows(runId)
    // 先降级成 v56 形态（去掉 v57+ 列、版本号回拨），再按旧写入路径落行。
    db.db.exec(
      'ALTER TABLE routing_inputs DROP COLUMN request_id_state; ALTER TABLE routing_inputs DROP COLUMN request_id; ALTER TABLE routing_sub_actions DROP COLUMN write_granted_at; PRAGMA user_version = 56;'
    )
    const insert = db.db.prepare(
      "INSERT INTO routing_inputs (input_id, run_id, raw_text, received_seq, decision_status, loop_dev) VALUES (?, ?, ?, 2, 'received', 0)"
    )
    for (const inputId of inputIds) {
      insert.run(inputId, runId, text)
    }
    if (inputIds[0]) {
      db.registerRoutingDecision({ inputId: inputIds[0], subActions: [{ text }] })
    }
    h.cleanup()
    prepareWorkers(databasePath)
    return { runId, inputIds }
  }

  it('marks a v56 scoped-spelling legacy row ambiguous and refuses both colliding request ids', async () => {
    const { runId, inputIds, rows } = await (async () => {
      const result = await upgradeV56Fixture('修登录', (id) => [
        `rinp_${id}_independent-upgrade-01`
      ])
      return {
        ...result,
        rows: () =>
          db.db
            .prepare('SELECT COUNT(*) AS count FROM routing_inputs WHERE run_id = ?')
            .get(result.runId) as { count: number }
      }
    })()
    const legacyId = inputIds[0]!
    // 迁移结果可观察：身份候选不唯一（作用域短段 / 裸长段），显式标记歧义，不写入候选。
    const legacyRow = db.getRoutingInput(legacyId)!
    expect(legacyRow.request_id).toBeNull()
    expect(legacyRow.request_id_state).toBe('ambiguous')
    expect(db.listSubActions(legacyId)).toHaveLength(1)
    // 原请求重放：疑似重放不得静默当作新提交——显式冲突。
    await expect(
      call('orchestration.entrySubmit', {
        group,
        text: '修登录',
        requestId: 'independent-upgrade-01'
      })
    ).rejects.toMatchObject({ code: 'lifecycle_conflict' })
    // 另一个合法请求（裸长段）：不得被静默合并进旧行——同样显式冲突。
    await expect(
      call('orchestration.entrySubmit', {
        group,
        text: '修登录',
        requestId: `${runId}_independent-upgrade-01`
      })
    ).rejects.toMatchObject({ code: 'lifecycle_conflict' })
    // 两次冲突提交都不落账；原输入与动作引用原样保留。
    expect(rows().count).toBe(2)
    expect(db.listSubActions(legacyId)).toHaveLength(1)
    // 歧义状态经 entryShow 暴露给调用者（request_id_state 可观察）。
    const show = await call<{
      inputs: {
        input: { input_id: string; request_id: string | null; request_id_state: string | null }
      }[]
    }>('orchestration.entryShow', { group })
    const exposed = show.inputs.find((entry) => entry.input.input_id === legacyId)!
    expect(exposed.input.request_id).toBeNull()
    expect(exposed.input.request_id_state).toBe('ambiguous')
  })

  it('marks v56 rows that spell random ids ambiguous and never binds them to a request', async () => {
    const randomId = generateId('rinp')
    const { inputIds, rows } = await (async () => {
      const result = await upgradeV56Fixture('修登录', () => ['rinp_123456abcdef', randomId])
      return {
        ...result,
        rows: () =>
          db.db
            .prepare('SELECT COUNT(*) AS count FROM routing_inputs WHERE run_id = ?')
            .get(result.runId) as { count: number }
      }
    })()
    const [legacyId, randomRowId] = inputIds
    // 12 位 hex 旧行与随机登记行同形：两者都无法证明来源——标记歧义，不回填身份。
    for (const inputId of [legacyId, randomRowId]) {
      const row = db.getRoutingInput(inputId!)!
      expect(row.request_id).toBeNull()
      expect(row.request_id_state).toBe('ambiguous')
    }
    // 疑似重放（12 位 hex 请求 ID）：不静默新增、也不静默复用——显式冲突。
    await expect(
      call('orchestration.entrySubmit', {
        group,
        text: '修登录',
        requestId: '123456abcdef'
      })
    ).rejects.toMatchObject({ code: 'lifecycle_conflict' })
    // 对照：随机生成的记录不会被绑定到客户端请求（request_id 保持 NULL）。
    expect(db.getRoutingInput(randomRowId!)!.request_id).toBeNull()
    expect(rows().count).toBe(3)
    expect(db.listSubActions(legacyId!)).toHaveLength(1)
  })

  it('backfills the bare explanation when the scoped suffix is too short to be a request id', async () => {
    // input_id=rinp_<R>_x：裸解释（<R>_x，18 字符）合法，作用域解释（x，1 字符）不合法
    // ——裸格式是唯一解释，迁移回填整段身份。
    const { runId, inputIds, rows } = await (async () => {
      const result = await upgradeV56Fixture('修登录', (id) => [`rinp_${id}_x`])
      return {
        ...result,
        rows: () =>
          db.db
            .prepare('SELECT COUNT(*) AS count FROM routing_inputs WHERE run_id = ?')
            .get(result.runId) as { count: number }
      }
    })()
    const legacyId = inputIds[0]!
    const legacyRequestId = `${runId}_x`
    const migrated = db.getRoutingInput(legacyId)!
    expect(migrated.request_id).toBe(legacyRequestId)
    expect(migrated.request_id_state).toBeNull()
    // 原请求重放：复用原 input_id，账本不变，动作引用保留。
    const replay = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '修登录',
      requestId: legacyRequestId
    })
    expect(replay.input.input_id).toBe(legacyId)
    expect(rows().count).toBe(2)
    expect(db.listSubActions(legacyId)).toHaveLength(1)
  })

  it('backfills the scoped explanation when a full-length request id makes the bare form overlong', async () => {
    // input_id=rinp_<R>_<64 个 x>：客户端 ID 满长（64 字符）合法，整段 81 字符超出裸请求
    // ID 上限——作用域格式是唯一解释，迁移回填客户端 ID。
    const fullLengthRequestId = 'x'.repeat(64)
    const { inputIds, rows } = await (async () => {
      const result = await upgradeV56Fixture('修登录', (id) => [
        `rinp_${id}_${fullLengthRequestId}`
      ])
      return {
        ...result,
        rows: () =>
          db.db
            .prepare('SELECT COUNT(*) AS count FROM routing_inputs WHERE run_id = ?')
            .get(result.runId) as { count: number }
      }
    })()
    const legacyId = inputIds[0]!
    const migrated = db.getRoutingInput(legacyId)!
    expect(migrated.request_id).toBe(fullLengthRequestId)
    expect(migrated.request_id_state).toBeNull()
    // 原请求重放：复用原 input_id，账本不变，动作引用保留。
    const replay = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '修登录',
      requestId: fullLengthRequestId
    })
    expect(replay.input.input_id).toBe(legacyId)
    expect(rows().count).toBe(2)
    expect(db.listSubActions(legacyId)).toHaveLength(1)
  })

  it('lets another project register an ambiguous-spelling request id on its own', async () => {
    // 项目 A 的随机同形歧义行只影响项目 A 自己：项目 B 用同一请求 ID 独立登记并正常重放。
    const otherGroup = `${group}_b`
    const { inputIds, rows } = await (async () => {
      const result = await upgradeV56Fixture('修登录', () => ['rinp_eeffab123456'])
      return {
        ...result,
        rows: () =>
          db.db.prepare('SELECT COUNT(*) AS count FROM routing_inputs').get() as { count: number }
      }
    })()
    const legacyId = inputIds[0]!
    expect(db.getRoutingInput(legacyId)!.request_id).toBeNull()
    expect(db.getRoutingInput(legacyId)!.request_id_state).toBe('ambiguous')
    // 项目 A：同请求 ID 仍收到明确冲突，旧行原样。
    await expect(
      call('orchestration.entrySubmit', { group, text: '修登录', requestId: 'eeffab123456' })
    ).rejects.toMatchObject({ code: 'lifecycle_conflict' })
    expect(db.getRoutingInput(legacyId)!.request_id).toBeNull()
    expect(db.listSubActions(legacyId)).toHaveLength(1)
    // 项目 B：独立登记（归属 B 的 Run），且同 ID 重放复用 B 自己的输入。
    const other = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group: otherGroup,
      text: '修登录',
      requestId: 'eeffab123456'
    })
    const otherRun = entryRunOfInput(db, otherGroup, other.input.input_id)
    expect(otherRun.id).not.toBe(entryRunOfInput(db, group, legacyId).id)
    expect(db.getRoutingInput(other.input.input_id)?.run_id).toBe(otherRun.id)
    const otherReplay = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group: otherGroup,
      text: '修登录',
      requestId: 'eeffab123456'
    })
    expect(otherReplay.input.input_id).toBe(other.input.input_id)
    // 全账本仍是三条：锚定 + A 歧义行 + B 独立输入。
    expect(rows().count).toBe(3)
  })

  it('avoids the soft-deleted primary key and re-registers a retry after entryDelete', async () => {
    // v56 旧记录升级为歧义行（request_id NULL + ambiguous），删除前同 ID 重试显式冲突。
    const { runId, inputIds, rows } = await (async () => {
      const result = await upgradeV56Fixture('修登录', (id) => [`rinp_${id}_independent-retry-01`])
      return {
        ...result,
        rows: () =>
          db.db.prepare('SELECT COUNT(*) AS count FROM routing_inputs').get() as { count: number }
      }
    })()
    const legacyId = inputIds[0]!
    const migrated = db.getRoutingInput(legacyId)!
    expect(migrated.request_id).toBeNull()
    expect(migrated.request_id_state).toBe('ambiguous')
    await expect(
      call('orchestration.entrySubmit', {
        group,
        text: '修登录',
        requestId: 'independent-retry-01'
      })
    ).rejects.toMatchObject({ code: 'lifecycle_conflict' })
    expect(rows().count).toBe(2)
    // 软删除旧请求（scope=request）：软删标记落上，物理行与歧义标记保留。
    await call('orchestration.entryDelete', {
      scope: 'request',
      group,
      input: legacyId
    })
    const deletedRow = db.db
      .prepare(
        'SELECT entry_deleted_at, request_id, request_id_state FROM routing_inputs WHERE input_id = ?'
      )
      .get(legacyId) as {
      entry_deleted_at: string | null
      request_id: string | null
      request_id_state: string | null
    }
    expect(deletedRow.entry_deleted_at).not.toBeNull()
    expect(deletedRow.request_id).toBeNull()
    expect(deletedRow.request_id_state).toBe('ambiguous')
    // 删除后重试：避让旧主键，登记一个不同的 input_id，并持久化原客户端 request_id。
    const retried = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '修登录',
      requestId: 'independent-retry-01'
    })
    expect(retried.input.input_id).not.toBe(legacyId)
    expect(retried.input.input_id.startsWith(`rinp_${runId}_independent-retry-01_`)).toBe(true)
    expect(db.getRoutingInput(retried.input.input_id)?.request_id).toBe('independent-retry-01')
    expect(rows().count).toBe(3)
    // 再次重放：复用新输入，不新增第三条相关记录。
    const replay = await call<{ input: { input_id: string } }>('orchestration.entrySubmit', {
      group,
      text: '修登录',
      requestId: 'independent-retry-01'
    })
    expect(replay.input.input_id).toBe(retried.input.input_id)
    expect(rows().count).toBe(3)
    // 同请求 ID 改变文本或循环选项：仍返回明确冲突。
    await expect(
      call('orchestration.entrySubmit', {
        group,
        text: '修启动',
        requestId: 'independent-retry-01'
      })
    ).rejects.toMatchObject({ code: 'lifecycle_conflict' })
    await expect(
      call('orchestration.entrySubmit', {
        group,
        text: '修登录',
        loop: true,
        requestId: 'independent-retry-01'
      })
    ).rejects.toMatchObject({ code: 'lifecycle_conflict' })
    expect(rows().count).toBe(3)
  })
})
