import { defineFixture } from '../../../component-fixtures/component-fixture'
import { EntryStageFlow } from './entry-stage-flow'
import { EntryStageCheckpoint } from './entry-stage-checkpoint'
import { entryTimelineEventsOf } from './entry-timeline-events'
import type {
  RoutingEntryInput,
  RoutingEntrySubAction
} from '../workspace-card/activity/routing-entry-model'

function StageFlowFixture({ input }: { input: RoutingEntryInput }): React.JSX.Element {
  return (
    <>
      <EntryStageFlow input={input} />
      {entryTimelineEventsOf([input], []).flatMap((event) =>
        event.kind === 'checkpoint'
          ? [<EntryStageCheckpoint key={event.id} action={event.action} state={event.state} />]
          : []
      )}
    </>
  )
}

// 规划链的等待行（窄侧栏回归）：等待标签曾嵌入上游阶段的整段规格文本，被 flex 压成一列
// 一字——标签只保留短名（stageLabelTitle），这里锁定该形状。

const clarifySpec =
  '需求澄清与拆解：先把需求整理成一份需求说明——目标、边界（明确不做什么）、模块划分、关键流程与验收要点，可写入 requirements.md。本阶段只产出需求说明，不做架构设计也不实施。需求原文：我想做一个简单的仓管系统'
const prototypeSpec =
  '原型设计：基于需求说明产出满足需求的原型设计稿（可写入 prototype/ 目录），说明关键设计决策后停下。本阶段只做原型，不实施需求本身。'
const designSpec =
  '任务设计与拆解：先核对仓库中与需求相关的代码，结合需求说明与原型，在报告末尾输出 orca-plan JSON 计划块（最多 8 个阶段）。本阶段只产出计划，不实施需求本身。'

function stage(
  subAction: Partial<RoutingEntrySubAction> & Pick<RoutingEntrySubAction, 'subActionId' | 'text'>
): RoutingEntrySubAction {
  return { state: 'registered', deliveries: [], ...subAction }
}

const subActions: RoutingEntrySubAction[] = [
  stage({
    subActionId: 'sa-1-1',
    text: clarifySpec,
    stageKind: 'plan',
    gate: 'user_confirm',
    execution: {
      agent: 'claude',
      dispatchId: 'dispatch:ctx_clarify',
      status: 'completed',
      result: null,
      failure: null,
      completedAt: '2026-11-21 12:40:00'
    }
  }),
  stage({
    subActionId: 'sa-1-2',
    text: prototypeSpec,
    stageKind: 'prototype',
    gate: 'user_confirm',
    execution: {
      agent: 'dsh',
      dispatchId: 'dispatch:ctx_prototype',
      status: 'completed',
      result: null,
      failure: null,
      completedAt: '2026-11-21 12:44:00'
    }
  }),
  stage({
    subActionId: 'sa-1-3',
    text: designSpec,
    stageKind: 'plan',
    dependsOn: ['sa-1-2']
  })
]

export const planningChain = defineFixture({
  width: 360,
  render: () => (
    <div className="flex flex-col gap-2 p-2">
      <StageFlowFixture
        input={{
          inputId: 'rinp-1',
          text: '我想做一个简单的仓管系统',
          decisionStatus: 'decided',
          subActions
        }}
      />
    </div>
  )
})

// orca-plan 解析失败的失败卡（替代死端放行按钮）+ 下游 blocked 标签。
const brokenPlanChain: RoutingEntrySubAction[] = [
  stage({
    subActionId: 'sa-2-1',
    text: designSpec,
    stageKind: 'plan',
    gate: 'user_confirm',
    planUnusable: true,
    planParseError: '报告中没有 orca-plan 计划块，需要人工整理后再确认',
    execution: {
      agent: 'claude',
      dispatchId: 'dispatch:ctx_broken_plan',
      status: 'completed',
      result: null,
      failure: null,
      completedAt: '2026-11-21 12:50:00'
    }
  }),
  stage({
    subActionId: 'sa-2-2',
    text: '实现入库单登记：…',
    stageKind: 'implement',
    dependsOn: ['sa-2-1']
  })
]

