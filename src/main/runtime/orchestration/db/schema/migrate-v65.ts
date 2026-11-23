import type { OrchestrationDb } from '../orchestration-db'

/** v65：派发授权语义改造的旧账本兼容（§派发授权）。新登记的决定落库即带 dispatchHold
 *  （未授权），只有通过权限检查的 dispatch=true 写入 dispatchAuthorized。历史账本没有
 *  这两个键。回填按「可证明的持久化证据」分两类：
 *  - 非统一路由的历史决定（decision.strategy 非 'unified_agent'，v55 时代及更早的登记）：
 *    当时语义就是「决定即派发意图」，回填 dispatchAuthorized。
 *  - 统一路由决定（strategy='unified_agent'）：dispatch:false 正常路径带 dispatchHold；
 *    两键均缺只可能是「决定已提交、保持未写入」的中断产物或手动规划（entryPlan）——
 *    无法证明授权来源，保持待授权不回填。已绑定/已受理的动作与回执原样保留，泵不重派
 *    已绑定行；需要派发时由用户显式 dispatch=true。被旧版本回填过的账本由 v62 撤销。 */
export function migrateV65(this: OrchestrationDb, current: number): void {
  if (current >= 65) {
    return
  }
  this.db.exec(`
    UPDATE routing_inputs
       SET decision_json = json_set(decision_json, '$.dispatchAuthorized', json('true'))
     WHERE decision_status = 'decided'
       AND json_valid(decision_json)
       AND json_extract(decision_json, '$.dispatchHold') IS NULL
       AND json_extract(decision_json, '$.dispatchAuthorized') IS NULL
       AND (
         json_extract(decision_json, '$.decision.strategy') IS NULL
         OR json_extract(decision_json, '$.decision.strategy') <> 'unified_agent'
       )
  `)
}
