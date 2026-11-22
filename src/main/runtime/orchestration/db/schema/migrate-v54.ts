import type { OrchestrationDb } from '../orchestration-db'

export function migrateV54(this: OrchestrationDb, current: number): void {
  if (current >= 54) {
    return
  }
  this.db.exec(`
    ALTER TABLE routing_inputs ADD COLUMN entry_deleted_at TEXT;
    ALTER TABLE routing_inputs ADD COLUMN entry_error TEXT;
    ALTER TABLE routing_sub_actions ADD COLUMN entry_deleted_at TEXT;
    ALTER TABLE routing_sub_actions ADD COLUMN entry_error TEXT;
  `)
}
