import type { OrchestrationDb } from '../orchestration-db'

/** Phase-A runtime facts (plan §5.3/§5.5/§6): per-sub-action card state, first-action evidence
 *  on attempts, and the entry-level pause control admission re-checks before every send. */
export function migrateV49(this: OrchestrationDb, current: number): void {
  if (current >= 49) {
    return
  }
  this.db.exec(`
    ALTER TABLE routing_sub_actions ADD COLUMN state TEXT NOT NULL DEFAULT 'registered'
      CHECK(state IN ('registered', 'delivered', 'processed', 'violated', 'pending_verification'));
    ALTER TABLE routing_supplement_attempts ADD COLUMN first_action_json TEXT;
    CREATE TABLE IF NOT EXISTS routing_controls (
      run_id    TEXT PRIMARY KEY,
      paused_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
}
