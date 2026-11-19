import { defineFixture } from '../../../../component-fixtures/component-fixture'
import RoutingEntryCard, { type RoutingEntryInput } from './RoutingEntryCard'

const inputs: RoutingEntryInput[] = [
  {
    inputId: 'rinp_111111111111',
    text: '修登录，另外查启动慢，都不要改配置。',
    decisionStatus: 'decided',
    subActions: [
      {
        subActionId: 'sa-1-1',
        text: '修登录',
        state: 'processed',
        claimedBy: 'dispatch:ctx_a',
        lastOutcome: 'delivered',
        firstActionSummary: '首个动作 read /w/new.txt 符合补充要求'
      },
      {
        subActionId: 'sa-1-2',
        text: '查启动慢',
        state: 'registered'
      }
    ]
  },
  {
    inputId: 'rinp_222222222222',
    text: '下一步只读 new.txt，跳过 old.txt，报告 new.txt 中的标记。',
    decisionStatus: 'decided',
    subActions: [
      {
        subActionId: 'sa-2-1',
        text: '改读 new.txt',
        state: 'violated',
        lastOutcome: 'refused',
        refusalKind: 'turn-not-active',
        firstActionSummary: '先读取了 old.txt，违背补充要求'
      }
    ]
  },
  {
    inputId: 'rinp_333333333333',
    text: '统计手册页数。',
    decisionStatus: 'received',
    subActions: []
  }
]

export const fourStates = defineFixture({
  width: 360,
  render: () => (
    <RoutingEntryCard
      inputs={inputs}
      onRefresh={() => undefined}
      onHandback={() => undefined}
      onSendSupplement={() => undefined}
    />
  )
})

export const paused = defineFixture({
  width: 360,
  render: () => <RoutingEntryCard paused busy inputs={inputs.slice(2)} />
})

export const empty = defineFixture({
  width: 360,
  render: () => <RoutingEntryCard inputs={[]} />
})
