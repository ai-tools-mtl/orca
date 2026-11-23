import type { OrchestrationDb } from '../orchestration-db'

/** 合并检查点（pipeline §8 落地）：merge 行由泵在用户放行后执行 git 合并，merged_at 即结算、
 *  merge_receipt_json 留收据（commit/基础分支）。 */
export function migrateV63(this: OrchestrationDb, current: number): void {
  if (current >= 63) {
    return
  }
  // 探测式加列：重放迁移的夹具可能用当前建表 SQL 造出已含本列的「旧版本号」库。
  if (!this.hasColumn('routing_sub_actions', 'merged_at')) {
    this.db.exec('ALTER TABLE routing_sub_actions ADD COLUMN merged_at TEXT')
  }
  if (!this.hasColumn('routing_sub_actions', 'merge_receipt_json')) {
    this.db.exec('ALTER TABLE routing_sub_actions ADD COLUMN merge_receipt_json TEXT')
  }
}
