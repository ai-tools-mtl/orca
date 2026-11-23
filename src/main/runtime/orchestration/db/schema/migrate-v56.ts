import type { OrchestrationDb } from '../orchestration-db'

/** Entry card automation (§5.5/§5.6/§7): per-card pause and same-folder queueing on the
 *  routing ledger, the 循环开发（本次） submission flag, and the review loop's live dispatch
 *  bookkeeping columns. */
export function migrateV56(this: OrchestrationDb, current: number): void {
  if (current >= 56) {
    return
  }
  // 探测式加列：重放迁移的夹具可能用当前建表 SQL 造出已含本列的「旧版本号」库。
  if (!this.hasColumn('routing_inputs', 'loop_dev')) {
    this.db.exec('ALTER TABLE routing_inputs ADD COLUMN loop_dev INTEGER NOT NULL DEFAULT 0')
  }
  if (!this.hasColumn('routing_inputs', 'review_model_json')) {
    this.db.exec('ALTER TABLE routing_inputs ADD COLUMN review_model_json TEXT')
  }
  if (!this.hasColumn('routing_sub_actions', 'paused_at')) {
    this.db.exec('ALTER TABLE routing_sub_actions ADD COLUMN paused_at TEXT')
  }
  if (!this.hasColumn('routing_sub_actions', 'queued_at')) {
    this.db.exec('ALTER TABLE routing_sub_actions ADD COLUMN queued_at TEXT')
  }
  if (!this.hasColumn('review_cycles', 'active_writer_dispatch_id')) {
    this.db.exec('ALTER TABLE review_cycles ADD COLUMN active_writer_dispatch_id TEXT')
  }
  if (!this.hasColumn('review_cycles', 'active_reviewer_dispatch_id')) {
    this.db.exec('ALTER TABLE review_cycles ADD COLUMN active_reviewer_dispatch_id TEXT')
  }
  if (!this.hasColumn('review_cycles', 'reviewed_dispatch_id')) {
    this.db.exec('ALTER TABLE review_cycles ADD COLUMN reviewed_dispatch_id TEXT')
  }
}
