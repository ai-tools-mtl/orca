import { defineFixture } from '../../../component-fixtures/component-fixture'
import { makeWorktree } from '../worktree-list/listing/worktree-list-lineage-card-test-fixtures'
import { EntryRouteCard } from './entry-route-card'
import { EntryAssignCard } from './entry-assign-card'
import { EntryComposer } from './entry-composer'
import { EntryLoopChip } from './entry-loop-chip'
import { EntryTaskCard } from './entry-task-card'
import { EntryWorkerApproval } from './entry-worker-approval'
import { entryTaskFactsOf } from './entry-task-facts'
import { EntryBoardView } from './entry-board-view'
import type {
  RoutingEntryApproval,
  RoutingEntryInput,
  RoutingEntrySubAction,
  RoutingReviewState
} from '../workspace-card/activity/routing-entry-model'

const WORKTREE_ID = 'wt-login-fix'

const worktree = makeWorktree({
  id: WORKTREE_ID,
  displayName: 'wt/login-fix',
  branch: 'orca/login-fix',
  sortOrder: 1,
  instanceId: 'fixture-instance'
})

const delivery = {
  supplementId: 'sup-1',
  text: '只读检查，先不要动配置',
  targetDispatchId: 'dispatch:ctx_a',
  createdAt: '2026-11-20 10:30:00',
  attempts: [
    {
      attemptId: 'att-1',
      outcome: 'delivered' as const,
      createdAt: '2026-11-20 10:30:05',
      turnId: 'turn_01',
      firstActionSummary: '首个动作 grep「只读检查」· 命中 1 处（发起于投递之后）'
    }
  ]
}

const workingAction: RoutingEntrySubAction = {
  subActionId: 'sa-1-1',
  text: '修复登录问题',
  state: 'delivered',
  taskId: 'task_1',
  execution: {
    agent: 'codex',
    dispatchId: 'dispatch:ctx_a',
    worktreeId: WORKTREE_ID,
    status: 'dispatched',
    result: null,
    failure: null
  },
  deliveries: [delivery],
  lastSupplementText: delivery.text,
  lastTargetDispatchId: delivery.targetDispatchId
}

const approval: RoutingEntryApproval = {
  approvalId: 'approval_1',
  dispatchId: 'dispatch:ctx_b',
  workerHandle: 'worktree:claude-probe',
  title: '启动慢主因：冷启动重复编译 debug 产物，占启动耗时 62%。是否放行修改阶段？',
  detail: '只读调查阶段未修改任何文件；放行后同一 Worker 继续修改。',
  reason: 'evidence: build/profile-startup.json',
  personOnly: false
}

const attentionAction: RoutingEntrySubAction = {
  subActionId: 'sa-1-2',
  text: '调查启动慢的原因',
  state: 'delivered',
  taskId: 'task_2',
  execution: {
    agent: 'claude',
    dispatchId: 'dispatch:ctx_b',
    worktreeId: WORKTREE_ID,
    readOnly: true,
    terminalHandle: 'term_claude_probe',
    status: 'attention',
    result: null,
    failure: null
  },
  deliveries: [],
  lastSupplementText: undefined,
  lastTargetDispatchId: undefined
}

const doneAction: RoutingEntrySubAction = {
  subActionId: 'sa-2-1',
  text: '修复注册页同款登录问题',
  state: 'processed',
  taskId: 'task_1',
  execution: {
    agent: 'codex',
    dispatchId: 'dispatch:ctx_a',
    worktreeId: WORKTREE_ID,
    status: 'completed',
    result: '修复完成：注册页复用同一登录校验路径，回归 14 passed。',
    failure: null
  },
  deliveries: []
}

const resumedAction: RoutingEntrySubAction = {
  subActionId: 'sa-2-2',
  text: '注册页补充 · 续接原任务',
  state: 'processed',
  taskId: 'task_1',
  resumed: true,
  deliveries: []
}

