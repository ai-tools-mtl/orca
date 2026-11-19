import { defineFixture } from '../../../../component-fixtures/component-fixture'
import RoutingRequestCard, { type RoutingEntryInput } from './RoutingEntryCard'

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
        firstActionSummary: 'First action read /w/new.txt as the supplement required'
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
        firstActionSummary: 'Read old.txt first, against the supplement'
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
    <div className="flex flex-col gap-2 p-2">
      {inputs.map((input) => (
        <RoutingRequestCard key={input.inputId} input={input} onHandback={() => undefined} />
      ))}
    </div>
  )
})

export const withSupplementForm = defineFixture({
  width: 360,
  render: () => (
    <div className="p-2">
      <RoutingRequestCard input={inputs[0]!} onSendSupplement={() => undefined} />
    </div>
  )
})
