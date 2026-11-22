import type { OrchestrationDb } from '../orchestration-db'

/** 决策模型审计 (entry-stage-pipeline-plan §10 调参参考): 每次决策源分类（含失败）一行——
 *  原始答案、映射结果与当时的阈值分支，供后续对置信度阈值/路线映射做有据调参。 */
export function migrateV55(this: OrchestrationDb, current: number): void {
  if (current >= 55) {
    return
  }
  this.db.exec(`
    CREATE TABLE decision_model_audits (
      audit_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      input_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT NOT NULL,
      model TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('classified', 'error')),
      error_message TEXT,
      http_status INTEGER,
      latency_ms INTEGER,
      credits_used INTEGER,
      input_tokens INTEGER,
      state_json TEXT,
      answers_json TEXT,
      classification_json TEXT,
      applied_json TEXT
    );
    CREATE INDEX idx_decision_model_audits_run ON decision_model_audits(run_id, created_at);
    CREATE INDEX idx_decision_model_audits_input ON decision_model_audits(input_id);
  `)
}
