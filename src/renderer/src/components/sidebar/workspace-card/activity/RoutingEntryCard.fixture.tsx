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
        firstActionSummary: 'First action read /w/new.txt as the supplement required',
        history: [
          {
            outcome: 'delivered',
            createdAt: '2026-11-19 11:30:00',
            turnId: 'turn_01',
            expectedTurnId: 'turn_01',
            targetDispatchId: 'dispatch:ctx_a',
            supplementText: '修登录，只读检查'
          }
        ],
        lastSupplementText: '修登录，只读检查',
        lastTargetDispatchId: 'dispatch:ctx_a'
      },
      {
        subActionId: 'sa-1-2',
        text: '查启动慢',
        state: 'registered',
        history: []
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
        firstActionSummary: 'Read old.txt first, against the supplement',
        history: [
          {
            outcome: 'refused',
            createdAt: '2026-11-19 11:32:00',
            refusalKind: 'turn-not-active',
            expectedTurnId: 'turn_01',
            targetDispatchId: 'dispatch:ctx_a',
            supplementText: '只读 new.txt，跳过 old.txt'
          }
        ],
        lastSupplementText: '只读 new.txt，跳过 old.txt',
        lastTargetDispatchId: 'dispatch:ctx_a'
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
