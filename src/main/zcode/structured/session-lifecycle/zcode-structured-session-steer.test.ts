import { describe, expect, it, vi } from 'vitest'
import { steerExpectedZcodeTurn } from './zcode-structured-session-steer'
import type { ZcodeStructuredSession } from './zcode-structured-session'

const OPEN_TURN = 'turn-open-1'
const body = {
  kind: 'message' as const,
  role: 'user' as const,
  blocks: [{ type: 'text' as const, text: 'change course' }]
}

function sessionStub(options: { openTurnId: string | null }): ZcodeStructuredSession {
  const dispatch = vi.fn(() => ({ state: 'admitted' as const }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub touches only lane/turns/dispatch facts.
  return {
    lane: { openTurnId: options.openTurnId },
    turns: { dispatch },
    dispatchPending: false,
    dispatch
  } as unknown as ZcodeStructuredSession & { turns: { dispatch: typeof dispatch } }
}

const input = {
  sessionId: 'session-1',
  clientMessageId: 'client-1',
  body,
  expectedTurnId: OPEN_TURN
}

describe('targeted delivery for ZCode', () => {
  it('sends into the named open turn and reports it delivered', async () => {
    const session = sessionStub({ openTurnId: OPEN_TURN })

    expect(await steerExpectedZcodeTurn(session, input)).toEqual({
      status: 'delivered',
      turnId: OPEN_TURN,
      via: 'steer'
    })
    expect(session.turns.dispatch).toHaveBeenCalledWith({
      clientMessageId: 'client-1',
      text: 'change course'
    })
    expect(session.dispatchPending).toBe(false)
  })

  it('refuses without writing when the lane has a different open turn', async () => {
    const session = sessionStub({ openTurnId: 'turn-other' })

    expect(await steerExpectedZcodeTurn(session, input)).toEqual({
      status: 'refused',
      kind: 'turn-not-active',
      expectedTurnId: OPEN_TURN
    })
    expect(session.turns.dispatch).not.toHaveBeenCalled()
  })

  it('refuses without writing when no turn is open', async () => {
    const session = sessionStub({ openTurnId: null })

    expect(await steerExpectedZcodeTurn(session, input)).toEqual({
      status: 'refused',
      kind: 'turn-not-active',
      expectedTurnId: OPEN_TURN
    })
    expect(session.turns.dispatch).not.toHaveBeenCalled()
  })
})
