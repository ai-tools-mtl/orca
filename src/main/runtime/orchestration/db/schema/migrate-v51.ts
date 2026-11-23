import type { OrchestrationDb } from '../orchestration-db'

/** Routing ledger tables: persistent inputs, sub-actions, targeted supplement deliveries. */
export function migrateV51(this: OrchestrationDb, current: number): void {
  if (current >= 51) {
    return
  }
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS routing_inputs (
      input_id        TEXT PRIMARY KEY,
      run_id          TEXT NOT NULL,
      raw_text        TEXT NOT NULL,
      received_seq    INTEGER NOT NULL,
      decision_status TEXT NOT NULL DEFAULT 'received'
        CHECK(decision_status IN ('received', 'decided')),
      decision_json   TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_routing_inputs_run ON routing_inputs(run_id);
    CREATE TABLE IF NOT EXISTS routing_sub_actions (
      sub_action_id    TEXT PRIMARY KEY,
      input_id         TEXT NOT NULL,
      run_id           TEXT NOT NULL,
      seq              INTEGER NOT NULL,
      text             TEXT NOT NULL,
      constraints_json TEXT NOT NULL DEFAULT '[]',
      task_id          TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_routing_sub_actions_input ON routing_sub_actions(input_id);
    CREATE TABLE IF NOT EXISTS routing_supplements (
      supplement_id      TEXT PRIMARY KEY,
      input_id           TEXT NOT NULL,
      sub_action_id      TEXT NOT NULL,
      run_id             TEXT NOT NULL,
      target_dispatch_id TEXT NOT NULL,
      raw_text           TEXT NOT NULL,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_routing_supplements_sub_action
      ON routing_supplements(sub_action_id);
    CREATE TABLE IF NOT EXISTS routing_supplement_attempts (
      attempt_id         TEXT PRIMARY KEY,
      supplement_id      TEXT NOT NULL,
      request_id         TEXT NOT NULL,
      target_dispatch_id TEXT NOT NULL,
      -- Null only on refusals recorded before any expected turn was established.
      expected_turn_id   TEXT,
      outcome            TEXT NOT NULL
        CHECK(outcome IN ('delivered', 'refused', 'unverified')),
      refusal_kind       TEXT,
      detail             TEXT,
      turn_id            TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_routing_supplement_attempts_supplement
      ON routing_supplement_attempts(supplement_id);
  `)
}
