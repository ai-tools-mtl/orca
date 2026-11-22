import type { OrchestrationDb } from '../orchestration-db'

export function migrateV56(this: OrchestrationDb, current: number): void {
  if (current >= 56) {
    return
  }
  this.db.exec(`
    PRAGMA secure_delete = ON;
    ALTER TABLE routing_inputs ADD COLUMN require_write_approval INTEGER;
    ALTER TABLE review_cycles ADD COLUMN reviewed_workspace_revision TEXT;
    UPDATE routing_inputs
       SET review_model_json = CASE
         WHEN json_valid(review_model_json)
           THEN json_object('source', json_extract(review_model_json, '$.source'),
                            'agent', json_extract(review_model_json, '$.agent'))
         ELSE NULL END
     WHERE review_model_json IS NOT NULL;
    UPDATE routing_sub_actions
       SET stage_kind = 'clarification', plan_json = NULL
     WHERE stage_kind = 'plan' AND gate = 'user_confirm'
       AND text LIKE '需求澄清与拆解：先把需求整理成一份需求说明%';
    UPDATE routing_sub_actions SET gate_granted_at = NULL
     WHERE gate = 'user_confirm' AND gate_granted_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = routing_sub_actions.task_id AND status = 'completed');
    CREATE TABLE entry_review_dispatch_intents (
      intent_id TEXT PRIMARY KEY,
      sub_action_id TEXT NOT NULL REFERENCES routing_sub_actions(sub_action_id) ON DELETE CASCADE,
      spec_json TEXT NOT NULL,
      dispatch_id TEXT
    );
  `)
}
