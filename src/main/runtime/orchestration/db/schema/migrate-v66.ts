import type { OrchestrationDb } from '../orchestration-db'

/** v66：控制行（§直接操作会话）。控制任务类请求（暂停/停止正在执行的任务）不再把指令文本
 *  steer 进 worker 会话，而是登记 control_kind='interrupt' 的续接行，派发时直接中断目标
 *  会话并结算账本——任务卡不再因会话收尾无 worker_done 而永远执行中。 */
export function migrateV66(this: OrchestrationDb, current: number): void {
  if (current >= 66) {
    return
  }
  // 探测式加列：重放迁移的夹具可能用当前建表 SQL 造出已含本列的「旧版本号」库。
  if (!this.hasColumn('routing_sub_actions', 'control_kind')) {
    this.db.exec('ALTER TABLE routing_sub_actions ADD COLUMN control_kind TEXT')
  }
}
