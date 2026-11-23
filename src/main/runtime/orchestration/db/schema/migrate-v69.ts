import type { OrchestrationDb } from '../orchestration-db'

/** v69：执行失败兜底（§能力分工）。指定的 agent 执行失败（usage limit、任务失败、熔断）
 *  即该 agent 当前不可用：同一阶段同一 worktree 由泵立即用兜底 agent（设置默认链排除失败
 *  者）重派一次；fallback_agent 落行即消费标记，二次失败不再自动重派（升级人工照旧）。 */
export function migrateV69(this: OrchestrationDb, current: number): void {
  if (current >= 69) {
    return
  }
  // 探测式加列：重放迁移的夹具可能用当前建表 SQL 造出已含本列的「旧版本号」库。
  if (!this.hasColumn('routing_sub_actions', 'fallback_agent')) {
    this.db.exec('ALTER TABLE routing_sub_actions ADD COLUMN fallback_agent TEXT')
  }
}
