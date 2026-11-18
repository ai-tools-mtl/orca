import { describe, expect, it, vi } from 'vitest'
import type { ClaudeSession } from './claude-structured-session-state'

const sentPriority: (true | undefined)[] = []

vi.mock('./dispatch/claude-structured-dispatch', () => ({
  dispatchClaudeTurn: vi.fn(
    async (
      _session: ClaudeSession,
      _input: unknown,
      beforeDispatch?: () => Promise<{ steers: boolean }>
    ) => {
      const forced = await beforeDispatch?.()
      sentPriority.push(forced?.steers === true ? true : undefined)
      return { state: 'admitted' }
    }
  )
}))

const { steerExpectedClaudeTurn } = await import('./claude-structured-expected-steer')

const OPEN_TURN = 'turn-open-1'
const input = {
  sessionId: 'session-1',
  clientMessageId: 'client-1',
  body: {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text: 'change course' }]
  },
  expectedTurnId: OPEN_TURN
}

function sessionWith(translator: {
  openTurnHasInputWork: boolean
  currentTurnId: string | null
}): ClaudeSession {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub reads only these translator facts.
  return { translator } as unknown as ClaudeSession
}

describe('targeted delivery for Claude', () => {
  it('steers the named open turn by forcing the priority send', async () => {
    sentPriority.length = 0
    expect(
      await steerExpectedClaudeTurn(
        sessionWith({ openTurnHasInputWork: true, currentTurnId: OPEN_TURN }),
        input
      )
    ).toEqual({ status: 'delivered', turnId: OPEN_TURN, via: 'steer' })
    expect(sentPriority).toEqual([true])
  })

  it('refuses without writing when the running turn is not the named one', async () => {
    sentPriority.length = 0
    expect(
      await steerExpectedClaudeTurn(
        sessionWith({ openTurnHasInputWork: true, currentTurnId: 'turn-other' }),
        input
      )
    ).toEqual({ status: 'refused', kind: 'turn-not-active', expectedTurnId: OPEN_TURN })
    expect(sentPriority).toEqual([])
  })

  it('refuses without writing when no turn carries input work', async () => {
    sentPriority.length = 0
    expect(
      await steerExpectedClaudeTurn(
        sessionWith({ openTurnHasInputWork: false, currentTurnId: OPEN_TURN }),
        input
      )
    ).toEqual({ status: 'refused', kind: 'turn-not-active', expectedTurnId: OPEN_TURN })
    expect(sentPriority).toEqual([])
  })
})
