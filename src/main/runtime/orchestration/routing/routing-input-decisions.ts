import { OrchestrationError } from '../orchestration-error'
import { requiresEntryWriteApproval } from './entry-investigation-policy'
import type { DecisionModelSettings } from '../../../../shared/settings/decision-model-settings'
import { generateId } from '../db/generated-id'
import { withDecisionFlag } from './dispatch-authorization'
import type { OrchestrationDb } from '../db/orchestration-db'
import type {
  RoutingInputRow,
  RoutingStageGate,
  RoutingStageKind,
  RoutingSubActionRow
} from '../db/routing-records'

export function registerRoutingInput(
  this: OrchestrationDb,
  input: {
    runId: string
    text: string
    loop?: boolean
    /** The submission's decision-model config, kept for the 循环开发 reviewer pick. */
    reviewModel?: Pick<DecisionModelSettings, 'source' | 'agent'>
    decision?: unknown
    /** 客户端请求 ID：整个提交重放（响应丢失后重试）复用同一输入——按行上的持久化请求
     *  身份判别，不猜 input_id 形状。 */
    requestId?: string
  }
): RoutingInputRow {
  this.requireRun(input.runId)
  this.db.exec('SAVEPOINT register_routing_input')
  try {
    // 提交重放幂等（§提交去重）：查重按持久化的 request_id 列进行——旧格式（rinp_<requestId>）
    // 与当前格式（rinp_<runId>_<requestId>）可派生出完全相同的 input_id，按 ID 形状判别
    // 来源必然有歧义。同 Run 内同 requestId 复用原输入；文本或循环开发选项不一致是冲突
    // （重试复用原输入，主动改写必须换新 ID）。作用域隔离项目：不同项目的同一 requestId
    // 各自登记，互不串号。
    const existing =
      input.requestId === undefined
        ? undefined
        : (this.db
            .prepare('SELECT * FROM routing_inputs WHERE run_id = ? AND request_id = ?')
            .get(input.runId, input.requestId) as RoutingInputRow | undefined)
    if (existing) {
      if (!submissionMatches(existing, input.text, input.loop === true)) {
        // 同请求身份不同提交参数是冲突：不吞掉也不改写原输入；savepoint 由 catch 统一回收。
        throw new OrchestrationError(
          'lifecycle_conflict',
          'This request id was already used for a different submission; send a new request id to submit new content or options.',
          { requestId: input.requestId }
        )
      }
      this.db.exec('RELEASE register_routing_input')
      return existing
    }
    // 派生键或裸键可能撞上两类占用者：
    // - request_id 已证的不同请求（含跨项目、新旧格式结构性碰撞）——两个合法请求各自
    //   登记，加随机后缀避让；重放幂等由 request_id 列保证，不依赖 ID 重新派生。
    // - request_id NULL 的身份未证行（迁移歧义标记或随机登记）——疑似重放不得静默当作
    //   新提交，也不得静默复用：显式冲突交由调用者决断（换新请求 ID，或先删除该历史
    //   请求 / 人工核对后再提交）。
    const requestId = input.requestId
    let id = requestId === undefined ? generateId('rinp') : requestIdInputId(requestId, input.runId)
    if (requestId !== undefined) {
      // 裸键（旧格式形状）同样可能撞上身份未证行：12 位 hex 请求 ID 与随机登记 ID 同形。
      // 裸格式查重与派生查重一样限定在本入口的 Run——其他项目的同形行（哪怕身份未证）
      // 不阻断本项目独立登记。软删除行不算活跃请求：删除后重试放行，由物理占用检查避让。
      const bareSpellingHit = this.getRoutingInput(`rinp_${requestId}`)
      if (
        bareSpellingHit &&
        bareSpellingHit.run_id === input.runId &&
        bareSpellingHit.request_id === null
      ) {
        throw unresolvedIdentityConflict(requestId, bareSpellingHit)
      }
      for (;;) {
        // 物理 input_id 占用（含软删除行）：SQLite 主键仍被占用就必须避让——getRoutingInput
        // 过滤软删除行，会把派生键误判为可用。活跃且身份未证（迁移歧义或随机登记）的占用
        // 者保持显式冲突；软删除行已由调用者显式删除，避让旧主键后重新登记，原行与历史
        // 引用全部保留。
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the projection is exactly RoutingInputRow plus the soft-delete marker.
        const occupant = this.db
          .prepare('SELECT * FROM routing_inputs WHERE input_id = ?')
          .get(id) as (RoutingInputRow & { entry_deleted_at: string | null }) | undefined
        if (!occupant) {
          break
        }
        if (occupant.entry_deleted_at === null && occupant.request_id === null) {
          throw unresolvedIdentityConflict(requestId, occupant)
        }
        id = `${id}_${generateId('rinp').slice(5)}`
      }
    }
    this.db
      .prepare(
        `INSERT INTO routing_inputs (input_id, run_id, raw_text, received_seq, decision_status, decision_json, request_id, loop_dev, review_model_json, require_write_approval)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(received_seq), 0) + 1 FROM routing_inputs WHERE run_id = ?), 'received', NULL, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.runId,
        input.text,
        input.runId,
        input.requestId ?? null,
        input.loop ? 1 : 0,
        input.reviewModel
          ? JSON.stringify({ source: input.reviewModel.source, agent: input.reviewModel.agent })
          : null,
        Number(requiresEntryWriteApproval(input.text))
      )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetch reads back exactly the row just inserted.
    const row = this.getRoutingInput(id) as RoutingInputRow
    this.db.exec('RELEASE register_routing_input')
    return row
  } catch (error) {
    this.db.exec('ROLLBACK TO register_routing_input')
    this.db.exec('RELEASE register_routing_input')
    throw error
  }
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/

/** 身份未证的占用行（迁移歧义标记或系统随机登记）：疑似重放不得静默当作新提交，也不得
 *  静默复用——显式冲突交由调用者决断（换新请求 ID，或先删除该历史请求/人工核对）。 */
function unresolvedIdentityConflict(
  requestId: string,
  occupant: RoutingInputRow
): OrchestrationError {
  return new OrchestrationError(
    'lifecycle_conflict',
    'This request id collides with an existing input whose request identity could not be verified (migrated as ambiguous, or system-generated). Use a new request id, or delete that input first.',
    { requestId, inputId: occupant.input_id }
  )
}

/** 重复提交的复用判定：文本与循环开发选项（省略 = false）都一致才复用原输入，任何一项
 *  不同都是提交参数冲突。 */
function submissionMatches(existing: RoutingInputRow, text: string, loop: boolean): boolean {
  return existing.raw_text === text && Number(existing.loop_dev) === Number(loop)
}

/** 客户端请求 ID → 稳定输入 ID：作用域是入口的 Run（入口身份 + 项目），rinp_ 前缀 + 受限
 *  字符集（runId/requestId 都是 [A-Za-z0-9_-]），防注入/碰撞；不同项目的同一 requestId
 *  派生不同输入。 */
export function requestIdInputId(requestId: string, runScope: string): string {
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new OrchestrationError(
      'invalid_argument',
      'The request id must be 8–64 characters of letters, digits, "_" or "-", starting with a letter or digit.',
      { requestId }
    )
  }
  return `rinp_${runScope}_${requestId}`
}

export function registerRoutingDecision(
  this: OrchestrationDb,
  input: {
    inputId: string
    /** One entry per sub-action, in input order; each becomes sa-{input num}-{ordinal}. */
    subActions: {
      text: string
      constraints?: string[]
      taskId?: string | null
      stageKind?: RoutingStageKind
      gate?: RoutingStageGate
      /** Upstream edges: 1-based seqs within this batch, or existing sub_action_ids. */
      dependsOn?: (number | string)[]
      agentHint?: string | null
    }[]
    decision?: unknown
    /** 决定落库即带授权语义（§派发授权，与决定同一 SAVEPOINT 原子写入）：
     *  'hold'（默认）= 未授权，轮询不派发；'granted' = 通过权限检查的显式派发意图
     *  （operator 手动规划入口）。中断只会留下「已登记且未授权」或「已登记且已授权」
     *  两种自洽状态，不会出现无授权语义的中间态。 */
    dispatchIntent?: 'hold' | 'granted'
  }
): { subActions: RoutingSubActionRow[]; reused: boolean } {
  const source = this.getRoutingInput(input.inputId)
  if (!source) {
    throw new OrchestrationError(
      'lifecycle_not_found',
      `Routing input ${input.inputId} was not found.`,
      { inputId: input.inputId }
    )
  }
  this.db.exec('SAVEPOINT register_routing_decision')
  try {
    // §5.1: one decision per input version. A re-registration after a restart reuses the
    // recorded sub-actions (same stable ids) instead of minting a second set.
    if (source.decision_status === 'decided') {
      const existing = this.listSubActions(input.inputId)
      this.db.exec('RELEASE register_routing_decision')
      return { subActions: existing, reused: true }
    }
    // The stable id's num comes from the input row's ordinal, so `sa-{num}-{k}` is globally unique.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the COUNT(*) projection is exactly { seq: number }.
    const num = this.db
      .prepare(
        'SELECT COUNT(*) AS seq FROM routing_inputs WHERE rowid <= (SELECT rowid FROM routing_inputs WHERE input_id = ?)'
      )
      .get(input.inputId) as { seq: number } | undefined
    if (!num) {
      throw new OrchestrationError(
        'lifecycle_not_found',
        `Routing input ${input.inputId} was not found while numbering sub-actions.`,
        { inputId: input.inputId }
      )
    }
    const decisionPayload =
      input.dispatchIntent === 'granted'
        ? withDecisionFlag(input.decision, 'dispatchAuthorized', true)
        : withDecisionFlag(input.decision, 'dispatchHold', true)
    const committed = this.db
      .prepare(
        `UPDATE routing_inputs SET decision_status = 'decided', decision_json = ?, entry_error = NULL
         WHERE input_id = ? AND entry_deleted_at IS NULL`
      )
      .run(decisionPayload === undefined ? null : JSON.stringify(decisionPayload), input.inputId)
    if (committed.changes === 0) {
      throw new OrchestrationError('lifecycle_not_found', 'The routing input was deleted.', {
        inputId: input.inputId
      })
    }
    // Batch ids resolve relative dependsOn seqs (1-based) before any row is written.
    const ids = input.subActions.map((_, index) => `sa-${num.seq}-${index + 1}`)
    const rows = input.subActions.map((subAction, index) => {
      const dependsOn = (subAction.dependsOn ?? [])
        .map((edge) => (typeof edge === 'number' ? ids[edge - 1] : edge))
        .filter((id): id is string => typeof id === 'string' && id !== ids[index])
      const id = ids[index]!
      this.db
        .prepare(
          `INSERT INTO routing_sub_actions
             (sub_action_id, input_id, run_id, seq, text, constraints_json, task_id,
              stage_kind, depends_on_json, gate, agent_hint)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.inputId,
          source.run_id,
          index + 1,
          subAction.text,
          JSON.stringify(subAction.constraints ?? []),
          subAction.taskId ?? null,
          subAction.stageKind ?? null,
          dependsOn.length > 0 ? JSON.stringify(dependsOn) : null,
          subAction.gate ?? null,
          subAction.agentHint ?? null
        )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetch reads back exactly the row just inserted.
      return this.getSubAction(id) as RoutingSubActionRow
    })
    this.db.exec('RELEASE register_routing_decision')
    return { subActions: rows, reused: false }
  } catch (error) {
    this.db.exec('ROLLBACK TO register_routing_decision')
    this.db.exec('RELEASE register_routing_decision')
    throw error
  }
}

export function getRoutingInput(
  this: OrchestrationDb,
  inputId: string
): RoutingInputRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db
    .prepare('SELECT * FROM routing_inputs WHERE input_id = ? AND entry_deleted_at IS NULL')
    .get(inputId) as RoutingInputRow | undefined
}
