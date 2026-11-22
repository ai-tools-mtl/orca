import type { OrchestrationDb } from '../orchestration-db'

/** 阶段化生命周期 (entry-stage-pipeline-plan §4): stage kind, dependency edges, user gates and
 *  the plan payload on the routing ledger — a plan sub-action's orca-plan expands into an
 *  implement chain on the user's gate grant. */
export function migrateV53(this: OrchestrationDb, current: number): void {
  if (current >= 53) {
    return
  }
  this.db.exec(`
    ALTER TABLE routing_sub_actions ADD COLUMN stage_kind TEXT;
    ALTER TABLE routing_sub_actions ADD COLUMN depends_on_json TEXT;
    ALTER TABLE routing_sub_actions ADD COLUMN gate TEXT;
    ALTER TABLE routing_sub_actions ADD COLUMN gate_granted_at TEXT;
    ALTER TABLE routing_sub_actions ADD COLUMN agent_hint TEXT;
    ALTER TABLE routing_sub_actions ADD COLUMN plan_json TEXT;
    ALTER TABLE routing_sub_actions ADD COLUMN plan_source_id TEXT;
  `)
}