const pausedAction: RoutingEntrySubAction = {
  subActionId: 'sa-5-1',
  text: '顺手更新依赖锁文件',
  state: 'delivered',
  taskId: 'task_5',
  pausedAt: '2026-11-20 10:50:00',
  execution: {
    agent: 'claude',
    dispatchId: 'dispatch:ctx_e',
    status: 'dispatched',
    result: null,
    failure: null
  },
  deliveries: []
}

const queuedAction: RoutingEntrySubAction = {
  subActionId: 'sa-5-2',
  text: '把这条补充投给当前轮次（同目录排队中）',
  state: 'registered',
  queuedAt: '2026-11-20 10:51:00',
  deliveries: []
}

const violatedAction: RoutingEntrySubAction = {
  subActionId: 'sa-3-1',
  text: '改读 new.txt，跳过 old.txt',
  state: 'violated',
  taskId: 'task_1',
  execution: {
    agent: 'codex',
    dispatchId: 'dispatch:ctx_a',
    status: 'dispatched',
    result: null,
    failure: null
  },
  refusalKind: 'turn-not-active',
  firstActionSummary: '首个新动作 read old.txt（发起于投递之后）· 违背补充',
  deliveries: [
    {
      ...delivery,
      supplementId: 'sup-2',
      attempts: [
        {
          attemptId: 'att-2',
          outcome: 'delivered' as const,
          createdAt: '2026-11-20 10:32:00',
          turnId: 'turn_02'
        }
      ]
    }
  ]
}

const unassignedAction: RoutingEntrySubAction = {
  subActionId: 'sa-4-1',
  text: '统计手册页数',
  state: 'registered',
  deliveries: []
}

const decidedInput: RoutingEntryInput = {
  inputId: 'rinp_111111111111',
  text: '修登录，另外查启动慢，两项都不要改配置，启动问题等我确认才修改',
  decisionStatus: 'decided',
  receivedAt: '2026-11-20 10:29:00',
  decisionReason: '拆分为 2 项工作 · 登录可先行',
  taskReferences: [null, null],
  subActions: [workingAction, attentionAction]
}

const resumeInput: RoutingEntryInput = {
  inputId: 'rinp_222222222222',
  text: '注册页也有同样的登录问题，一起处理',
  decisionStatus: 'decided',
  receivedAt: '2026-11-20 10:31:00',
  decisionReason: '归属已有任务 · 不新建会话',
  taskReferences: ['task_1'],
  subActions: [resumedAction]
}

const doneInput: RoutingEntryInput = {
  inputId: 'rinp_555555555555',
  text: '修一下登录超时的提示',
  decisionStatus: 'decided',
  receivedAt: '2026-11-20 10:40:00',
  decisionReason: '独立可交付 · 自动受理',
  taskReferences: [null],
  subActions: [doneAction]
}

const manualInput: RoutingEntryInput = {
  inputId: 'rinp_444444444444',
  text: '统计手册页数',
  decisionStatus: 'decided',
  receivedAt: '2026-11-20 10:35:00',
  decisionReason: '无匹配的已有任务 · 由你选人',
  taskReferences: [null],
  subActions: [unassignedAction]
}

const reviews = new Map<string, RoutingReviewState>([
  [
    'task_1',
    {
      cycle: {
        cycle_id: 'cycle_1',
        current_revision: 1,
        state: 'reviewing',
        writer_dispatch_id: 'dispatch:ctx_a',
        reviewer_dispatch_id: 'dispatch:ctx_c'
      },
      opinions: [{ opinion_id: 'op_1', body: '未覆盖 legacy 入口回归', state: 'blocked' }]
    }
  ]
])

const store = {
  worktreesByRepo: { 'repo-1': [worktree] }
}

const renderApproval = (target: RoutingEntryApproval) => (
  <EntryWorkerApproval approval={target} busy={false} paused={false} onAnswer={() => undefined} />
)

