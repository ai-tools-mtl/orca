import type { OrchestrationDb } from '../orchestration-db'

/** clarification 的门自动放行（模板已改 'auto'）：在环监督发生在阶段内的 ask，产物随后还要过
 *  plan 的人工门，中间这道 pending 的人工点击是冗余的。已放行的行不动。 */
export function migrateV62(this: OrchestrationDb, current: number): void {
  if (current >= 62) {
    return
  }
  this.db.exec(`
    UPDATE routing_sub_actions SET gate = 'auto'
     WHERE stage_kind = 'clarification' AND gate = 'user_confirm' AND gate_granted_at IS NULL;
  `)
}
