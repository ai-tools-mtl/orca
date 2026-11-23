import type { OrchestrationDb } from '../orchestration-db'

/** v61：routing_inputs.request_id / request_id_state —— 提交去重的持久化请求身份。
 *
 *  历史写入路径与迁移时可用的证据（input_id 前缀/长度/字符/版本号都不足以单独区分同形
 *  记录，判据必须落到「两种派生解释各自的合法性」上）：
 *  - 裸格式（作用域化之前）：`rinp_<requestId>`，派生与 Run 无关。
 *  - 作用域格式：`rinp_<runId>_<requestId>`，派生恒内嵌本行 run_id。
 *  对每条合法请求段行分别检验两个解释（裸 = rinp_ 后整段；作用域 = 去掉 `rinp_<本行
 *  run_id>_` 前缀后的剩余段，各自须匹配 8–64 请求 ID 规则）：
 *  - 只有裸解释合法（如作用域后缀短于 8 字符）→ 按裸回填整段；
 *  - 只有作用域解释合法（如客户端 ID 满长使裸段超过 64 上限）→ 按作用域回填剩余段；
 *  - 两个解释都合法，或裸解释与随机生成的 12 位小写 hex ID 撞形（随机登记无请求身份、
 *    无证据可区分）→ 身份候选不唯一：request_id 保持 NULL，request_id_state='ambiguous'
 *    显式暴露；原输入与全部引用保留，运行时对同形请求 ID 提交返回明确的
 *    lifecycle_conflict，由调用者换新请求 ID 或先删除该历史请求后再提交。
 *  - 无合法解释（随机登记等）→ 不动，永不绑定请求。 */
export function migrateV61(this: OrchestrationDb, current: number): void {
  if (current >= 61) {
    return
  }
  // 探测式加列：重放迁移的夹具可能用当前建表 SQL 造出已含本列的「旧版本号」库。
  if (!this.hasColumn('routing_inputs', 'request_id')) {
    this.db.exec('ALTER TABLE routing_inputs ADD COLUMN request_id TEXT')
  }
  if (!this.hasColumn('routing_inputs', 'request_id_state')) {
    this.db.exec('ALTER TABLE routing_inputs ADD COLUMN request_id_state TEXT')
  }
  // 只有裸解释合法：整段是合法请求段、非随机同形，且作用域解释不成立（非自身 Run 前缀，
  // 或剩余段不匹配请求 ID 规则）。
  this.db.exec(`
    UPDATE routing_inputs SET request_id = substr(input_id, 6)
    WHERE request_id IS NULL
      AND length(substr(input_id, 6)) BETWEEN 8 AND 64
      AND substr(input_id, 6) GLOB '[A-Za-z0-9]*'
      AND substr(input_id, 6) NOT GLOB '*[^A-Za-z0-9_-]*'
      AND NOT (length(input_id) = 17 AND substr(input_id, 6) NOT GLOB '*[^0-9a-f]*')
      AND NOT (
        substr(input_id, 1, 6 + length(run_id)) = 'rinp_' || run_id || '_'
        AND length(substr(input_id, 7 + length(run_id))) BETWEEN 8 AND 64
        AND substr(input_id, 7 + length(run_id)) GLOB '[A-Za-z0-9]*'
        AND substr(input_id, 7 + length(run_id)) NOT GLOB '*[^A-Za-z0-9_-]*'
      )
  `)
  // 只有作用域解释合法：自身 Run 前缀 + 剩余段合法，而整段超出裸请求 ID 的 64 字符上限
  // 或不匹配请求 ID 规则。
  this.db.exec(`
    UPDATE routing_inputs SET request_id = substr(input_id, 7 + length(run_id))
    WHERE request_id IS NULL
      AND substr(input_id, 1, 6 + length(run_id)) = 'rinp_' || run_id || '_'
      AND length(substr(input_id, 7 + length(run_id))) BETWEEN 8 AND 64
      AND substr(input_id, 7 + length(run_id)) GLOB '[A-Za-z0-9]*'
      AND substr(input_id, 7 + length(run_id)) NOT GLOB '*[^A-Za-z0-9_-]*'
      AND NOT (
        length(substr(input_id, 6)) BETWEEN 8 AND 64
        AND substr(input_id, 6) GLOB '[A-Za-z0-9]*'
        AND substr(input_id, 6) NOT GLOB '*[^A-Za-z0-9_-]*'
      )
  `)
  // 身份候选不唯一：两个解释都合法（作用域同形），或裸解释与随机生成 ID 撞形。
  this.db.exec(`
    UPDATE routing_inputs SET request_id_state = 'ambiguous'
    WHERE request_id IS NULL AND (
      (
        substr(input_id, 1, 6 + length(run_id)) = 'rinp_' || run_id || '_'
        AND length(substr(input_id, 7 + length(run_id))) BETWEEN 8 AND 64
        AND substr(input_id, 7 + length(run_id)) GLOB '[A-Za-z0-9]*'
        AND substr(input_id, 7 + length(run_id)) NOT GLOB '*[^A-Za-z0-9_-]*'
      )
      OR (
        length(input_id) = 17 AND substr(input_id, 6) NOT GLOB '*[^0-9a-f]*'
      )
    )
  `)
}
