import type { OrchestrationDb } from '../orchestration-db'

/** v62：撤销 v61 旧版对统一路由决定的误回填（§派发授权）。v61 初版没有 strategy 条件，
 *  把「决定已提交、保持未写入」的中断产物、手动规划（entryPlan）等统一路由决定也回填成
 *  dispatchAuthorized=true——这些账本无法把回填值与真实授权区分开，不能继续当成授权
 *  证据：撤销统一路由行上「dispatchAuthorized=true 且无 dispatchHold 且无来源标记」的
 *  回填值，改写派发保持（待授权）；已绑定/已受理的动作与回执原样保留，泵不重派已绑定
 *  行，需要派发时由用户显式 dispatch=true。真实 dispatch=true 的授权从不带来源标记且
 *  一定清除了保持（dispatchHold 缺失）——凡带来源标记或保持仍在的行不是本迁移产物，
 *  不动。 */
export function migrateV62(this: OrchestrationDb, current: number): void {
  if (current >= 62) {
    return
  }
  this.db.exec(`
    UPDATE routing_inputs
       SET decision_json = json_remove(
             json_set(decision_json, '$.dispatchHold', json('true')),
             '$.dispatchAuthorized', '$.dispatchAuthorizedSource'
           )
     WHERE decision_status = 'decided'
       AND json_valid(decision_json)
       AND json_extract(decision_json, '$.dispatchAuthorized') IS NOT NULL
       AND json_extract(decision_json, '$.dispatchHold') IS NULL
       AND json_extract(decision_json, '$.dispatchAuthorizedSource') IS NULL
       AND json_extract(decision_json, '$.decision.strategy') = 'unified_agent'
  `)
}
