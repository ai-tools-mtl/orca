import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'

// 计划阶段的 agent 分配依据（能力特长分工）：实施链的特点来自各 agent 的强项，宿主未装的
// agent 由派发兜底，而不是让计划把整条链塌缩给单一 agent。画像条目只列角色基线里的 agent
// （§5.1 方案设计→claude、原型绘制→dsh、审查→codex；route=code→zcode）。
const PLAN_STAGE_AGENT_PROFILES: readonly { agent: TuiAgent; profile: string }[] = [
  { agent: 'claude', profile: '方案设计、需求与任务拆解、架构与接口设计、文档类产出' },
  { agent: 'zcode', profile: '编码实施、联调验证' },
  { agent: 'dsh', profile: '原型绘制、UI 设计稿' },
  { agent: 'codex', profile: '只读调查、审查' }
]

/** 计划 prompt 的 agent 池段：宿主已装的角色 agent 及其能力画像与分配规则。池为空
 *  （placement 探测失败）时不注入——计划退回无 agent 字段的自由格式，派发走默认兜底。 */
export function planAgentPoolSection(availableAgents: readonly string[]): string {
  const pool = new Set(availableAgents)
  const profiles = PLAN_STAGE_AGENT_PROFILES.filter((entry) => pool.has(entry.agent))
  if (profiles.length === 0) {
    return ''
  }
  const lines = profiles.map((entry) => `- ${entry.agent}：${entry.profile}`)
  return [
    '计划里每个阶段的 agent 只能从下面已安装的执行 Agent 里选：',
    ...lines,
    '每个阶段按其工作性质选能力最匹配的 agent：方案/契约/文档类阶段选方案强项，编码实施/联调类阶段选实施强项，原型/UI 类阶段选原型强项，调查/审查类阶段选审查强项；不要不加区分地把全部阶段填给同一个 agent。'
  ].join('\n')
}