export const entryTimeline = defineFixture({
  width: 760,
  store,
  render: () => (
    <div className="flex flex-col gap-3.5 bg-chat-pane px-6 py-5">
      <EntryRouteCard input={decidedInput} />
      <EntryRouteCard input={resumeInput} />
      <EntryAssignCard
        action={unassignedAction}
        reason={manualInput.decisionReason}
        agents={['codex', 'claude', 'zcode']}
        onAssign={() => undefined}
      />
      <EntryTaskCard
        action={workingAction}
        inputText={decidedInput.text}
        repoId="repo-1"
        review={reviews.get('task_1')}
        onAcceptReview={() => undefined}
        onSendSupplement={() => undefined}
      />
      <EntryTaskCard
        action={attentionAction}
        inputText={decidedInput.text}
        repoId="repo-1"
        approval={approval}
        renderApproval={renderApproval}
      />
      <EntryTaskCard
        action={violatedAction}
        inputText={decidedInput.text}
        repoId="repo-1"
        onSendSupplement={() => undefined}
      />
      <EntryTaskCard action={doneAction} inputText={doneInput.text} repoId="repo-1" unread />
    </div>
  )
})

const queuedStage: RoutingEntrySubAction = {
  subActionId: 'sa-9-2',
  text: '原型设计：基于需求说明产出满足需求的原型设计稿，说明关键设计决策后停下。',
  state: 'registered',
  stageKind: 'prototype',
  dependsOn: ['sa-9-1'],
  agentHint: 'dsh',
  deliveries: []
}
const stageChainInput: RoutingEntryInput = {
  ...decidedInput,
  inputId: 'rinp-9',
  subActions: [
    {
      ...queuedStage,
      subActionId: 'sa-9-1',
      text: '需求澄清与拆解：先把需求整理成一份需求说明——目标、边界、模块划分与验收要点。',
      stageKind: 'plan' as const,
      dependsOn: undefined,
      agentHint: 'claude',
      taskId: 'task_9a',
      execution: {
        agent: 'claude',
        dispatchId: 'dispatch:ctx_9a',
        status: 'dispatched' as const,
        result: null,
        failure: null
      }
    },
    queuedStage
  ]
}
const boardFacts = entryTaskFactsOf(
  [stageChainInput, decidedInput, doneInput, manualInput],
  new Map([['dispatch:ctx_b', approval]]),
  reviews,
  (worktreeId) => (worktreeId === WORKTREE_ID ? worktree.displayName : undefined)
)

export const entryCardStates = defineFixture({
  width: 760,
  store,
  render: () => (
    <div className="flex flex-col gap-3.5 bg-chat-pane px-6 py-5">
      <EntryTaskCard
        action={pausedAction}
        inputText={doneInput.text}
        repoId="repo-1"
        busy={false}
        onTogglePause={() => undefined}
        onOpenSession={() => undefined}
        onOpenDiff={() => undefined}
        onSendSupplement={() => undefined}
      />
      <EntryTaskCard action={queuedAction} inputText={doneInput.text} repoId="repo-1" />
      <EntryTaskCard action={doneAction} inputText={doneInput.text} repoId="repo-1" unread />
    </div>
  )
})

export const entryBoard = defineFixture({
  width: 900,
  store,
  render: () => (
    <div className="flex h-[420px] flex-col bg-chat-pane">
      <EntryBoardView facts={boardFacts} onSelect={() => undefined} />
    </div>
  )
})

export const entryLoopChip = defineFixture({
  width: 420,
  render: () => (
    <div className="flex flex-col gap-2.5 bg-chat-pane px-6 py-4">
      <div className="mx-auto flex w-full max-w-[760px] gap-2.5">
        <EntryLoopChip on={false} onToggle={() => undefined} />
        <EntryLoopChip on onToggle={() => undefined} />
      </div>
    </div>
  )
})

export const entryComposer = defineFixture({
  width: 760,
  render: () => (
    <div className="flex min-h-40 flex-col justify-end bg-chat-pane">
      <EntryComposer onSubmit={() => Promise.resolve(true)} />
    </div>
  )
})
