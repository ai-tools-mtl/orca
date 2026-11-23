import type { OrchestrationDb } from '../orchestration-db'

/** v64：补充的来源身份（routing_supplements.origin，§按动作核对受理）。路由生成的续接
 *  （taskReferences 绑定行）与用户主动补充共用同一子动作时必须有独立受理记录——显式派发
 *  与恢复推进按稳定动作 ID 找「路由自己的补充」，用户补充不能替代它，也不能被它替代。
 *
 *  旧账本回填：路由路径登记补充的文本恒等于子动作文本（deliverTaskReference 用
 *  action.text），以「路由行 + 文本一致」回填 origin='route'；其余（entrySupplement/转派
 *  等用户路径）保持 DEFAULT 'user'。目标与回执原样保留，重投语义不变。残余歧义：用户在
 *  路由行上恰好以子动作原文补充的行会被当作路由补充——其后果只是退回旧行为（该文本顶替
 *  续接受理），不产生第二条投递。 */
export function migrateV64(this: OrchestrationDb, current: number): void {
  if (current >= 64) {
    return
  }
  // 探测式加列：重放迁移的夹具可能用当前建表 SQL 造出已含本列的「旧版本号」库。
  if (!this.hasColumn('routing_supplements', 'origin')) {
    this.db.exec("ALTER TABLE routing_supplements ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'")
  }
  this.db.exec(`
    UPDATE routing_supplements SET origin = 'route'
    WHERE origin = 'user'
      AND EXISTS (
        SELECT 1 FROM routing_sub_actions sa
        JOIN routing_inputs ri ON ri.input_id = sa.input_id
        WHERE sa.sub_action_id = routing_supplements.sub_action_id
          AND sa.entry_deleted_at IS NULL
          AND ri.decision_status = 'decided'
          AND ri.entry_deleted_at IS NULL
          AND json_valid(ri.decision_json)
          AND json_extract(ri.decision_json, '$.taskReferences[' || (sa.seq - 1) || ']') = sa.task_id
          AND routing_supplements.raw_text = sa.text
      )
  `)
}
