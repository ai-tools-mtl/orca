import { useRef, useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type {
  RoutingEntryInput,
  RoutingEntrySubAction
} from '../workspace-card/activity/routing-entry-model'
import { EntryTimelineActivity } from './entry-timeline-activity'
import { EntryTimelineDays } from './entry-timeline-days'
import { EntryTimelinePending } from './entry-timeline-pending'
import {
  entryResultId,
  entryTimelineDaysOf,
  entryTimelineEventsOf,
  hasEntryResult,
  startOfEntryDay
} from './entry-timeline-events'
import { EntryInputRow } from './entry-input-row'
import { locateEntryTimelineCard } from './entry-task-view'

const today = new Date(2026, 10, 22)
const at = (day: number, hour: number) => new Date(2026, 10, day, hour).toISOString()
const question = { messageId: 'negative-stock', body: '是否允许负库存？', createdAt: at(17, 17) }
const tasks: RoutingEntrySubAction[] = [
  {
    subActionId: 'rules',
    text: '确认库存规则',
    state: 'delivered',
    deliveries: [],
    pendingAsks: [question],
    execution: {
      dispatchId: 'clarify-rules',
      agent: 'codex',
      status: 'dispatched',
      result: null,
      failure: null
    }
  },
  {
    subActionId: 'prototype',
    text: '提交仓管原型',
    state: 'processed',
    deliveries: [],
    stageKind: 'prototype',
    gate: 'user_confirm',
    execution: {
      dispatchId: 'proto',
      agent: 'codex',
      completedAt: at(18, 11),
      status: 'completed',
      result: '原型已提交，可以确认。',
      failure: null
    }
  },
  {
    subActionId: 'stock',
    text: '实现库存查询',
    state: 'delivered',
    deliveries: [],
    execution: {
      dispatchId: 'stock-search',
      agent: 'claude',
      status: 'dispatched',
      result: null,
      failure: null
    }
  },
  {
    subActionId: 'vue-page',
    text: 'Vue 页面与交互实现',
    state: 'delivered',
    deliveries: [],
    execution: {
      dispatchId: 'vue-page',
      agent: 'codex',
      status: 'failed',
      result: null,
      failure: 'Codex hit its usage limit.'
    }
  },
  {
    subActionId: 'import',
    text: '实现商品导入',
    state: 'registered',
    deliveries: [],
    queuedAt: at(21, 11)
  },
  ...[
    { id: 'export', title: '实现库存导出' },
    { id: 'test', title: '运行仓管回归测试' },
    { id: 'check', title: '复核验收报告' }
  ].map(({ id, title }): RoutingEntrySubAction => ({
    subActionId: id,
    text: title,
    state: 'registered',
    deliveries: [],
    stageKind: 'implement',
    dependsOn: ['stock']
  })),
  {
    subActionId: 'report',
    taskId: 'report-task',
    text: '导出验收报告',
    state: 'processed',
    deliveries: [],
    execution: {
      dispatchId: 'report',
      agent: 'codex',
      completedAt: at(22, 13),
      status: 'completed',
      result: '验收报告已生成。',
      failure: null
    }
  }
]

const noop = () => undefined
const asyncNoop = () => Promise.resolve()

function TimelineFixture({
  actions = tasks
}: {
  actions?: RoutingEntrySubAction[]
}): React.JSX.Element {
  const stream = useRef<HTMLDivElement>(null)
  const [subActions, setSubActions] = useState(actions)
  const [read, setRead] = useState<string[]>([])
  const input: RoutingEntryInput = {
    inputId: 'inventory',
    text: '开发仓管工具',
    receivedAt: at(16, 9),
    decisionStatus: 'decided',
    subActions
  }
  const events = entryTimelineEventsOf([input], [])
  const markSeen = (action: RoutingEntrySubAction) =>
    setRead((current) => [...current, action.subActionId])
  const isUnread = (action: RoutingEntrySubAction) => !read.includes(action.subActionId)
  const locate = (id: string, action?: RoutingEntrySubAction) =>
    window.requestAnimationFrame(() => {
      if (locateEntryTimelineCard(stream.current, id) && action) {
        markSeen(action)
      }
    })
  return (
    <div className="flex h-[620px] flex-col bg-chat-pane">
      <EntryTimelinePending
        events={events}
        reviews={new Map()}
        isUnread={isUnread}
        onSelect={locate}
      />
      <div
        ref={stream}
        data-dispatch-entry-stream=""
        className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek p-3"
      >
        <EntryTimelineDays
          days={entryTimelineDaysOf(events, startOfEntryDay(today), 'en')}
          renderRow={(event, lastOfDay) =>
            event.kind === 'request' ? (
              <EntryInputRow
                key={event.id}
                input={event.input}
                receivedAt={event.at}
                lastOfDay={lastOfDay}
                repoId="inventory"
                facts={{
                  busy: false,
                  savePlan: asyncNoop,
                  assign: asyncNoop,
                  reviews: new Map(),
                  acceptReview: asyncNoop,
                  handback: asyncNoop,
                  transfer: asyncNoop,
                  sendSupplement: asyncNoop,
                  fetchWorkers: () => Promise.resolve([])
                }}
                automatic
                approvalByDispatch={new Map()}
                routing={false}
                onHint={noop}
                onRouteInput={noop}
                onDelete={noop}
                onActionError={noop}
                cardActions={(action) => ({
                  unread: hasEntryResult(action.execution) && isUnread(action),
                  onOpenResult: hasEntryResult(action.execution)
                    ? () => locate(entryResultId(action), action)
                    : undefined,
                  onTogglePause: action.execution
                    ? (paused) =>
                        setSubActions((current) =>
                          current.map((candidate) =>
                            candidate.subActionId === action.subActionId
                              ? { ...candidate, pausedAt: paused ? at(22, 14) : undefined }
                              : candidate
                          )
                        )
                    : undefined
                })}
              />
            ) : (
              <EntryTimelineActivity
                key={event.id}
                event={event}
                lastOfDay={lastOfDay}
                busy={false}
                isUnread={isUnread}
                markSeen={markSeen}
                locate={locate}
                answerAsk={async (messageId, answer) => {
                  setSubActions((current) =>
                    current.map((action) =>
                      action.subActionId === 'rules'
                        ? {
                            ...action,
                            pendingAsks: [],
                            answeredAsks: [
                              {
                                messageId,
                                question: question.body,
                                answer,
                                createdAt: question.createdAt,
                                answeredAt: at(22, 14)
                              }
                            ]
                          }
                        : action
                    )
                  )
                }}
                grantGate={async (id) =>
                  setSubActions((current) =>
                    current.map((action) =>
                      action.subActionId === id ? { ...action, gateGrantedAt: at(22, 15) } : action
                    )
                  )
                }
                renderApproval={() => <div />}
                assignAgents={['claude', 'zcode']}
                onAssignAgent={() => undefined}
                onActionError={() => undefined}
              />
            )
          }
        />
      </div>
    </div>
  )
}

export const crossDayActivity = defineFixture({ width: 420, render: () => <TimelineFixture /> })

export const wideTimeline = defineFixture({ width: 760, render: () => <TimelineFixture /> })

export const threeTaskTimeline = defineFixture({
  width: 900,
  render: () => <TimelineFixture actions={tasks.slice(1, 4)} />,
  interact: (frame) => {
    let ancestor = frame.querySelector('#entry-request-inventory')?.parentElement
    while (ancestor) {
      if (ancestor instanceof HTMLDetailsElement) {
        ancestor.open = true
      }
      ancestor = ancestor.parentElement
    }
  }
})

function RequestRowFixture({ input }: { input: RoutingEntryInput }): React.JSX.Element {
  return (
    <EntryInputRow
      input={input}
      repoId="inventory"
      receivedAt={new Date(2026, 10, 22, 8, 53)}
      facts={{
        busy: false,
        savePlan: asyncNoop,
        assign: asyncNoop,
        reviews: new Map(),
        acceptReview: asyncNoop,
        handback: asyncNoop,
        transfer: asyncNoop,
        sendSupplement: asyncNoop,
        fetchWorkers: () => Promise.resolve([])
      }}
      automatic
      approvalByDispatch={new Map()}
      routing={false}
      onHint={noop}
      onRouteInput={noop}
      onDelete={noop}
      onActionError={noop}
      cardActions={() => ({})}
    />
  )
}

/** 会话型请求（reply 动作 + query_status 答案）：回复气泡承载内容，徽章呈「已回复」。 */
export const repliedNoDispatch = defineFixture({
  width: 620,
  render: () => (
    <RequestRowFixture
      input={{
        inputId: 'chitchat',
        text: '仓库系统做多少了',
        receivedAt: at(22, 8),
        decisionStatus: 'decided',
        replies: [
          {
            key: 'a1',
            text: '目前两项规划产物已完成验收：需求说明与原型设计稿都已合并。实施阶段还剩库存查询、Vue 页面两项在跑，跑完会各自过循环写审再请你验收。'
          }
        ],
        queryAnswers: [
          {
            key: 'a2',
            target: 'project',
            answer:
              '需求澄清与拆解：已完成；原型设计：已完成；实现库存查询：执行中；Vue 页面与交互实现：执行中'
          }
        ],
        subActions: []
      }}
    />
  )
})

/** reason-only 的无需派发（无回复内容）：保持原样——灰字理由 + 无需派发徽章。 */
export const noDispatchReason = defineFixture({
  width: 620,
  render: () => (
    <RequestRowFixture
      input={{
        inputId: 'noop',
        text: '（测试消息，忽略这条）',
        receivedAt: at(22, 9),
        decisionStatus: 'decided',
        decisionReason: '这是控制消息，无需任何处理。',
        subActions: []
      }}
    />
  )
})
