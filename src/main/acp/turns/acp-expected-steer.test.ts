import { describe, expect, it, vi } from 'vitest'
import { steerExpectedAcpTurn } from './acp-expected-steer'
import type { AcpStructuredSession } from '../session/acp-structured-session-contract'

const SESSION = 'session-1'
const OPEN_TURN = 'turn-open-1'
const body = {
  kind: 'message' as const,
  role: 'user' as const,
  blocks: [{ type: 'text' as const, text: 'change course' }]
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the strict steer touches only turns/lane/prompt facts.
function sessionStub(options: { running: boolean; openTurnId: string | null }): AcpStructuredSession {
  const dispatch = vi.fn()
  return {
    turns: { running: options.running, dispatch },
    lane: { openTurnId: options.openTurnId },
    spec: { agent: 'grok', dialect: {} },
    connection: { initialize: async () => ({ agentCapabilities: { promptCapabilities: { image: true } } }) },
    cwd: '/work/repo',
    dispatch
  } as unknown as AcpStructuredSession & { turns: { dispatch: typeof dispatch } }
}

const input = {
  sessionId: SESSION,
  clientMessageId: 'client-1',
  body,
  expectedTurnId: OPEN_TURN
}

describe('targeted delivery for ACP agents', () => {
  it('queues the send as a steer into the named running turn', async () => {
    const session = sessionStub({ running: true, openTurnId: OPEN_TURN })

    expect(await steerExpectedAcpTurn(session, input, () => 1)).toEqual({
      status: 'delivered',
      turnId: OPEN_TURN,
      via: 'steer'
    })
    expect(session.turns.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ clientMessageId: 'client-1', requestedAt: 1 })
    )
    expect(
      vi.mocked(session.turns.dispatch).mock.calls[0]?.[0].prompt
    ).toEqual([{ type: 'text', text: 'change course' }])
  })

  it('refuses without writing when nothing is running', async () => {
    const session = sessionStub({ running: false, openTurnId: null })

    expect(await steerExpectedAcpTurn(session, input, () => 1)).toEqual({
      status: 'refused',
      kind: 'turn-not-active',
      expectedTurnId: OPEN_TURN
    })
    expect(session.turns.dispatch).not.toHaveBeenCalled()
  })

  it('refuses without writing when the running turn is not the named one', async () => {
    const session = sessionStub({ running: true, openTurnId: 'turn-other' })

    expect(await steerExpectedAcpTurn(session, input, () => 1)).toEqual({
      status: 'refused',
      kind: 'turn-not-active',
      expectedTurnId: OPEN_TURN
    })
    expect(session.turns.dispatch).not.toHaveBeenCalled()
  })
})
