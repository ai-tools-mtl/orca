import type { OrchestrationDb } from '../orchestration-db'

/** Plan §5.2 (phase B): a sub-action has one valid execution target at a time. The claim names
 *  it; handbacks record the release and bump the claim version so stale re-claims fail. */
export function migrateV54(this: OrchestrationDb, current: number): void {
  if (current >= 54) {
    return
  }
  // 探测式加列：重放迁移的夹具可能用当前建表 SQL 造出已含本列的「旧版本号」库。
  if (!this.hasColumn('routing_sub_actions', 'claimed_dispatch_id')) {
    this.db.exec('ALTER TABLE routing_sub_actions ADD COLUMN claimed_dispatch_id TEXT')
  }
  if (!this.hasColumn('routing_sub_actions', 'claim_version')) {
    this.db.exec(
      'ALTER TABLE routing_sub_actions ADD COLUMN claim_version INTEGER NOT NULL DEFAULT 0'
    )
  }
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS routing_sub_action_handbacks (
      sub_action_id     TEXT NOT NULL,
      claim_version     INTEGER NOT NULL,
      handed_back_from  TEXT NOT NULL,
      reason            TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_routing_handbacks_sub_action
      ON routing_sub_action_handbacks(sub_action_id);
  `)
}
