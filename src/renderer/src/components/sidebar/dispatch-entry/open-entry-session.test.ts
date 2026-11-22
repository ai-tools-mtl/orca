import { beforeEach, expect, it, vi } from 'vitest'
import { openEntrySession } from './open-entry-session'

const { rpc, activateWorkspace, activateSession } = vi.hoisted(() => ({
  rpc: vi.fn(),
  activateWorkspace: vi.fn(),
  activateSession: vi.fn()
}))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: rpc }))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorkspace: activateWorkspace
}))
vi.mock('@/lib/workspace/activation/reveal-terminal-pane', () => ({ revealTerminalPane: vi.fn() }))
vi.mock('@/components/terminal-pane/agent-status/stale-agent-row', () => ({
  showAgentPaneUnavailable: vi.fn()
}))
vi.mock('@/components/terminal-pane/links/handles/terminal-handle-links', () => ({
  findTerminalHandleTarget: vi.fn()
}))
vi.mock('@/lib/agent-session/open/activate-ai-vault-structured-session', () => ({
  structuredSessionOpenFeedback: { gone: vi.fn(), hostCannotOpen: vi.fn(), unavailable: vi.fn() }
}))
vi.mock('@/lib/agent-session/structured-agent-session-tab-activation', () => ({
  findStructuredAgentSessionTab: () => ({ id: 'chat-tab', entityId: 'session-current' }),
  activateStructuredAgentSessionById: activateSession
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ unifiedTabsByWorktree: {} }) } }))

beforeEach(() => {
  vi.resetAllMocks()
})

it('opens the current chat for a structured dispatch on its owning host', async () => {
  const target = { kind: 'environment', environmentId: 'paired' } as const
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'orchestration.partyOpen') {
      throw Object.assign(new Error('Local only'), { code: 'forbidden' })
    }
    if (method === 'orchestration.partyLocation') {
      return { location: { kind: 'chat', sessionId: 'session-current', worktreeId: 'worker' } }
    }
    throw new Error(`Unexpected RPC: ${method}`)
  })
  activateSession.mockReturnValue(true)
  activateWorkspace.mockReturnValue({ primaryTabId: null })

  await expect(
    openEntrySession(target, { dispatchId: 'dispatch-a', terminalHandle: 'structworker_old' })
  ).resolves.toBe(true)
  expect(rpc).toHaveBeenCalledWith(
    target,
    'orchestration.partyLocation',
    { address: 'dispatch:dispatch-a' },
    expect.anything()
  )
  expect(activateSession).toHaveBeenCalledWith({
    target,
    sessionId: 'session-current',
    worktreeId: 'worker'
  })
  expect(activateWorkspace).toHaveBeenCalledWith('worker', {
    executionHostId: 'runtime:paired',
    providesInitialSurface: true
  })
})

it('focuses the terminal returned by the dispatch lookup and reports unsuccessful navigation', async () => {
  const target = { kind: 'local' } as const
  rpc.mockResolvedValueOnce({ location: { kind: 'terminal', handle: 'term_reopened' } })
  rpc.mockResolvedValueOnce({ focus: { navigated: false } })

  await expect(
    openEntrySession(target, { dispatchId: 'dispatch-b', terminalHandle: 'term_closed' })
  ).resolves.toBe(false)
  expect(rpc).toHaveBeenCalledWith(target, 'terminal.focus', {
    terminal: 'term_reopened',
    navigation: 'host'
  })
})
