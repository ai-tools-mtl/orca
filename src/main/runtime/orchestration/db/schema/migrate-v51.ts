import type { OrchestrationDb } from '../orchestration-db'

/** Plan §7 write-review pilot (phase C): one review cycle per delegated dev task — writer and
 *  reviewer native threads, frozen revisions, stable opinion ids, user acceptance closes. */
export function migrateV51(this: OrchestrationDb, current: number): void {
  if (current >= 51) {
    return
  }
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS review_cycles (
      cycle_id             TEXT PRIMARY KEY,
      task_id              TEXT NOT NULL,
      writer_dispatch_id   TEXT NOT NULL,
      reviewer_dispatch_id TEXT NOT NULL,
      current_revision     INTEGER NOT NULL DEFAULT 1,
      state                TEXT NOT NULL DEFAULT 'reviewing'
        CHECK(state IN ('reviewing', 'rework', 'accepted')),
      created_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_review_cycles_task ON review_cycles(task_id);
    CREATE TABLE IF NOT EXISTS review_opinions (
      opinion_id  TEXT PRIMARY KEY,
      cycle_id    TEXT NOT NULL,
      revision    INTEGER NOT NULL,
      seq         INTEGER NOT NULL,
      body        TEXT NOT NULL,
      state       TEXT NOT NULL DEFAULT 'blocked'
        CHECK(state IN ('blocked', 'resolved')),
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_review_opinions_cycle ON review_opinions(cycle_id);
  `)
}
