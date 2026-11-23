import type { OrchestrationDb } from '../orchestration-db'

export function migrateV60(this: OrchestrationDb, current: number): void {
  if (current >= 60) {
    return
  }
  // 探测式加列：重放迁移的夹具可能用当前建表 SQL 造出已含本列的「旧版本号」库。
  if (!this.hasColumn('routing_inputs', 'require_write_approval')) {
    this.db.exec('ALTER TABLE routing_inputs ADD COLUMN require_write_approval INTEGER')
  }
  if (!this.hasColumn('review_cycles', 'reviewed_workspace_revision')) {
    this.db.exec('ALTER TABLE review_cycles ADD COLUMN reviewed_workspace_revision TEXT')
  }
  this.db.exec(`
    PRAGMA secure_delete = ON;
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
    CREATE TABLE IF NOT EXISTS entry_review_dispatch_intents (
      intent_id TEXT PRIMARY KEY,
      sub_action_id TEXT NOT NULL REFERENCES routing_sub_actions(sub_action_id) ON DELETE CASCADE,
      spec_json TEXT NOT NULL,
      dispatch_id TEXT
    );
  `)
}
