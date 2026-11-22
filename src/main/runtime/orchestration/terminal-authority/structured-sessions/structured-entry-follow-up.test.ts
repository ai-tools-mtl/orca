import { afterEach, expect, it, vi } from 'vitest'
import { resolveProjectExecutionRuntime } from '../../../../../shared/execution-host/project-execution-runtime'
import * as sessionCreate from '../../../rpc/methods/structured-sessions/creation/structured-agent-session-create'
import {
  codex,
  db,
  dispatcher,
  host,
  request,
  root,
  runtime
} from './structured-chat-coordinator-mail-rig.test-fixture'
import { attachParams } from './structured-chat-coordinator-fake-codex-fixture'
import { isRecord, resultOf } from '../../../rpc/orchestration/callers/session.test-fixture'

// 统一路由协议（Agent 单次路由）驱动的结构化续接：固定 RouteProposalV1 提案替代旧
// custom 链路的 HTTP 响应——首路由两个 create_task 分别派发，续接用 continue_task 指向
// 启动任务。断言保持：暂停中不投递，恢复后只投递一次、命中原轮次，账本记录暂停拒收与
// 随后送达。

const routeProposal = vi.hoisted(() => ({
  current: { version: 1, actions: [] as unknown[] }
}))

vi.mock('../../../orchestration/routing/agent-route-proposal-provider', () => ({
  createAgentRouteProposalProvider: () => async () => routeProposal.current
}))

const group = 'workspace-1'

async function entry(method: string, params: Record<string, unknown> = {}) {
  const response = await dispatcher.dispatch(
    request(`orchestration.${method}`, { group, ...params }),
    {
      caller: { kind: 'desktop' }
    }
  )
  expect(response, JSON.stringify(response)).toMatchObject({ ok: true })
  return resultOf(response)
}

async function submit(text: string): Promise<string> {
  const { input } = await entry('entrySubmit', { text })
  if (!isRecord(input) || typeof input.input_id !== 'string') {
    throw new Error('The task entry did not return an input ID.')
  }
  return input.input_id
}

afterEach(() => {
  routeProposal.current = { version: 1, actions: [] }
  vi.unstubAllGlobals()
})

it.skipIf(process.platform === 'win32')(
  'dispatches login separately and resumes the saved startup follow-up in the original turn',
  async () => {
    vi.spyOn(runtime, 'detectProjectLaunchContext').mockResolvedValue({
      agents: ['codex', 'claude'],
      workspaceKind: 'git-worktree',
      executionContext: {
        kind: 'host',
        projectRuntime: resolveProjectExecutionRuntime({
          appPlatform: process.platform,
          projectId: group
        })
      }
    })
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    vi.spyOn(runtime, 'listManagedWorktrees').mockResolvedValue({
      worktrees: [],
      totalCount: 0,
      truncated: false
    })
    vi.spyOn(runtime, 'listRetiredWorktreeNames').mockResolvedValue({
      retiredNamesByRepo: {},
      retiredNameTiersByRepo: {}
    })
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [],
      totalCount: 0,
      truncated: false
    })
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1
    })
    vi.spyOn(runtime, 'createManagedWorktree').mockImplementation(async (options) => {
      const created = {
        worktree: { id: group, repoId: group },
        ...(options.startupAgent
          ? { startupTerminal: { spawned: true, handle: 'term_worker' } }
          : {})
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this rig supplies the workspace fields and optional startup terminal read during placement.
      return created as never
    })
    vi.spyOn(sessionCreate, 'createStructuredAgentSessionForWorktree').mockImplementation(
      async (args) => {
        const attached = await host.attach(
          args.caller,
          attachParams(args.envelope.sessionId, root, args.options)
        )
        if (!attached.ok) {
          throw new Error('scripted worker attach refused')
        }
        return {
          ...attached,
          value: { ...attached.value, sessionId: args.envelope.sessionId, fence: attached.fence }
        }
      }
    )
    routeProposal.current = {
      version: 1,
      actions: [
        { key: 'a1', type: 'create_task', instruction: '修登录', agent: 'codex' },
        { key: 'a2', type: 'create_task', instruction: '查启动慢', agent: 'codex' }
      ]
    }
    const decisionModel = { source: 'agent', agent: 'codex' }
    const input = await submit('修登录，另外查启动慢')
    const routing = entry('entryAutoRoute', { input, dispatch: true, decisionModel })
    await vi.waitFor(() => expect(codex.connections.at(-1)?.turns[0]).toBeDefined())
    const worker = codex.connections.at(-1)!
    const preamble = worker.turns[0]!
    worker.handlers.onNotification?.('turn/started', { turn: { id: 'turn-1' } })
    worker.handlers.onNotification?.('item/completed', {
      item: {
        type: 'userMessage',
        id: 'preamble',
        clientId: preamble.clientUserMessageId,
        content: [{ type: 'text', text: '查启动慢' }]
      }
    })
    expect(await routing).toMatchObject({ routed: true, dispatchErrors: [] })
    const [login, startup] = db.listSubActions(input)
    const loginDispatch = db.getDispatchContext(login!.task_id!)!
    const startupDispatch = db.getDispatchContext(startup!.task_id!)!
    expect(loginDispatch.status).toBe('dispatched')
    expect(startupDispatch.status).toBe('dispatched')
    expect(loginDispatch.id).not.toBe(startupDispatch.id)
    const sessionId = startupDispatch.assignee_orca_session_id!
    expect(host.deps.store.getRecord(sessionId)?.permissionMode).toBe('ask')
    await host.flushStreamedEvents(sessionId)

    await entry('entryPause')
    const supplementInput = await submit('启动慢任务补查冷启动')
    const routeSupplement = { input: supplementInput, dispatch: true, decisionModel }
    routeProposal.current = {
      version: 1,
      actions: [
        {
          key: 'a1',
          type: 'continue_task',
          taskId: db.listSubActions(input)[1]!.task_id!,
          instruction: '补查冷启动'
        }
      ]
    }
    await entry('entryAutoRoute', routeSupplement)
    const action = db.listSubActions(supplementInput)[0]!
    const [supplement] = db.listSupplements(action.sub_action_id)
    expect(supplement).toMatchObject({
      raw_text: '补查冷启动',
      target_dispatch_id: startupDispatch.id
    })
    expect(worker.steers).toEqual([])
    expect(await entry('entryShow')).toMatchObject({
      watchdog: { paused: true },
      inputs: [
        {
          subActions: [
            { deliveries: [] },
            { deliveries: [{ supplement: { raw_text: '补查冷启动' } }] }
          ]
        },
        { subActions: [{ deliveries: [{ supplement: { raw_text: '补查冷启动' } }] }] }
      ]
    })
    expect(await entry('entryResume')).toMatchObject({ watchdog: { paused: false } })
    await entry('entryAutoRoute', routeSupplement)
    expect(
      worker.steers.map((steer) => ({
        turn: steer.expectedTurnId,
        text: JSON.parse(steer.text)[0].text
      }))
    ).toEqual([{ turn: 'turn-1', text: '补查冷启动' }])
    expect(db.listSupplementAttempts(supplement!.supplement_id)).toMatchObject([
      { outcome: 'refused', refusal_kind: 'paused' },
      { outcome: 'delivered', turn_id: 'turn-1' }
    ])
    expect(await entry('entryPause')).toMatchObject({ watchdog: { paused: true } })
    expect(host.deps.store.getRecord(sessionId)?.permissionMode).toBe('ask')
  }
)
