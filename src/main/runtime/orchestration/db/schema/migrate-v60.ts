import type { OrchestrationDb } from '../orchestration-db'

/** v60：专用决策模型旁路对照（entry-intent-routing-design §专用决策模型旁路验收）——
 *  route_bypass_labels 存人工标注（分组、期望动作集、备注），trial 走 decision_model_audits
 *  (source='dedicated_bypass')。顺带给审计表补 output_tokens（旁路对照报告的每请求成本
 *  指标需要 completion 侧计数；v55 只落了 input_tokens）。 */
export function migrateV60(this: OrchestrationDb, current: number): void {
  if (current >= 60) {
    return
  }
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS route_bypass_labels (
      label_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      input_id TEXT NOT NULL,
      category TEXT NOT NULL CHECK (
        category IN ('status_only', 'single_task', 'composite', 'continuation_ambiguous', 'write_gated')
      ),
      expected_json TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_id, input_id)
    );
    CREATE INDEX IF NOT EXISTS idx_route_bypass_labels_run ON route_bypass_labels(run_id);
  `)
  if (!this.hasColumn('decision_model_audits', 'output_tokens')) {
    this.db.exec('ALTER TABLE decision_model_audits ADD COLUMN output_tokens INTEGER')
  }
}
