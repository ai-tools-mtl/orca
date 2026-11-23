import type { OrchestrationDb } from '../orchestration-db'

/** 阶段化生命周期 (entry-stage-pipeline-plan §4): stage kind, dependency edges, user gates and
 *  the plan payload on the routing ledger — a plan sub-action's orca-plan expands into an
 *  implement chain on the user's gate grant. */
export function migrateV57(this: OrchestrationDb, current: number): void {
  if (current >= 57) {
    return
  }
  // 探测式加列：重放迁移的夹具可能用当前建表 SQL 造出已含本列的「旧版本号」库。
  for (const column of [
    'stage_kind',
    'depends_on_json',
    'gate',
    'gate_granted_at',
    'agent_hint',
    'plan_json',
    'plan_source_id'
  ]) {
    if (!this.hasColumn('routing_sub_actions', column)) {
      this.db.exec(`ALTER TABLE routing_sub_actions ADD COLUMN ${column} TEXT`)
    }
  }
}
