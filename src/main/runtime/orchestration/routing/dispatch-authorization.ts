import type { OrchestrationDb } from '../db/orchestration-db'

// 派发授权（§派发授权）的持久化语义：决定落库即未授权（dispatchHold 与决定同一 SAVEPOINT），
// 只有通过权限检查的 dispatch=true 才原子写入 dispatchAuthorized（授权翻转不存在中间态）。
// 自动派发与恢复推进均以持久化授权为准；迟到的 false 不得撤销已发生的授权。

function parseDecisionObject(raw: string | null): Record<string, unknown> | undefined {
  if (!raw?.startsWith('{')) {
    return undefined
  }
  try {
    const value: unknown = JSON.parse(raw)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** dispatch=false 登记的决定带派发保持：阶段推进器不得派发该输入的阶段，直到某次
 *  dispatch=true 触达清除（区分「决定已登记」与「派发已受理」）。存在 decision_json 内，
 *  不改表结构。 */
export function setRoutingDispatchHold(
  this: OrchestrationDb,
  inputId: string,
  hold: boolean
): void {
  const row = this.getRoutingInput(inputId)
  if (!row || row.decision_status !== 'decided') {
    return
  }
  const decision = parseDecisionObject(row.decision_json)
  if ((decision?.dispatchHold === true) === hold) {
    return
  }
  const next = JSON.stringify({
    ...decision,
    ...(hold ? { dispatchHold: true } : { dispatchHold: undefined })
  })
  this.db
    .prepare(
      "UPDATE routing_inputs SET decision_json = ? WHERE input_id = ? AND decision_status = 'decided'"
    )
    .run(next, inputId)
}

/** 读输入行的派发保持标记（decision_json.dispatchHold === true）。 */
export function routingInputDispatchHold(row: { decision_json: string | null }): boolean {
  return parseDecisionObject(row.decision_json)?.dispatchHold === true
}

/** 授权翻转（原子）：一次 UPDATE 写入 dispatchAuthorized 并清除 dispatchHold——「授权生效」
 *  不存在中间态。只有通过权限检查的 dispatch=true 路径调用。 */
export function grantRoutingDispatch(this: OrchestrationDb, inputId: string): void {
  const row = this.getRoutingInput(inputId)
  if (!row || row.decision_status !== 'decided') {
    return
  }
  if (routingInputDispatchAuthorized(row) && !routingInputDispatchHold(row)) {
    return
  }
  const decision = parseDecisionObject(row.decision_json)
  const next = JSON.stringify({
    ...decision,
    dispatchAuthorized: true,
    dispatchHold: undefined
  })
  this.db
    .prepare(
      "UPDATE routing_inputs SET decision_json = ? WHERE input_id = ? AND decision_status = 'decided'"
    )
    .run(next, inputId)
}

/** 未授权语义兜底（幂等）：重放 false 或旧中断产物（决定已落库但既无保持也无授权）补写
 *  派发保持；已授权的输入不受影响——迟到的 false 不得撤销已发生的授权。 */
export function ensureRoutingDispatchHold(this: OrchestrationDb, inputId: string): void {
  const row = this.getRoutingInput(inputId)
  if (!row || row.decision_status !== 'decided' || routingInputDispatchAuthorized(row)) {
    return
  }
  setRoutingDispatchHold.call(this, inputId, true)
}

export function withDecisionFlag(
  decision: unknown,
  key: 'dispatchHold' | 'dispatchAuthorized',
  value: boolean
): unknown {
  const base =
    decision !== null && decision !== undefined && typeof decision === 'object'
      ? (decision as Record<string, unknown>)
      : {}
  return { ...base, [key]: value }
}

/** 派发授权标记：某次 dispatch=true 触达过的输入才能由恢复推进补派尚未受理的动作。
 *  只由 true 写入——并发/迟到的 false 不得抹掉已发生的授权（§派发授权：只有 true 可以
 *  写入派发意图）。 */
export function setRoutingDispatchAuthorized(this: OrchestrationDb, inputId: string): void {
  const row = this.getRoutingInput(inputId)
  if (!row || row.decision_status !== 'decided') {
    return
  }
  if (routingInputDispatchAuthorized(row)) {
    return
  }
  const decision = parseDecisionObject(row.decision_json)
  this.db
    .prepare(
      "UPDATE routing_inputs SET decision_json = ? WHERE input_id = ? AND decision_status = 'decided'"
    )
    .run(JSON.stringify({ ...decision, dispatchAuthorized: true }), inputId)
}

/** 读输入行的派发授权标记（decision_json.dispatchAuthorized === true）。 */
export function routingInputDispatchAuthorized(row: { decision_json: string | null }): boolean {
  return parseDecisionObject(row.decision_json)?.dispatchAuthorized === true
}
