import type { OrchestrationDb } from '../orchestration-db'

export function migrateV58(this: OrchestrationDb, current: number): void {
  if (current >= 58) {
    return
  }
  // 探测式加列：重放迁移的夹具可能用当前建表 SQL 造出已含本列的「旧版本号」库。
  for (const table of ['routing_inputs', 'routing_sub_actions']) {
    for (const column of ['entry_deleted_at', 'entry_error']) {
      if (!this.hasColumn(table, column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`)
      }
    }
  }
}
