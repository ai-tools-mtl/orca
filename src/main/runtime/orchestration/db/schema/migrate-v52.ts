import type { OrchestrationDb } from '../orchestration-db'

/** Entry card automation (§5.5/§5.6/§7): per-card pause and same-folder queueing on the
 *  routing ledger, the 循环开发（本次） submission flag, and the review loop's live dispatch
 *  bookkeeping columns. */
export function migrateV52(this: OrchestrationDb, current: number): void {
  if (current >= 52) {
    return
  }
  this.db.exec(`
    ALTER TABLE routing_inputs ADD COLUMN loop_dev INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE routing_inputs ADD COLUMN review_model_json TEXT;
    ALTER TABLE routing_sub_actions ADD COLUMN paused_at TEXT;
    ALTER TABLE routing_sub_actions ADD COLUMN queued_at TEXT;
    ALTER TABLE review_cycles ADD COLUMN active_writer_dispatch_id TEXT;
    ALTER TABLE review_cycles ADD COLUMN active_reviewer_dispatch_id TEXT;
    ALTER TABLE review_cycles ADD COLUMN reviewed_dispatch_id TEXT;
  `)
}
