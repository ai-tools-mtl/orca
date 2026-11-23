import type { OrchestrationDb } from '../orchestration-db'

/** v67：任务内写前审批的转派（entry-stage-pipeline-plan §7 方向 2）。写入审批 Allow 不再放行
 *  原 worker 会话内写入，而是铸一条 write_granted 的 implement 阶段行交给 agent_hint 的
 *  新 worker（同 worktree）；write_granted_at 即该行的显式写入放行标记，只豁免本行只读。 */
export function migrateV67(this: OrchestrationDb, current: number): void {
  if (current >= 67) {
    return
  }
  // 探测式加列：重放迁移的夹具可能用当前建表 SQL 造出已含本列的「旧版本号」库。
  if (!this.hasColumn('routing_sub_actions', 'write_granted_at')) {
    this.db.exec('ALTER TABLE routing_sub_actions ADD COLUMN write_granted_at TEXT')
  }
}
