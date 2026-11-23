import type { OrchestrationDb } from '../orchestration-db'

/** Phase-A runtime facts (plan §5.3/§5.5/§6): per-sub-action card state, first-action evidence
 *  on attempts, and the entry-level pause control admission re-checks before every send. */
export function migrateV53(this: OrchestrationDb, current: number): void {
  if (current >= 53) {
    return
  }
  // 探测式加列：重放迁移的夹具可能用当前建表 SQL 造出已含本列的「旧版本号」库。
  if (!this.hasColumn('routing_sub_actions', 'state')) {
    this.db.exec(`
      ALTER TABLE routing_sub_actions ADD COLUMN state TEXT NOT NULL DEFAULT 'registered'
        CHECK(state IN ('registered', 'delivered', 'processed', 'violated', 'pending_verification'))
    `)
  }
  if (!this.hasColumn('routing_supplement_attempts', 'first_action_json')) {
    this.db.exec('ALTER TABLE routing_supplement_attempts ADD COLUMN first_action_json TEXT')
  }
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS routing_controls (
      run_id    TEXT PRIMARY KEY,
      paused_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
}