export const brokenPlan = defineFixture({
  width: 360,
  render: () => (
    <div className="flex flex-col gap-2 p-2">
      <StageFlowFixture
        input={{
          inputId: 'rinp-2',
          text: '我想做一个简单的仓管系统',
          decisionStatus: 'decided',
          subActions: brokenPlanChain
        }}
      />
    </div>
  )
})

// plan 门卡的"查看计划"折叠列表：确认放行前用户能看到撰写的计划（标题 + agent + spec 二级展开）。
const planGateChain: RoutingEntrySubAction[] = [
  stage({
    subActionId: 'sa-3-1',
    text: designSpec,
    stageKind: 'plan',
    gate: 'user_confirm',
    planStages: [
      {
        title: '确认需求基线与最小范围',
        agent: 'claude',
        spec: '与用户确认运行平台、商品字段与 SKU 规则、数量精度与负库存策略，产出 docs/warehouse-requirements.md，未获批准则停止后续阶段。'
      },
      {
        title: '制作并确认可点击静态原型',
        agent: 'dsh',
        spec: '只在 prototype/ 下制作静态可点击原型，覆盖商品、入库、出库与库存查询，请用户实际操作并明确批准。'
      },
      {
        title: '搭建工程并完成商品与库存查询',
        agent: 'codex',
        spec: '搭建最小可运行工程与迁移，实现商品资料与当前库存查询，重复 SKU、非法数量等状态用测试覆盖。'
      }
    ],
    execution: {
      agent: 'claude',
      dispatchId: 'dispatch:ctx_plan_gate',
      status: 'completed',
      result: null,
      failure: null,
      completedAt: '2026-11-21 13:10:00'
    }
  })
]

export const planGate = defineFixture({
  width: 360,
  render: () => (
    <div className="flex flex-col gap-2 p-2">
      <StageFlowFixture
        input={{
          inputId: 'rinp-3',
          text: '我想做一个简单的仓管系统',
          decisionStatus: 'decided',
          subActions: planGateChain
        }}
      />
    </div>
  )
})

// 合并检查点三态（pipeline §8）：待确认合并门 / 已合并（带收据）/ 合并失败（泵会重试）。
const mergeCheckpointChain: RoutingEntrySubAction[] = [
  stage({
    subActionId: 'sa-4-1',
    text: '合并检查点：确认需求基线与最小范围 后把链条累积产出提交并合并进主分支。',
    stageKind: 'merge',
    gate: 'user_confirm'
  }),
  stage({
    subActionId: 'sa-4-2',
    text: '合并检查点：制作并确认可点击静态原型 后把链条累积产出提交并合并进主分支。',
    stageKind: 'merge',
    gate: 'user_confirm',
    gateGrantedAt: '2026-11-21 13:20:00',
    mergedAt: '2026-11-21 13:20:05',
    mergeReceipt: { commitSha: '9f2c1ab77e4d5c6e8f90a1b2c3d4e5f60718293a4', baseBranch: 'main' }
  }),
  stage({
    subActionId: 'sa-4-3',
    text: '合并检查点：定稿架构、数据模型与 ADR 后把链条累积产出提交并合并进主分支。',
    stageKind: 'merge',
    gate: 'user_confirm',
    gateGrantedAt: '2026-11-21 13:30:00',
    assignmentError: '主分支工作区有未提交改动，无法安全合并——请先处理后再重试。'
  })
]

export const mergeCheckpoints = defineFixture({
  width: 360,
  render: () => (
    <div className="flex flex-col gap-2 p-2">
      <StageFlowFixture
        input={{
          inputId: 'rinp-4',
          text: '我想做一个简单的仓管系统',
          decisionStatus: 'decided',
          subActions: mergeCheckpointChain
        }}
      />
    </div>
  )
})
