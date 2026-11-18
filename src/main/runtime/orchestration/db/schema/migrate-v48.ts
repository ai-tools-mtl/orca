import type { OrchestrationDb } from '../orchestration-db'

/** Plan §5.3 row 3 / §6: one continuation per sub-action — a settled Dispatch's unconsumed
 *  supplement is continued by exactly one follow-up Dispatch. follow_up_dispatch_id stays null
 *  until the follow-up send accepts (registered-but-not-sent survives restarts). */
export function migrateV48(this: OrchestrationDb, current: number): void {
  if (current >= 48) {
    return
  }
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS routing_sub_action_continuations (
      sub_action_id         TEXT PRIMARY KEY,
      input_id              TEXT NOT NULL,
      source_dispatch_id    TEXT NOT NULL,
      follow_up_dispatch_id TEXT,
      request_id            TEXT NOT NULL,
      created_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_routing_continuations_input
      ON routing_sub_action_continuations(input_id);
  `)
}
